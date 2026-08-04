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
        nutrients: Partial<Nutrients>;
    }[];
    canonical: {
        status: string;
        consensus_status: string;
        calories: number | null;
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
        fiber_g: number | null;
        sugar_g: number | null;
        alcohol_g: number | null;
        eligible_providers: string[];
        outlier_providers: string[];
        threshold_percent: number;
        policy_version: string;
    } | null;
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
): Promise<void> {
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
        const { rows } = await client.query(
            `INSERT INTO meal_event_nutrition_results
                (event_id, version, ordinal, provider, status,
                 request_fingerprint, algorithm_version, raw_payload,
                 ${NUTRIENT_COLUMNS}, error_code, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     $9, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING id`,
            [
                eventId,
                version,
                scope,
                r.provider,
                r.status,
                r.request_fingerprint,
                r.algorithm_version,
                JSON.stringify(r.raw_payload ?? {}),
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

    for (const [scope, results] of scopes) {
        const consensus = computeConsensus(
            results.map((r) => ({
                provider: r.provider,
                status: r.status,
                nutrients: r.nutrients,
            })),
        );
        await client.query(
            `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status,
                 ${NUTRIENT_COLUMNS},
                 eligible_providers, outlier_providers, threshold_percent,
                 policy_version, source_result_ids)
             VALUES ($1, $2, $3, $4, $5,
                     $6, $7, $8, $9, $10, $11, $12,
                     $13, $14, $15, $16, $17)`,
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
                succeededIdsByScope.get(scope) ?? [],
            ],
        );
    }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

export async function createMealEvent(
    pool: Pool,
    command: CreateMealEventCommand,
): Promise<CreateMealEventResult> {
    const issues = validateCreateMealEventCommand(command);
    if (issues.length > 0) throw new MealEventValidationError(issues);

    const reportedAt = resolveConsumedAt(command.reported_at, null);
    const consumedAt = resolveConsumedAt(
        command.reported_at,
        command.consumed_at,
    );

    try {
        return await withTransaction(pool, async (client) => {
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
                return {
                    event_id: existingEvent.id as string,
                    version: existingEvent.current_version as number,
                    deduplicated: true,
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
            await insertVersionChildren(client, {
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

            return { event_id: eventId, version: 1, deduplicated: false };
        });
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
                if (command.external_write_authorized === true) {
                    await withTransaction(pool, async (client) => {
                        const { rows: locked } = await client.query(
                            `SELECT id, current_version FROM meal_events
                             WHERE id = $1 FOR UPDATE`,
                            [rows[0]!.id],
                        );
                        await client.query(
                            `UPDATE meal_events
                             SET external_write_authorized = true, updated_at = now()
                             WHERE id = $1`,
                            [locked[0]!.id],
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
                                locked[0]!.id,
                                locked[0]!.current_version,
                                deriveCreateFingerprint(command),
                            ],
                        );
                    });
                }
                return {
                    event_id: rows[0]!.id as string,
                    version: rows[0]!.current_version as number,
                    deduplicated: true,
                };
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
                 WHERE id = $1 AND status = 'active'
                 FOR UPDATE`,
                [command.event_id],
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
                return {
                    event_id: command.event_id,
                    version: existing.rows[0]!.version as number,
                    deduplicated: true,
                };
            }

            await insertVersionChildren(client, {
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
                 SET current_version = $2, updated_at = now()
                 WHERE id = $1`,
                [command.event_id, nextVersion],
            );
            return {
                event_id: command.event_id,
                version: nextVersion,
                deduplicated: false,
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
                return {
                    event_id: command.event_id,
                    version: rows[0]!.version as number,
                    deduplicated: true,
                };
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
                 WHERE event_id = $1 AND version = $2 AND ordinal IS NULL`,
                [eventId, resolvedVersion],
            ),
            pool.query(
                `SELECT * FROM meal_event_sync_journal
                 WHERE event_id = $1 AND version = $2`,
                [eventId, resolvedVersion],
            ),
        ]);

    const canonicalRow = canonical.rows[0];

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
            nutrients: Object.fromEntries(
                NUTRIENT_FIELDS.map((f) => [f, numOrNull(r[f])]),
            ) as Partial<Nutrients>,
        })),
        canonical: canonicalRow
            ? {
                  status: canonicalRow.status as string,
                  consensus_status: canonicalRow.consensus_status as string,
                  calories: numOrNull(canonicalRow.calories),
                  protein_g: numOrNull(canonicalRow.protein_g),
                  carbs_g: numOrNull(canonicalRow.carbs_g),
                  fat_g: numOrNull(canonicalRow.fat_g),
                  fiber_g: numOrNull(canonicalRow.fiber_g),
                  sugar_g: numOrNull(canonicalRow.sugar_g),
                  alcohol_g: numOrNull(canonicalRow.alcohol_g),
                  eligible_providers:
                      (canonicalRow.eligible_providers as string[]) ?? [],
                  outlier_providers:
                      (canonicalRow.outlier_providers as string[]) ?? [],
                  threshold_percent: Number(canonicalRow.threshold_percent),
                  policy_version: canonicalRow.policy_version as string,
              }
            : null,
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
