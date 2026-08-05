// ============================================================================
// MEAL EVENT REPOSITORY / SERVICE
// ============================================================================
// Transactional, idempotent persistence for the append-only food-tracking
// model. One meal_event root + version header + ordered items + raw evidence
// + media metadata + provider results + canonical consensus + optional sync
// journal are written in ONE database transaction.
//
// Invariants:
// - Creation is idempotent on (user_id, idempotency_key): a retry returns the
//   original aggregate and never duplicates child rows. Resolution uses the
//   unique constraint (INSERT ... ON CONFLICT DO NOTHING), never an unsafe
//   check-then-insert.
// - Corrections are insert-only child rows plus one atomic root pointer
//   update; historical versions are never updated.
// - A failed provider/sync call never rolls back the local event: provider
//   failures are stored as failed/unavailable result rows.
// - The sync journal is written inside the same transaction, BEFORE any
//   external adapter would run. This slice ships no real external writer.
// - Media byte ordering: callers stage/write/verify bytes via
//   src/media-store.ts FIRST, then pass the returned metadata here; on DB
//   failure the caller deletes staged bytes. This module never touches bytes.

import type { Pool, PoolClient } from "pg";
import { isGeneratedStorageKey } from "./media-store.js";
import { withTransaction } from "./db.js";
import { computeConsensus } from "./meal-consensus.js";
import {
    INPUT_PRECEDENCE,
    NUTRIENT_FIELDS,
    deriveCorrectionFingerprint,
    deriveCreateFingerprint,
    assertJournalTransition,
    resolveConsumedAt,
    validateCreateMealEventCommand,
    type CreateMealEventCommand,
    type CorrectMealEventCommand,
    type Nutrients,
    type SyncJournalState,
} from "./meal-types.js";

export class MealEventValidationError extends Error {
    constructor(public readonly issues: string[]) {
        super(`invalid meal event command: ${issues.join("; ")}`);
        this.name = "MealEventValidationError";
    }
}

export interface CreateMealEventResult {
    event_id: string;
    version: number;
    deduplicated: boolean;
    provenance_status: ProvenanceStatus;
    fingerprint: string | null;
    canonical: ReturnType<typeof computeConsensus> | null;
}

export type ProvenanceStatus = "ready" | "pending" | "unavailable" | "missing";

/** Read the just-persisted aggregate while the write transaction still owns its locks. */
export async function readPersistedWriteStatus(
    client: PoolClient,
    eventId: string,
    version: number,
): Promise<{
    provenance_status: ProvenanceStatus;
    fingerprint: string | null;
    canonical: ReturnType<typeof computeConsensus>;
    item_canonicals: Array<
        ReturnType<typeof computeConsensus> & { ordinal: number }
    >;
    compatibility: boolean;
}> {
    // PoolClient does not support concurrent queries. More importantly, this
    // readback must happen on the transaction client in statement order so it
    // observes the writes made by the current transaction before COMMIT.
    const versionResult = await client.query(
        `SELECT calculation_bundle_fingerprint FROM meal_event_versions
     WHERE event_id = $1 AND version = $2`,
        [eventId, version],
    );
    const providersResult = await client.query(
        `SELECT provider, status, source_id, request_fingerprint,
                algorithm_version, raw_payload, provenance, basis, units
           FROM meal_event_nutrition_results
          WHERE event_id = $1 AND version = $2 AND ordinal IS NULL`,
        [eventId, version],
    );
    // All canonical rows for the version: the event scope (ordinal IS NULL)
    // plus one row per item scope.
    const canonicalResult = await client.query(
        `SELECT ordinal, status, consensus_status, ${NUTRIENT_FIELDS.join(", ")},
                eligible_providers, outlier_providers, threshold_percent,
                policy_version, source_result_ids, audit_evidence,
                algorithm_version
           FROM meal_event_canonical_results
          WHERE event_id = $1 AND version = $2`,
        [eventId, version],
    );
    // Item scopes that produced at least one succeeded provider row must each
    // have a persisted canonical row; fail closed otherwise.
    const itemScopesResult = await client.query(
        `SELECT DISTINCT ordinal FROM meal_event_nutrition_results
          WHERE event_id = $1 AND version = $2
            AND ordinal IS NOT NULL AND status = 'succeeded'`,
        [eventId, version],
    );
    const v = versionResult.rows[0];
    const eventRow = canonicalResult.rows.find((row) => row.ordinal == null);
    if (!v || !eventRow)
        throw new Error("persisted aggregate readback missing");
    const itemRows = canonicalResult.rows
        .filter((row) => typeof row.ordinal === "number")
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    for (const scopeRow of itemScopesResult.rows) {
        const ordinal = Number(scopeRow.ordinal);
        if (!itemRows.some((row) => Number(row.ordinal) === ordinal))
            throw new Error("persisted aggregate readback missing");
    }
    const mapCanonicalRow = (
        row: typeof eventRow,
    ): ReturnType<typeof computeConsensus> =>
        ({
            status: row.status,
            consensus_status: row.consensus_status,
            nutrients: Object.fromEntries(
                NUTRIENT_FIELDS.map((field) => [
                    field,
                    row[field] === null ? null : Number(row[field]),
                ]),
            ),
            per_nutrient: {},
            eligible_providers: row.eligible_providers,
            outlier_providers: row.outlier_providers,
            threshold_percent: Number(row.threshold_percent),
            policy_version: row.policy_version,
            source_result_ids: row.source_result_ids,
            audit_evidence: row.audit_evidence,
            algorithm_version: row.algorithm_version,
        }) as unknown as ReturnType<typeof computeConsensus>;
    const c = eventRow;
    const canonical = mapCanonicalRow(c);
    const providers = providersResult.rows;
    const complete =
        providers.length === 3 &&
        new Set(providers.map((r) => r.provider)).size === 3 &&
        providers.every(
            (r) =>
                r.status === "succeeded" &&
                r.source_id &&
                r.request_fingerprint &&
                r.algorithm_version &&
                r.raw_payload !== null &&
                typeof r.raw_payload === "object" &&
                Object.keys(r.raw_payload).length > 0 &&
                r.provenance !== null &&
                typeof r.provenance === "object" &&
                Object.keys(r.provenance).length > 0 &&
                r.provenance.compatibility !== true &&
                r.basis &&
                r.units,
        );
    const canonicalComplete =
        c.status === "ready" &&
        c.consensus_status !== "insufficient_data" &&
        Boolean(c.algorithm_version) &&
        Array.isArray(c.source_result_ids) &&
        c.source_result_ids.length === providers.length &&
        c.audit_evidence !== null &&
        typeof c.audit_evidence === "object" &&
        Object.keys(c.audit_evidence).length > 0 &&
        c.audit_evidence.compatibility !== true;
    return {
        provenance_status: deriveProvenanceStatus({
            bundleFingerprint: v.calculation_bundle_fingerprint ?? null,
            providerCount: providers.length,
            canonicalPresent: true,
            canonicalConsensus: canonical.consensus_status,
            providerEvidenceComplete: complete,
            canonicalEvidenceComplete: canonicalComplete,
            hasUnavailableProvider: providers.some(
                (r) => r.status === "failed" || r.status === "unavailable",
            ),
        }),
        fingerprint: v.calculation_bundle_fingerprint ?? null,
        canonical,
        item_canonicals: itemRows.map((row) => ({
            ...mapCanonicalRow(row),
            ordinal: Number(row.ordinal),
        })),
        compatibility: v.calculation_bundle_fingerprint == null,
    };
}

export function deriveProvenanceStatus(args: {
    bundleFingerprint: string | null;
    providerCount: number;
    canonicalPresent: boolean;
    canonicalConsensus: string | null;
    providerEvidenceComplete: boolean;
    canonicalEvidenceComplete: boolean;
    hasUnavailableProvider: boolean;
}): ProvenanceStatus {
    if (!args.providerCount && !args.canonicalPresent) return "missing";
    if (args.hasUnavailableProvider) return "unavailable";
    if (!args.bundleFingerprint) return "pending";
    if (
        !args.canonicalPresent ||
        args.canonicalConsensus === "insufficient_data" ||
        args.providerEvidenceComplete === false ||
        args.canonicalEvidenceComplete === false
    )
        return args.canonicalConsensus === "insufficient_data"
            ? "unavailable"
            : "pending";
    return "ready";
}

const EXPECTED_PROVIDERS = new Set(["nutrition-local", "own", "myfitnesspal"]);

/** One readiness policy shared by repository writes and user-scoped readback. */
export function deriveAggregateProvenance(aggregate: MealEventAggregate): {
    provenance_status: ProvenanceStatus;
    compatibility: boolean;
} {
    const eventResults = aggregate.provider_results.filter(
        (r) => r.ordinal === null,
    );
    const providerNames = new Set(eventResults.map((r) => r.provider));
    const providerEvidenceComplete =
        eventResults.length === 3 &&
        providerNames.size === 3 &&
        [...EXPECTED_PROVIDERS].every((p) => providerNames.has(p)) &&
        eventResults.every(
            (r) =>
                r.status === "succeeded" &&
                Boolean(r.id) &&
                Boolean(r.source_id) &&
                Boolean(r.request_fingerprint) &&
                Boolean(r.algorithm_version) &&
                r.raw_payload !== null &&
                typeof r.raw_payload === "object" &&
                Object.keys(r.raw_payload).length > 0 &&
                r.provenance !== null &&
                typeof r.provenance === "object" &&
                Object.keys(r.provenance).length > 0 &&
                r.provenance.compatibility !== true &&
                Boolean(r.basis) &&
                Boolean(r.units),
        );
    const canonical = aggregate.canonical;
    const canonicalEvidenceComplete =
        canonical !== null &&
        canonical.status === "ready" &&
        canonical.consensus_status !== "insufficient_data" &&
        Boolean(canonical.algorithm_version) &&
        Array.isArray(canonical.source_result_ids) &&
        canonical.source_result_ids.length === 3 &&
        canonical.source_result_ids.every((id) =>
            eventResults.some((r) => r.id === id),
        ) &&
        canonical.audit_evidence !== null &&
        typeof canonical.audit_evidence === "object" &&
        Object.keys(canonical.audit_evidence).length > 0 &&
        canonical.audit_evidence.compatibility !== true &&
        (canonical.audit_evidence.fingerprint ===
            aggregate.version.calculation_bundle_fingerprint ||
            aggregate.version.calculation_bundle_fingerprint === null);
    return {
        provenance_status: deriveProvenanceStatus({
            bundleFingerprint: aggregate.version.calculation_bundle_fingerprint,
            providerCount: eventResults.length,
            canonicalPresent: canonical !== null,
            canonicalConsensus: canonical?.consensus_status ?? null,
            providerEvidenceComplete,
            canonicalEvidenceComplete,
            hasUnavailableProvider: eventResults.some(
                (r) => r.status === "failed" || r.status === "unavailable",
            ),
        }),
        compatibility:
            aggregate.version.calculation_bundle_fingerprint === null,
    };
}

export function deriveWriteProvenance(
    providerResults: CreateMealEventCommand["provider_results"],
    canonical: ReturnType<typeof computeConsensus>,
    fingerprint: string | null,
): {
    provenance_status: ProvenanceStatus;
    fingerprint: string | null;
    canonical: ReturnType<typeof computeConsensus>;
} {
    const providerEvidenceComplete =
        providerResults.length === 3 &&
        new Set(providerResults.map((r) => r.provider)).size === 3 &&
        providerResults.every(
            (r) =>
                r.status === "succeeded" &&
                Boolean(r.request_fingerprint) &&
                Boolean(r.request_fingerprint) &&
                Boolean(r.algorithm_version) &&
                Boolean(r.raw_payload) &&
                Boolean(r.basis) &&
                Boolean(r.units),
        );
    const canonicalEvidenceComplete =
        providerEvidenceComplete &&
        canonical.status === "ready" &&
        canonical.consensus_status !== "insufficient_data";
    return {
        provenance_status: deriveProvenanceStatus({
            bundleFingerprint: fingerprint,
            providerCount: providerResults.length,
            canonicalPresent: true,
            canonicalConsensus: canonical.consensus_status,
            providerEvidenceComplete,
            canonicalEvidenceComplete,
            hasUnavailableProvider: providerResults.some(
                (r) => r.status === "failed" || r.status === "unavailable",
            ),
        }),
        fingerprint,
        canonical,
    };
}

export interface MealEventCanonical {
    status: string;
    consensus_status: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;
    alcohol_g: number | null;
    eligible_providers: string[] | null;
    outlier_providers: string[] | null;
    threshold_percent: number;
    policy_version: string;
    source_result_ids: string[] | null;
    audit_evidence: Record<string, unknown> | null;
    algorithm_version: string | null;
}

export interface MealEventAggregate {
    event: {
        id: string;
        user_id: string;
        reported_at: string;
        consumed_at: string;
        meal_type: string | null;
        status: string;
        current_version: number;
        idempotency_key: string;
        external_write_authorized: boolean;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
    };
    version: {
        event_id: string;
        version: number;
        correction_idempotency_key: string | null;
        correction_reason: string | null;
        raw_text_snapshot: string | null;
        parser_policy_version: string;
        created_by: string;
        created_at: string;
        calculation_bundle_fingerprint: string | null;
    };
    items: {
        ordinal: number;
        raw_item_text: string;
        normalized_name: string | null;
        quantity: number | null;
        portion_value: number | null;
        portion_unit: string | null;
        notes: string | null;
    }[];
    inputs: {
        id: string;
        source_kind: string;
        content: string;
        content_hash: string;
        precedence: number;
        metadata: Record<string, unknown>;
    }[];
    media: {
        id: string;
        kind: string;
        storage_key: string;
        mime_type: string;
        byte_size: number;
        sha256: string;
    }[];
    provider_results: {
        id: string;
        ordinal: number | null;
        provider: string;
        status: string;
        request_fingerprint: string;
        algorithm_version: string;
        error_code: string | null;
        error_message: string | null;
        source_id: string | null;
        raw_payload: Record<string, unknown>;
        provenance: Record<string, unknown> | null;
        basis: string | null;
        units: string | null;
        nutrients: Partial<Nutrients>;
    }[];
    canonical: MealEventCanonical | null;
    item_canonicals: Array<MealEventCanonical & { ordinal: number }>;
    journal: {
        id: string;
        system: string;
        operation: string;
        request_fingerprint: string;
        authorization_source: string;
        state: SyncJournalState;
        attempts: number;
        external_id: string | null;
        last_error: string | null;
    }[];
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function ts(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

function numOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function isUniqueViolation(err: unknown, constraintFragment: string): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "23505" &&
        String((err as { constraint?: string }).constraint ?? "").includes(
            constraintFragment,
        )
    );
}

function sha256Hex(content: string): string {
    return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

const NUTRIENT_COLUMNS = NUTRIENT_FIELDS.map((f) => `${f}`).join(", ");

// The legacy adapter has no caller-owned provider source.  The column is
// required by the durable schema, so this fixed identifier explicitly marks
// the row as compatibility data instead of pretending the request fingerprint
// was external evidence.
const LEGACY_COMPATIBILITY_SOURCE_ID = "compatibility:legacy";

function nutrientValues(
    nutrients: Partial<Nutrients> | undefined,
): (number | null)[] {
    return NUTRIENT_FIELDS.map((f) => nutrients?.[f] ?? null);
}

// ---------------------------------------------------------------------------
// INSERT PATH (shared by create and correction)
// ---------------------------------------------------------------------------

async function insertVersionChildren(
    client: PoolClient,
    args: {
        eventId: string;
        version: number;
        items: CreateMealEventCommand["items"];
        inputs: CreateMealEventCommand["inputs"];
        media: CreateMealEventCommand["media"];
        providerResults: CreateMealEventCommand["provider_results"];
    },
): Promise<ReturnType<typeof computeConsensus>> {
    const { eventId, version, items, inputs, media, providerResults } = args;

    for (const item of items) {
        await client.query(
            `INSERT INTO meal_event_items
                (event_id, version, ordinal, raw_item_text, normalized_name,
                 quantity, portion_value, portion_unit, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                eventId,
                version,
                item.ordinal,
                item.raw_item_text,
                item.normalized_name ?? null,
                item.quantity ?? null,
                item.portion_value ?? null,
                item.portion_unit ?? null,
                item.notes ?? null,
            ],
        );
    }

    for (const input of inputs) {
        await client.query(
            `INSERT INTO meal_event_inputs
                (event_id, version, source_kind, content, content_hash,
                 precedence, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                eventId,
                version,
                input.source_kind,
                input.content,
                sha256Hex(input.content),
                INPUT_PRECEDENCE[input.source_kind],
                JSON.stringify(input.metadata ?? {}),
            ],
        );
    }

    for (const m of media) {
        await client.query(
            `INSERT INTO meal_event_media
                (event_id, version, kind, storage_key, mime_type, byte_size,
                 sha256, duration_ms, width, height)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                eventId,
                version,
                m.kind,
                m.storage_key,
                m.mime_type,
                m.byte_size,
                m.sha256,
                m.duration_ms ?? null,
                m.width ?? null,
                m.height ?? null,
            ],
        );
    }

    const succeededIdsByScope = new Map<number | null, string[]>();
    for (const r of providerResults) {
        const scope = r.ordinal ?? null;
        const compatibility = r.source_id == null;
        const sourceId = r.source_id ?? LEGACY_COMPATIBILITY_SOURCE_ID;
        const { rows } = await client.query(
            `INSERT INTO meal_event_nutrition_results
                (event_id, version, ordinal, provider, source_id, status,
                 request_fingerprint, algorithm_version, raw_payload, provenance,
                 basis, units, ${NUTRIENT_COLUMNS}, error_code, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     $13, $14, $15, $16, $17, $18, $19, $20, $21)
             RETURNING id`,
            [
                eventId,
                version,
                scope,
                r.provider,
                sourceId,
                r.status,
                r.request_fingerprint,
                r.algorithm_version,
                r.raw_payload == null
                    ? JSON.stringify({ compatibility: true })
                    : JSON.stringify(r.raw_payload),
                compatibility
                    ? JSON.stringify({ compatibility: true })
                    : r.provenance == null
                      ? JSON.stringify({ compatibility: true })
                      : JSON.stringify(r.provenance),
                r.basis ?? null,
                r.units ?? null,
                ...nutrientValues(r.nutrients),
                r.error_code ?? null,
                r.error_message ?? null,
            ],
        );
        if (r.status === "succeeded") {
            const ids = succeededIdsByScope.get(scope) ?? [];
            ids.push(rows[0]!.id as string);
            succeededIdsByScope.set(scope, ids);
        }
    }

    // Canonical consensus per scope: the event aggregate (ordinal IS NULL)
    // plus one row per item scope present in the provider results. Missing
    // values stay NULL; consensus never reads them as zero.
    const scopes = new Map<number | null, typeof providerResults>();
    for (const r of providerResults) {
        const scope = r.ordinal ?? null;
        const group = scopes.get(scope) ?? [];
        group.push(r);
        scopes.set(scope, group);
    }
    if (!scopes.has(null)) scopes.set(null, []);

    let eventCanonical: ReturnType<typeof computeConsensus> | null = null;
    for (const [scope, results] of scopes) {
        const consensus = computeConsensus(
            results.map((r) => ({
                provider: r.provider,
                status: r.status,
                nutrients: r.nutrients,
            })),
        );
        if (scope === null) eventCanonical = consensus;
        await client.query(
            `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status,
                 ${NUTRIENT_COLUMNS},
                 eligible_providers, outlier_providers, threshold_percent,
                 policy_version, source_result_ids, audit_evidence, algorithm_version)
             VALUES ($1, $2, $3, $4, $5,
                     $6, $7, $8, $9, $10, $11, $12,
                     $13, $14, $15, $16, $17, $18, $19)`,
            [
                eventId,
                version,
                scope,
                consensus.status,
                consensus.consensus_status,
                ...NUTRIENT_FIELDS.map((f) => consensus.nutrients[f]),
                consensus.eligible_providers,
                consensus.outlier_providers,
                consensus.threshold_percent,
                consensus.policy_version,
                compatibilityForScope(providerResults)
                    ? []
                    : succeededIdsByScope.get(scope),
                compatibilityForScope(providerResults)
                    ? JSON.stringify({ compatibility: true })
                    : JSON.stringify({
                          source_result_ids: succeededIdsByScope.get(scope),
                          policy_version: consensus.policy_version,
                      }),
                compatibilityForScope(providerResults)
                    ? null
                    : consensus.policy_version,
            ],
        );
    }
    return eventCanonical ?? computeConsensus([]);
}

function compatibilityForScope(
    results: CreateMealEventCommand["provider_results"],
): boolean {
    return (
        results.length === 0 ||
        results.every((result) => result.source_id == null)
    );
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

export async function createMealEvent(
    pool: Pool,
    command: CreateMealEventCommand,
    transactionClient?: PoolClient,
): Promise<CreateMealEventResult> {
    const issues = validateCreateMealEventCommand(command);
    if (issues.length > 0) throw new MealEventValidationError(issues);

    const reportedAt = resolveConsumedAt(command.reported_at, null);
    const consumedAt = resolveConsumedAt(
        command.reported_at,
        command.consumed_at,
    );

    try {
        const persist = async (
            client: PoolClient,
        ): Promise<CreateMealEventResult> => {
            const eventId = crypto.randomUUID();
            const { rows } = await client.query(
                `INSERT INTO meal_events
                    (id, user_id, reported_at, consumed_at, meal_type,
                     idempotency_key, external_write_authorized)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (user_id, idempotency_key) DO NOTHING
                 RETURNING id`,
                [
                    eventId,
                    command.user_id,
                    reportedAt.toISOString(),
                    consumedAt.toISOString(),
                    command.meal_type ?? null,
                    command.idempotency_key,
                    command.external_write_authorized ?? false,
                ],
            );

            if (rows.length === 0) {
                const existing = await client.query(
                    `SELECT id, current_version FROM meal_events
                     WHERE user_id = $1 AND idempotency_key = $2
                     FOR UPDATE`,
                    [command.user_id, command.idempotency_key],
                );
                const existingEvent = existing.rows[0]!;
                if (command.external_write_authorized === true) {
                    await client.query(
                        `UPDATE meal_events
                         SET external_write_authorized = true, updated_at = now()
                         WHERE id = $1 AND external_write_authorized = false`,
                        [existingEvent.id],
                    );
                    await client.query(
                        `INSERT INTO meal_event_sync_journal
                            (event_id, version, system, operation,
                             request_fingerprint, authorization_source, state)
                         VALUES ($1, $2, 'myfitnesspal', 'create_meal_event',
                                 $3, 'explicit_add_intent', 'pending')
                         ON CONFLICT (system, operation, request_fingerprint)
                         DO NOTHING`,
                        [
                            existingEvent.id,
                            existingEvent.current_version,
                            deriveCreateFingerprint(command),
                        ],
                    );
                }
                const persisted = await readPersistedWriteStatus(
                    client,
                    existingEvent.id as string,
                    existingEvent.current_version as number,
                );
                return {
                    event_id: existingEvent.id as string,
                    version: existingEvent.current_version as number,
                    deduplicated: true,
                    ...persisted,
                };
            }

            if (command.enforce_media_identity) {
                for (const media of command.media) {
                    if (
                        !isGeneratedStorageKey({
                            storage_key: media.storage_key,
                            event_id: eventId,
                            version: 1,
                            kind: media.kind,
                            sha256: media.sha256,
                        })
                    ) {
                        throw new MealEventValidationError([
                            `media storage_key is not generated for event/version/content: ${media.storage_key}`,
                        ]);
                    }
                }
            }
            await client.query(
                `INSERT INTO meal_event_versions
                    (event_id, version, parser_policy_version, created_by)
                 VALUES ($1, 1, $2, $3)`,
                [eventId, command.parser_policy_version, command.created_by],
            );
            const canonical = await insertVersionChildren(client, {
                eventId,
                version: 1,
                items: command.items,
                inputs: command.inputs,
                media: command.media,
                providerResults: command.provider_results,
            });

            if (command.external_write_authorized) {
                // "добавь" authorizes an external write and creates a pending
                // journal row. It is NOT proof of delivery — this slice never
                // calls MyFitnessPal; the row stays pending.
                await client.query(
                    `INSERT INTO meal_event_sync_journal
                        (event_id, version, system, operation,
                         request_fingerprint, authorization_source, state)
                     VALUES ($1, 1, 'myfitnesspal', 'create_meal_event',
                             $2, 'explicit_add_intent', 'pending')`,
                    [eventId, deriveCreateFingerprint(command)],
                );
            }

            const persisted = await readPersistedWriteStatus(
                client,
                eventId,
                1,
            );
            return {
                event_id: eventId,
                version: 1,
                deduplicated: false,
                ...persisted,
            };
        };
        return await (transactionClient
            ? persist(transactionClient)
            : withTransaction(pool, persist));
    } catch (err) {
        if (isUniqueViolation(err, "uniq_meal_events_user_idem")) {
            // Concurrent same-key create lost the race before ON CONFLICT
            // could resolve it; read back the winner.
            const { rows } = await pool.query(
                `SELECT id, current_version FROM meal_events
                 WHERE user_id = $1 AND idempotency_key = $2`,
                [command.user_id, command.idempotency_key],
            );
            if (rows.length > 0) {
                return await withTransaction(pool, async (client) => {
                    const { rows: locked } = await client.query(
                        `SELECT id, current_version FROM meal_events
                         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                        [rows[0]!.id, command.user_id],
                    );
                    if (!locked[0])
                        throw new Error(
                            "concurrent create winner readback missing",
                        );
                    if (command.external_write_authorized === true) {
                        await client.query(
                            `UPDATE meal_events SET external_write_authorized = true,
                             updated_at = now() WHERE id = $1`,
                            [locked[0].id],
                        );
                        await client.query(
                            `INSERT INTO meal_event_sync_journal
                                (event_id, version, system, operation,
                                 request_fingerprint, authorization_source, state)
                             VALUES ($1, $2, 'myfitnesspal', 'create_meal_event',
                                     $3, 'explicit_add_intent', 'pending')
                             ON CONFLICT (system, operation, request_fingerprint)
                             DO NOTHING`,
                            [
                                locked[0].id,
                                locked[0].current_version,
                                deriveCreateFingerprint(command),
                            ],
                        );
                    }
                    const persisted = await readPersistedWriteStatus(
                        client,
                        locked[0].id as string,
                        Number(locked[0].current_version),
                    );
                    return {
                        event_id: locked[0].id as string,
                        version: Number(locked[0].current_version),
                        deduplicated: true,
                        ...persisted,
                    };
                });
            }
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// CORRECT (immutable versioning: insert-only children + root pointer update)
// ---------------------------------------------------------------------------

export async function correctMealEvent(
    pool: Pool,
    command: CorrectMealEventCommand,
): Promise<CreateMealEventResult> {
    if (command.items.length === 0) {
        throw new MealEventValidationError(["items must not be empty"]);
    }

    try {
        return await withTransaction(pool, async (client) => {
            // Serialize corrections for this event and read the authoritative
            // current version inside the transaction.
            const { rows: roots } = await client.query(
                `SELECT id, current_version FROM meal_events
                 WHERE id = $1 AND user_id = $2 AND status = 'active'
                 FOR UPDATE`,
                [command.event_id, command.user_id],
            );
            if (roots.length === 0) {
                throw new MealEventValidationError([
                    `event not found or not active: ${command.event_id}`,
                ]);
            }
            const nextVersion = (roots[0]!.current_version as number) + 1;

            const { rows } = await client.query(
                `INSERT INTO meal_event_versions
                    (event_id, version, correction_idempotency_key,
                     correction_reason, raw_text_snapshot,
                     parser_policy_version, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (event_id, correction_idempotency_key)
                     WHERE correction_idempotency_key IS NOT NULL
                 DO NOTHING
                 RETURNING version`,
                [
                    command.event_id,
                    nextVersion,
                    command.correction_idempotency_key,
                    command.correction_reason ?? null,
                    command.raw_text_snapshot ?? null,
                    command.parser_policy_version,
                    command.created_by,
                ],
            );

            if (rows.length === 0) {
                // Repeated correction fingerprint: return the version the
                // original correction created; do not advance the pointer.
                const existing = await client.query(
                    `SELECT version FROM meal_event_versions
                     WHERE event_id = $1 AND correction_idempotency_key = $2`,
                    [command.event_id, command.correction_idempotency_key],
                );
                const persisted = await readPersistedWriteStatus(
                    client,
                    command.event_id,
                    Number(existing.rows[0]!.version),
                );
                return {
                    event_id: command.event_id,
                    version: Number(existing.rows[0]!.version),
                    deduplicated: true,
                    ...persisted,
                };
            }

            const canonical = await insertVersionChildren(client, {
                eventId: command.event_id,
                version: nextVersion,
                items: command.items,
                inputs: command.inputs,
                media: command.media,
                providerResults: command.provider_results,
            });
            // One atomic root pointer update; historical versions untouched.
            await client.query(
                `UPDATE meal_events
                 SET current_version = $2,
                     consumed_at = COALESCE($3, consumed_at),
                     meal_type = CASE WHEN $4::boolean THEN $5 ELSE meal_type END,
                     updated_at = now()
                 WHERE id = $1 AND user_id = $6`,
                [
                    command.event_id,
                    nextVersion,
                    command.consumed_at == null
                        ? null
                        : resolveConsumedAt(command.consumed_at, null),
                    command.meal_type !== undefined,
                    command.meal_type ?? null,
                    command.user_id,
                ],
            );
            const persisted = await readPersistedWriteStatus(
                client,
                command.event_id,
                nextVersion,
            );
            return {
                event_id: command.event_id,
                version: nextVersion,
                deduplicated: false,
                ...persisted,
            };
        });
    } catch (err) {
        if (isUniqueViolation(err, "uniq_meal_event_versions_correction")) {
            const { rows } = await pool.query(
                `SELECT version FROM meal_event_versions
                 WHERE event_id = $1 AND correction_idempotency_key = $2`,
                [command.event_id, command.correction_idempotency_key],
            );
            if (rows.length > 0) {
                return await withTransaction(pool, async (client) => {
                    const persisted = await readPersistedWriteStatus(
                        client,
                        command.event_id,
                        Number(rows[0]!.version),
                    );
                    return {
                        event_id: command.event_id,
                        version: Number(rows[0]!.version),
                        deduplicated: true,
                        ...persisted,
                    };
                });
            }
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

export async function getMealEvent(
    pool: Pool,
    eventId: string,
    version?: number,
): Promise<MealEventAggregate | null> {
    const { rows: roots } = await pool.query(
        `SELECT * FROM meal_events WHERE id = $1`,
        [eventId],
    );
    if (roots.length === 0) return null;
    const root = roots[0]!;
    const resolvedVersion = version ?? (root.current_version as number);

    const { rows: versions } = await pool.query(
        `SELECT * FROM meal_event_versions WHERE event_id = $1 AND version = $2`,
        [eventId, resolvedVersion],
    );
    if (versions.length === 0) return null;
    const v = versions[0]!;

    const [items, inputs, media, results, canonical, journal] =
        await Promise.all([
            pool.query(
                `SELECT * FROM meal_event_items
                 WHERE event_id = $1 AND version = $2 ORDER BY ordinal`,
                [eventId, resolvedVersion],
            ),
            pool.query(
                `SELECT * FROM meal_event_inputs
                 WHERE event_id = $1 AND version = $2 ORDER BY precedence`,
                [eventId, resolvedVersion],
            ),
            pool.query(
                `SELECT * FROM meal_event_media
                 WHERE event_id = $1 AND version = $2`,
                [eventId, resolvedVersion],
            ),
            pool.query(
                `SELECT * FROM meal_event_nutrition_results
                 WHERE event_id = $1 AND version = $2`,
                [eventId, resolvedVersion],
            ),
            pool.query(
                `SELECT * FROM meal_event_canonical_results
                 WHERE event_id = $1 AND version = $2`,
                [eventId, resolvedVersion],
            ),
            pool.query(
                `SELECT * FROM meal_event_sync_journal
                 WHERE event_id = $1 AND version = $2`,
                [eventId, resolvedVersion],
            ),
        ]);

    const mapCanonicalRow = (row: {
        [key: string]: unknown;
    }): MealEventCanonical => ({
        status: row.status as string,
        consensus_status: row.consensus_status as string,
        calories: numOrNull(row.calories),
        protein_g: numOrNull(row.protein_g),
        carbs_g: numOrNull(row.carbs_g),
        fat_g: numOrNull(row.fat_g),
        fiber_g: numOrNull(row.fiber_g),
        sugar_g: numOrNull(row.sugar_g),
        alcohol_g: numOrNull(row.alcohol_g),
        eligible_providers: row.eligible_providers as string[] | null,
        outlier_providers: row.outlier_providers as string[] | null,
        threshold_percent: Number(row.threshold_percent),
        policy_version: row.policy_version as string,
        source_result_ids: row.source_result_ids as string[] | null,
        audit_evidence: row.audit_evidence as Record<string, unknown> | null,
        algorithm_version: (row.algorithm_version as string | null) ?? null,
    });
    const eventCanonicalRow = canonical.rows.find(
        (row) => row.ordinal === null,
    );
    const itemCanonicalRows = canonical.rows
        .filter((row) => typeof row.ordinal === "number")
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));

    return {
        event: {
            id: root.id as string,
            user_id: root.user_id as string,
            reported_at: ts(root.reported_at),
            consumed_at: ts(root.consumed_at),
            meal_type: (root.meal_type as string | null) ?? null,
            status: root.status as string,
            current_version: root.current_version as number,
            idempotency_key: root.idempotency_key as string,
            external_write_authorized:
                root.external_write_authorized as boolean,
            created_at: ts(root.created_at),
            updated_at: ts(root.updated_at),
            deleted_at: root.deleted_at ? ts(root.deleted_at) : null,
        },
        version: {
            event_id: v.event_id as string,
            version: v.version as number,
            correction_idempotency_key:
                (v.correction_idempotency_key as string | null) ?? null,
            correction_reason: (v.correction_reason as string | null) ?? null,
            raw_text_snapshot: (v.raw_text_snapshot as string | null) ?? null,
            parser_policy_version: v.parser_policy_version as string,
            created_by: v.created_by as string,
            created_at: ts(v.created_at),
            calculation_bundle_fingerprint:
                (v.calculation_bundle_fingerprint as string | null) ?? null,
        },
        items: items.rows.map((r) => ({
            ordinal: r.ordinal as number,
            raw_item_text: r.raw_item_text as string,
            normalized_name: (r.normalized_name as string | null) ?? null,
            quantity: numOrNull(r.quantity),
            portion_value: numOrNull(r.portion_value),
            portion_unit: (r.portion_unit as string | null) ?? null,
            notes: (r.notes as string | null) ?? null,
        })),
        inputs: inputs.rows.map((r) => ({
            id: r.id as string,
            source_kind: r.source_kind as string,
            content: r.content as string,
            content_hash: r.content_hash as string,
            precedence: r.precedence as number,
            metadata: (r.metadata ?? {}) as Record<string, unknown>,
        })),
        media: media.rows.map((r) => ({
            id: r.id as string,
            kind: r.kind as string,
            storage_key: r.storage_key as string,
            mime_type: r.mime_type as string,
            byte_size: Number(r.byte_size),
            sha256: r.sha256 as string,
        })),
        provider_results: results.rows.map((r) => ({
            id: r.id as string,
            ordinal: (r.ordinal as number | null) ?? null,
            provider: r.provider as string,
            status: r.status as string,
            request_fingerprint: r.request_fingerprint as string,
            algorithm_version: r.algorithm_version as string,
            error_code: (r.error_code as string | null) ?? null,
            error_message: (r.error_message as string | null) ?? null,
            source_id: (r.source_id as string | null) ?? null,
            raw_payload: r.raw_payload as Record<string, unknown>,
            provenance: r.provenance as Record<string, unknown> | null,
            basis: (r.basis as string | null) ?? null,
            units: (r.units as string | null) ?? null,
            nutrients: Object.fromEntries(
                NUTRIENT_FIELDS.map((f) => [f, numOrNull(r[f])]),
            ) as Partial<Nutrients>,
        })),
        canonical: eventCanonicalRow
            ? mapCanonicalRow(eventCanonicalRow)
            : null,
        item_canonicals: itemCanonicalRows.map((row) => ({
            ...mapCanonicalRow(row),
            ordinal: Number(row.ordinal),
        })),
        journal: journal.rows.map((r) => ({
            id: r.id as string,
            system: r.system as string,
            operation: r.operation as string,
            request_fingerprint: r.request_fingerprint as string,
            authorization_source: r.authorization_source as string,
            state: r.state as SyncJournalState,
            attempts: r.attempts as number,
            external_id: (r.external_id as string | null) ?? null,
            last_error: (r.last_error as string | null) ?? null,
        })),
    };
}

/** User-scoped aggregate read used by the public provenance boundary. */
export async function getMealEventProvenance(
    pool: Pool,
    userId: string,
    eventId: string,
    version?: number,
): Promise<{
    aggregate: MealEventAggregate;
    provenance_status: ProvenanceStatus;
    compatibility: boolean;
    is_current: boolean;
} | null> {
    const { rows } = await pool.query(
        `SELECT id, current_version, status FROM meal_events
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [eventId, userId],
    );
    if (!rows[0]) return null;
    const selectedVersion = version ?? Number(rows[0].current_version);
    const aggregate = await getMealEvent(pool, eventId, selectedVersion);
    if (!aggregate) return null;
    const derived = deriveAggregateProvenance(aggregate);
    return {
        aggregate,
        provenance_status: derived.provenance_status,
        compatibility: derived.compatibility,
        is_current: selectedVersion === Number(rows[0].current_version),
    };
}

// History: every version header, oldest first.
export async function getMealEventHistory(
    pool: Pool,
    eventId: string,
): Promise<MealEventAggregate["version"][]> {
    const { rows } = await pool.query(
        `SELECT * FROM meal_event_versions WHERE event_id = $1 ORDER BY version`,
        [eventId],
    );
    return rows.map((v) => ({
        event_id: v.event_id as string,
        version: v.version as number,
        correction_idempotency_key:
            (v.correction_idempotency_key as string | null) ?? null,
        correction_reason: (v.correction_reason as string | null) ?? null,
        raw_text_snapshot: (v.raw_text_snapshot as string | null) ?? null,
        parser_policy_version: v.parser_policy_version as string,
        created_by: v.created_by as string,
        created_at: ts(v.created_at),
        calculation_bundle_fingerprint:
            (v.calculation_bundle_fingerprint as string | null) ?? null,
    }));
}

// ---------------------------------------------------------------------------
// SYNC JOURNAL (durable outbox state machine)
// ---------------------------------------------------------------------------
// The journal row is the only claim of an authorized external write. State
// transitions are enforced by the domain state machine (meal-types.ts).
// This slice ships no real external writer: ExternalWriter is an injectable
// seam only, and `nullExternalWriter` makes "not wired" fail loudly instead
// of silently pretending to sync.

export interface ExternalWriter {
    send(args: {
        system: string;
        operation: string;
        request_fingerprint: string;
        payload: unknown;
    }): Promise<{ external_id?: string }>;
}

export const nullExternalWriter: ExternalWriter = {
    send(): Promise<never> {
        return Promise.reject(
            new Error(
                "no external writer configured: this slice never calls " +
                    "MyFitnessPal; journal rows stay pending",
            ),
        );
    },
};

export interface JournalEntry {
    id: string;
    system: string;
    operation: string;
    request_fingerprint: string;
    authorization_source: string;
    state: SyncJournalState;
    attempts: number;
    external_id: string | null;
    last_error: string | null;
}

function journalFromRow(r: Record<string, unknown>): JournalEntry {
    return {
        id: r.id as string,
        system: r.system as string,
        operation: r.operation as string,
        request_fingerprint: r.request_fingerprint as string,
        authorization_source: r.authorization_source as string,
        state: r.state as SyncJournalState,
        attempts: r.attempts as number,
        external_id: (r.external_id as string | null) ?? null,
        last_error: (r.last_error as string | null) ?? null,
    };
}

export async function getJournalEntry(
    pool: Pool,
    system: string,
    operation: string,
    requestFingerprint: string,
): Promise<JournalEntry | null> {
    const { rows } = await pool.query(
        `SELECT * FROM meal_event_sync_journal
         WHERE system = $1 AND operation = $2 AND request_fingerprint = $3`,
        [system, operation, requestFingerprint],
    );
    return rows.length > 0 ? journalFromRow(rows[0]!) : null;
}

async function transitionJournal(
    pool: Pool,
    journalId: string,
    to: SyncJournalState,
    patch: {
        external_id?: string;
        last_error?: string;
        incrementAttempts?: boolean;
    },
): Promise<void> {
    await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT state, attempts FROM meal_event_sync_journal
             WHERE id = $1 FOR UPDATE`,
            [journalId],
        );
        if (rows.length === 0) {
            throw new Error(`sync journal entry not found: ${journalId}`);
        }
        const from = rows[0]!.state as SyncJournalState;
        assertJournalTransition(from, to);
        await client.query(
            `UPDATE meal_event_sync_journal
             SET state = $2,
                 attempts = attempts + $3,
                 external_id = coalesce($4, external_id),
                 last_error = $5,
                 updated_at = now()
             WHERE id = $1`,
            [
                journalId,
                to,
                patch.incrementAttempts ? 1 : 0,
                patch.external_id ?? null,
                patch.last_error ?? null,
            ],
        );
    });
}

export async function markJournalInFlight(
    pool: Pool,
    journalId: string,
): Promise<void> {
    await transitionJournal(pool, journalId, "in_flight", {});
}

export async function recordJournalSuccess(
    pool: Pool,
    journalId: string,
    externalId?: string,
): Promise<void> {
    await transitionJournal(pool, journalId, "succeeded", {
        external_id: externalId,
        incrementAttempts: true,
    });
}

export async function recordJournalFailure(
    pool: Pool,
    journalId: string,
    error: string,
    options: { deadLetter?: boolean } = {},
): Promise<void> {
    await transitionJournal(
        pool,
        journalId,
        options.deadLetter ? "dead_letter" : "failed",
        { last_error: error, incrementAttempts: true },
    );
}

// Delivers one journal entry through the injected external writer. The state
// machine does the talking: pending/failed -> in_flight happens BEFORE the
// writer runs, success records the external id, and a throwing writer leaves
// the row failed with the error — local event/canonical rows are never
// touched. Retrying a failed entry is idempotent (same row, attempts
// increment); terminal rows (succeeded/dead_letter) refuse delivery instead
// of re-sending. This slice ships no real writer; callers inject a fake.
export async function deliverJournalEntry(
    pool: Pool,
    journalId: string,
    writer: ExternalWriter,
    payload: unknown,
): Promise<void> {
    const { rows } = await pool.query(
        `SELECT system, operation, request_fingerprint
         FROM meal_event_sync_journal WHERE id = $1`,
        [journalId],
    );
    if (rows.length === 0) {
        throw new Error(`sync journal entry not found: ${journalId}`);
    }
    const entry = rows[0]!;

    await markJournalInFlight(pool, journalId);
    try {
        const result = await writer.send({
            system: entry.system as string,
            operation: entry.operation as string,
            request_fingerprint: entry.request_fingerprint as string,
            payload,
        });
        await recordJournalSuccess(pool, journalId, result.external_id);
    } catch (err) {
        await recordJournalFailure(
            pool,
            journalId,
            err instanceof Error ? err.message : String(err),
        );
        throw err;
    }
}

// ---------------------------------------------------------------------------
// ORDINARY DELETE (tombstone)
// ---------------------------------------------------------------------------
// Sets status='deleted' + deleted_at on the root only. Versions, raw
// evidence, media files/metadata and backup manifests are deliberately left
// untouched; permanent delete is a separate explicit command
// (src/backup-policy.ts). Never implemented via broad deleteAllUserData.

export async function tombstoneMealEvent(
    pool: Pool,
    eventId: string,
): Promise<void> {
    const { rowCount } = await pool.query(
        `UPDATE meal_events
         SET status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [eventId],
    );
    if (rowCount === 0) {
        throw new MealEventValidationError([
            `event not found or already deleted: ${eventId}`,
        ]);
    }
}
