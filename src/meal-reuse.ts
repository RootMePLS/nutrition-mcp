// src/meal-reuse.ts — reusable-meal discovery (read-only lexical matching,
// ILIKE over persisted item text/notes) and, since Slice 4, the confirmed
// reuse mutation: a transactional, idempotent server-side copy of persisted
// source evidence with immutable lineage. This module never calls providers
// and never accepts caller-supplied nutrition values.
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { normalizeDescription } from "./search.js";
import {
    searchMealProjections,
    type MealEventProjection,
} from "./meal-event-projection.js";
import {
    deriveAggregateProvenance,
    getMealEventProvenance,
    MealEventValidationError,
    readPersistedWriteStatus,
    type MealEventAggregate,
    type MealEventCanonical,
} from "./meal-events.js";
import {
    deriveReuseIdempotencyFingerprint,
    isStrictIsoTimestamp,
    NUTRIENT_FIELDS,
    resolveConsumedAt,
    type Nutrients,
} from "./meal-types.js";

export const REUSE_WINDOW_DAYS = 90;
export const MAX_REUSE_VARIATIONS = 10;
export const MAX_REUSE_CANDIDATES = 2;

export interface ReuseCandidateComponent {
    ordinal: number;
    raw_item_text: string;
    normalized_name: string | null;
    quantity: number | null;
    portion_value: number | null;
    portion_unit: string | null;
    notes: string | null;
}

export interface ReuseCanonical {
    status: "pending" | "ready" | "low_confidence";
    consensus_status:
        | "two_agree_one_outlier"
        | "all_agree"
        | "no_consensus"
        | "insufficient_data";
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;
    alcohol_g: number | null;
}

export interface ReuseSourceCandidate {
    source_event_id: string;
    /** Version whose data is shown (current at read time). */
    source_version: number;
    current_version: number;
    is_current: boolean;
    /** ISO timestamp. */
    consumed_at: string;
    meal_type: string | null;
    /** Ordered by ordinal. */
    components: ReuseCandidateComponent[];
    /** Null when no canonical row exists: never zero-filled. */
    canonical: ReuseCanonical | null;
    provenance_status: "ready" | "pending" | "unavailable" | "missing";
    compatibility: boolean;
    bundle_fingerprint: string | null;
}

export interface ReuseVariation {
    /** normalizeDescription output — the grouping key. */
    variation_key: string;
    /** Newest occurrence's rendered description. */
    label: string;
    occurrences_90d: number;
    last_consumed_at: string;
    /** ≤ 2, most recent first. */
    candidates: ReuseSourceCandidate[];
}

export interface ReuseDiscovery {
    match_mode: "lexical";
    window_days: 90;
    generated_at: string;
    total_matches_90d: number;
    /** Frequency desc, recency tie-break, ≤ 10. */
    variations: ReuseVariation[];
}

export interface RankedReuseVariation {
    key: string;
    label: string;
    count: number;
    lastConsumedAt: string;
    candidateIds: string[];
}

/**
 * Pure: group + rank matches; no I/O. Exported for unit tests.
 * Grouping key is the same normalizeDescription the legacy text path uses,
 * so the structured and prose groupings can never disagree on what a
 * "variation" is. Ranking: count desc, then newest occurrence desc.
 * Candidates: the newest events by logged_at, id desc for determinism.
 */
export function rankReuseVariations(
    matches: Pick<MealEventProjection, "id" | "description" | "logged_at">[],
    opts: { maxVariations?: number; maxCandidates?: number } = {},
): RankedReuseVariation[] {
    const maxVariations = opts.maxVariations ?? MAX_REUSE_VARIATIONS;
    const maxCandidates = opts.maxCandidates ?? MAX_REUSE_CANDIDATES;

    const groups = new Map<
        string,
        Pick<MealEventProjection, "id" | "description" | "logged_at">[]
    >();
    for (const m of matches) {
        const key = normalizeDescription(m.description);
        const group = groups.get(key);
        if (group) group.push(m);
        else groups.set(key, [m]);
    }
    const variations: RankedReuseVariation[] = [];
    for (const [key, group] of groups) {
        const newestFirst = group
            .slice()
            .sort(
                (a, b) =>
                    b.logged_at.localeCompare(a.logged_at) ||
                    b.id.localeCompare(a.id),
            );
        const newest = newestFirst[0]!;
        variations.push({
            key,
            label: newest.description,
            count: group.length,
            lastConsumedAt: newest.logged_at,
            candidateIds: newestFirst.slice(0, maxCandidates).map((m) => m.id),
        });
    }
    variations.sort(
        (a, b) =>
            b.count - a.count ||
            b.lastConsumedAt.localeCompare(a.lastConsumedAt),
    );
    return variations.slice(0, maxVariations);
}

function reuseCanonical(
    canonical: MealEventCanonical | null,
): ReuseCanonical | null {
    if (!canonical) return null;
    return {
        status: canonical.status as ReuseCanonical["status"],
        consensus_status:
            canonical.consensus_status as ReuseCanonical["consensus_status"],
        calories: canonical.calories,
        protein_g: canonical.protein_g,
        carbs_g: canonical.carbs_g,
        fat_g: canonical.fat_g,
        fiber_g: canonical.fiber_g,
        sugar_g: canonical.sugar_g,
        alcohol_g: canonical.alcohol_g,
    };
}

/**
 * DB read: uncapped 90d lexical match -> ranked variations -> at most two
 * per-variation candidate aggregates read through the same user-scoped
 * provenance read every public tool uses. No writes, no provider calls.
 * `opts.now` injects the clock so window-boundary tests are deterministic.
 */
export async function searchReuseCandidates(
    pool: Pool,
    userId: string,
    queries: string[],
    opts: { now?: string } = {},
): Promise<ReuseDiscovery> {
    const generatedAt = new Date().toISOString();
    const now = opts.now ?? generatedAt;
    const empty: ReuseDiscovery = {
        match_mode: "lexical",
        window_days: REUSE_WINDOW_DAYS,
        generated_at: generatedAt,
        total_matches_90d: 0,
        variations: [],
    };
    const hasTokens = queries.some((q) => q.trim().length > 0);
    if (!hasTokens) return empty;

    const sinceIso = new Date(
        Date.parse(now) - REUSE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const matches = await searchMealProjections(pool, userId, queries, {
        sinceIso,
        limit: null,
    });
    if (matches.length === 0) return empty;

    const ranked = rankReuseVariations(matches);
    const variations: ReuseVariation[] = [];
    for (const variation of ranked) {
        const candidates: ReuseSourceCandidate[] = [];
        for (const eventId of variation.candidateIds) {
            const found = await getMealEventProvenance(pool, userId, eventId);
            // An event vanishing between the two reads is skipped, never
            // fabricated.
            if (!found) continue;
            const { aggregate } = found;
            candidates.push({
                source_event_id: aggregate.event.id,
                source_version: aggregate.version.version,
                current_version: aggregate.event.current_version,
                is_current: found.is_current,
                consumed_at: aggregate.event.consumed_at,
                meal_type: aggregate.event.meal_type,
                components: aggregate.items.map((item) => ({
                    ordinal: item.ordinal,
                    raw_item_text: item.raw_item_text,
                    normalized_name: item.normalized_name,
                    quantity: item.quantity,
                    portion_value: item.portion_value,
                    portion_unit: item.portion_unit,
                    notes: item.notes,
                })),
                canonical: reuseCanonical(aggregate.canonical),
                provenance_status: found.provenance_status,
                compatibility: found.compatibility,
                bundle_fingerprint:
                    aggregate.version.calculation_bundle_fingerprint,
            });
        }
        variations.push({
            variation_key: variation.key,
            label: variation.label,
            occurrences_90d: variation.count,
            last_consumed_at: variation.lastConsumedAt,
            candidates,
        });
    }
    return {
        match_mode: "lexical",
        window_days: REUSE_WINDOW_DAYS,
        generated_at: generatedAt,
        total_matches_90d: matches.length,
        variations,
    };
}

// ---------------------------------------------------------------------------
// Slice 4: confirmed meal-reuse mutation — pure contracts.
//
// Domain errors carry a readonly stable `code`; the MCP layer maps them to
// stable public messages (mirroring the Slice 2 supplement tools). The pure
// helpers below are the ONLY place identity equality and eligibility
// classification are defined; the transactional service and its tests build
// on them. No DB code in this section.
// ---------------------------------------------------------------------------

export class MealReuseSourceNotFoundError extends Error {
    readonly code = "meal_reuse_source_not_found";
    constructor() {
        super("no reusable meal event with this id exists for this user");
        this.name = "MealReuseSourceNotFoundError";
    }
}

export class MealReuseSourceVersionError extends Error {
    readonly code = "meal_reuse_source_version_not_current_or_historical";
    constructor() {
        super(
            "requested source version is neither the current nor a persisted historical version",
        );
        this.name = "MealReuseSourceVersionError";
    }
}

export type MealReuseIneligibleCategory =
    "compatibility" | "pending" | "unavailable" | "missing";

export class MealReuseSourceIneligibleError extends Error {
    readonly code = "meal_reuse_source_ineligible";
    constructor(readonly category: MealReuseIneligibleCategory) {
        super(
            `meal_reuse_source_ineligible: ${category} — source version lacks complete ready provider/canonical evidence; nothing was created and no value was fabricated`,
        );
        this.name = "MealReuseSourceIneligibleError";
    }
}

export class MealReuseIdempotencyConflictError extends Error {
    readonly code = "idempotency_conflict";
    constructor() {
        super(
            "idempotency_conflict: this reuse idempotency key was already used with a different source event/version or timestamps",
        );
        this.name = "MealReuseIdempotencyConflictError";
    }
}

/**
 * Millisecond-equal reuse identity comparison. timestamptz round-trips lose
 * sub-ms precision and ISO string variants (`Z` vs `+00:00`) differ
 * textually, so identity equality compares `Date.parse` millisecond values,
 * never strings.
 */
export function reuseIdentityMatches(
    stored: {
        source_event_id: string;
        source_version: number;
        reported_at: string;
        consumed_at: string;
    },
    incoming: {
        source_event_id: string;
        source_version: number;
        reported_at: string;
        consumed_at: string;
    },
): boolean {
    return (
        stored.source_event_id === incoming.source_event_id &&
        stored.source_version === incoming.source_version &&
        Date.parse(stored.reported_at) === Date.parse(incoming.reported_at) &&
        Date.parse(stored.consumed_at) === Date.parse(incoming.consumed_at)
    );
}

/**
 * Map the real persisted `deriveAggregateProvenance` verdict to a reuse
 * eligibility decision. A compatibility version (no bundle fingerprint) is
 * never eligible even when the status derivation says otherwise; otherwise
 * only an exact `ready` status is eligible.
 */
export function classifyReuseEligibility(derived: {
    provenance_status: "ready" | "pending" | "unavailable" | "missing";
    compatibility: boolean;
}):
    | { eligible: true }
    | { eligible: false; category: MealReuseIneligibleCategory } {
    if (derived.compatibility === true) {
        return { eligible: false, category: "compatibility" };
    }
    if (derived.provenance_status !== "ready") {
        return { eligible: false, category: derived.provenance_status };
    }
    return { eligible: true };
}

// ---------------------------------------------------------------------------
// Slice 4: confirmed meal-reuse mutation — transactional copy service.
//
// One transaction locks the idempotency identity and the exact source
// event/version, enforces eligibility against the real persisted
// deriveAggregateProvenance policy, copies server-read source items/provider
// evidence/canonical facts byte-for-byte into a fresh root + version 1
// (carrying the source bundle fingerprint so the copy re-derives ready),
// writes lineage into the shipped 006/007 tables, and proves the copy by
// re-deriving provenance from the persisted rows before commit. No provider
// invocation, no caller-supplied nutrition values, no fabricated zeros.
// ---------------------------------------------------------------------------

export interface ReuseMealCalculationCommand {
    user_id: string;
    source_event_id: string;
    source_version: number;
    /** Fresh, caller-supplied occurrence timestamps (ISO). */
    reported_at: string;
    consumed_at: string;
    idempotency_key: string;
    created_by: string;
}

export interface ReuseMealCalculationResult {
    event_id: string;
    version: 1;
    deduplicated: boolean;
    source_event_id: string;
    source_version: number;
    source_was_current: boolean;
    source_bundle_fingerprint: string;
    /** By construction; asserted from the persisted readback, never assumed. */
    provenance_status: "ready";
    compatibility: false;
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateReuseCommand(command: ReuseMealCalculationCommand): void {
    const issues: string[] = [];
    if (!UUID_RE.test(command.source_event_id)) {
        issues.push("source_event_id must be a UUID");
    }
    if (
        !Number.isInteger(command.source_version) ||
        command.source_version < 1
    ) {
        issues.push("source_version must be an integer >= 1");
    }
    if (!isStrictIsoTimestamp(command.reported_at)) {
        issues.push(
            "reported_at must be a strict ISO 8601 timestamp with an explicit UTC offset",
        );
    }
    if (!isStrictIsoTimestamp(command.consumed_at)) {
        issues.push(
            "consumed_at must be a strict ISO 8601 timestamp with an explicit UTC offset",
        );
    }
    const key = command.idempotency_key?.trim() ?? "";
    if (key.length === 0 || command.idempotency_key.length > 255) {
        issues.push("idempotency_key must be non-empty and at most 255 chars");
    }
    if (issues.length > 0) throw new MealEventValidationError(issues);
}

function numOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function tsIso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

type Row = Record<string, unknown>;

interface SourceSnapshot {
    /** Full source version row (all columns). */
    versionRow: Row;
    itemRows: Row[];
    /** All provider rows of the source version, both scopes, all columns. */
    providerRows: Row[];
    /** All canonical rows of the source version, both scopes, all columns. */
    canonicalRows: Row[];
    /** Aggregate in the shape deriveAggregateProvenance consumes. */
    aggregate: MealEventAggregate;
}

function mapCanonicalRow(row: Row): MealEventCanonical {
    return {
        status: row.status as string,
        consensus_status: row.consensus_status as string,
        ...(Object.fromEntries(
            NUTRIENT_FIELDS.map((f) => [f, numOrNull(row[f])]),
        ) as Nutrients),
        eligible_providers: row.eligible_providers as string[] | null,
        outlier_providers: row.outlier_providers as string[] | null,
        threshold_percent: Number(row.threshold_percent),
        policy_version: row.policy_version as string,
        source_result_ids: row.source_result_ids as string[] | null,
        audit_evidence: row.audit_evidence as Record<string, unknown> | null,
        algorithm_version: (row.algorithm_version as string | null) ?? null,
    };
}

/**
 * Sequential in-transaction source snapshot (a PoolClient forbids concurrent
 * queries, so getMealEvent's Promise.all pattern cannot be reused here).
 * Returns null when the requested version has no persisted row.
 */
async function readSourceAggregateForReuse(
    client: PoolClient,
    rootRow: Row,
    eventId: string,
    version: number,
): Promise<SourceSnapshot | null> {
    const versionResult = await client.query(
        `SELECT * FROM meal_event_versions WHERE event_id = $1 AND version = $2`,
        [eventId, version],
    );
    const versionRow = versionResult.rows[0];
    if (!versionRow) return null;
    const itemsResult = await client.query(
        `SELECT * FROM meal_event_items
         WHERE event_id = $1 AND version = $2 ORDER BY ordinal`,
        [eventId, version],
    );
    const providersResult = await client.query(
        `SELECT * FROM meal_event_nutrition_results
         WHERE event_id = $1 AND version = $2 ORDER BY ordinal NULLS FIRST, provider`,
        [eventId, version],
    );
    const canonicalResult = await client.query(
        `SELECT * FROM meal_event_canonical_results
         WHERE event_id = $1 AND version = $2 ORDER BY ordinal NULLS FIRST`,
        [eventId, version],
    );

    const itemRows: Row[] = itemsResult.rows;
    const providerRows: Row[] = providersResult.rows;
    const canonicalRows: Row[] = canonicalResult.rows;
    const eventCanonicalRow = canonicalRows.find((r) => r.ordinal === null);
    const itemCanonicalRows = canonicalRows.filter(
        (r) => typeof r.ordinal === "number",
    );

    const aggregate: MealEventAggregate = {
        event: {
            id: rootRow.id as string,
            user_id: rootRow.user_id as string,
            reported_at: tsIso(rootRow.reported_at),
            consumed_at: tsIso(rootRow.consumed_at),
            meal_type: (rootRow.meal_type as string | null) ?? null,
            status: rootRow.status as string,
            current_version: rootRow.current_version as number,
            idempotency_key: rootRow.idempotency_key as string,
            external_write_authorized:
                rootRow.external_write_authorized as boolean,
            created_at: tsIso(rootRow.created_at),
            updated_at: tsIso(rootRow.updated_at),
            deleted_at: rootRow.deleted_at ? tsIso(rootRow.deleted_at) : null,
        },
        version: {
            event_id: versionRow.event_id as string,
            version: versionRow.version as number,
            correction_idempotency_key:
                (versionRow.correction_idempotency_key as string | null) ??
                null,
            correction_reason:
                (versionRow.correction_reason as string | null) ?? null,
            raw_text_snapshot:
                (versionRow.raw_text_snapshot as string | null) ?? null,
            parser_policy_version: versionRow.parser_policy_version as string,
            created_by: versionRow.created_by as string,
            created_at: tsIso(versionRow.created_at),
            calculation_bundle_fingerprint:
                (versionRow.calculation_bundle_fingerprint as string | null) ??
                null,
        },
        items: itemRows.map((r) => ({
            ordinal: r.ordinal as number,
            raw_item_text: r.raw_item_text as string,
            normalized_name: (r.normalized_name as string | null) ?? null,
            quantity: numOrNull(r.quantity),
            portion_value: numOrNull(r.portion_value),
            portion_unit: (r.portion_unit as string | null) ?? null,
            notes: (r.notes as string | null) ?? null,
        })),
        // Raw occurrence evidence / media / journal do not participate in
        // provenance derivation and are never copied by reuse.
        inputs: [],
        media: [],
        provider_results: providerRows.map((r) => ({
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
        journal: [],
    };
    return { versionRow, itemRows, providerRows, canonicalRows, aggregate };
}

interface ExistingReuseRow {
    event_id: string;
    version: number;
    source_event_id: string;
    source_version: number;
    source_bundle_fingerprint: string | null;
    reported_at: unknown;
    consumed_at: unknown;
}

async function lockExistingReuse(
    client: PoolClient,
    userId: string,
    idempotencyKey: string,
): Promise<ExistingReuseRow | null> {
    const { rows } = await client.query(
        `SELECT r.event_id, r.version, r.source_event_id, r.source_version,
                r.source_bundle_fingerprint, e.reported_at, e.consumed_at
           FROM meal_event_reuse_sources r
           JOIN meal_events e ON e.id = r.event_id
          WHERE r.user_id = $1 AND r.reuse_idempotency_key = $2
          FOR UPDATE OF r`,
        [userId, idempotencyKey],
    );
    return (rows[0] as ExistingReuseRow | undefined) ?? null;
}

/** Readback for a reuse that already exists (retry/concurrency winner). */
async function existingReuseResult(
    client: PoolClient,
    userId: string,
    existing: ExistingReuseRow,
): Promise<ReuseMealCalculationResult> {
    const sourceRoot = await client.query(
        `SELECT current_version FROM meal_events
         WHERE id = $1 AND user_id = $2`,
        [existing.source_event_id, userId],
    );
    if (!sourceRoot.rows[0]) {
        throw new Error("reused event source root readback missing");
    }
    const persisted = await readPersistedWriteStatus(
        client,
        existing.event_id,
        existing.version,
    );
    if (
        persisted.provenance_status !== "ready" ||
        persisted.compatibility !== false
    ) {
        throw new Error(
            "reused event readback did not derive ready — copy is incomplete",
        );
    }
    return {
        event_id: existing.event_id,
        version: 1,
        deduplicated: true,
        source_event_id: existing.source_event_id,
        source_version: existing.source_version,
        source_was_current:
            existing.source_version ===
            Number(sourceRoot.rows[0].current_version),
        source_bundle_fingerprint: existing.source_bundle_fingerprint ?? "",
        provenance_status: "ready",
        compatibility: false,
    };
}

function isUniqueViolation(err: unknown, constraintFragment: string): boolean {
    const e = err as { code?: string; constraint?: string; message?: string };
    return (
        e?.code === "23505" &&
        (String(e.constraint ?? e.message ?? "").includes(constraintFragment) ||
            String(e.message ?? "").includes(constraintFragment))
    );
}

export async function reuseMealCalculation(
    pool: Pool,
    command: ReuseMealCalculationCommand,
    opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<ReuseMealCalculationResult> {
    validateReuseCommand(command);

    const persist = async (
        client: PoolClient,
    ): Promise<ReuseMealCalculationResult> => {
        // 1. Idempotency identity lock: an existing committed reuse with this
        // key converges (identical command) or conflicts (changed identity).
        const existing = await lockExistingReuse(
            client,
            command.user_id,
            command.idempotency_key,
        );
        if (existing) {
            const matches = reuseIdentityMatches(
                {
                    source_event_id: existing.source_event_id,
                    source_version: existing.source_version,
                    reported_at: tsIso(existing.reported_at),
                    consumed_at: tsIso(existing.consumed_at),
                },
                {
                    source_event_id: command.source_event_id,
                    source_version: command.source_version,
                    reported_at: command.reported_at,
                    consumed_at: command.consumed_at,
                },
            );
            if (!matches) throw new MealReuseIdempotencyConflictError();
            return existingReuseResult(client, command.user_id, existing);
        }

        // 2. Source root lock, fail-closed scope: absent, deleted, and
        // cross-user are one indistinguishable not-found.
        const sourceRoot = await client.query(
            `SELECT * FROM meal_events
             WHERE id = $1 AND user_id = $2 AND status = 'active'
             FOR UPDATE`,
            [command.source_event_id, command.user_id],
        );
        const rootRow = sourceRoot.rows[0];
        if (!rootRow) throw new MealReuseSourceNotFoundError();

        // 3. Requested version snapshot (null = no persisted row for v).
        const snapshot = await readSourceAggregateForReuse(
            client,
            rootRow,
            command.source_event_id,
            command.source_version,
        );
        if (!snapshot) throw new MealReuseSourceVersionError();
        const sourceWasCurrent =
            command.source_version === Number(rootRow.current_version);

        // 4. Eligibility: the real persisted deriveAggregateProvenance
        // policy, fail-closed. Nothing is fabricated for lesser states.
        const verdict = classifyReuseEligibility(
            deriveAggregateProvenance(snapshot.aggregate),
        );
        if (!verdict.eligible) {
            throw new MealReuseSourceIneligibleError(verdict.category);
        }
        const sourceFingerprint =
            snapshot.aggregate.version.calculation_bundle_fingerprint;
        if (sourceFingerprint === null) {
            // Unreachable after an eligible verdict (ready implies a bundle
            // fingerprint); belt-and-braces because the fingerprint is
            // copied onto the target version row.
            throw new MealReuseSourceIneligibleError("compatibility");
        }

        // 5. Copy-write the target graph (same client, same transaction).
        const targetId = crypto.randomUUID();
        const reportedAt = resolveConsumedAt(command.reported_at, null);
        const consumedAt = resolveConsumedAt(
            command.reported_at,
            command.consumed_at,
        );
        await client.query(
            `INSERT INTO meal_events
                (id, user_id, reported_at, consumed_at, meal_type,
                 idempotency_key, external_write_authorized)
             VALUES ($1, $2, $3, $4, $5, $6, false)`,
            [
                targetId,
                command.user_id,
                reportedAt.toISOString(),
                consumedAt.toISOString(),
                rootRow.meal_type ?? null,
                deriveReuseIdempotencyFingerprint({
                    user_id: command.user_id,
                    reuse_idempotency_key: command.idempotency_key,
                    source_event_id: command.source_event_id,
                    source_version: command.source_version,
                    reported_at: command.reported_at,
                    consumed_at: command.consumed_at,
                }),
            ],
        );
        await client.query(
            `INSERT INTO meal_event_versions
                (event_id, version, parser_policy_version, created_by,
                 calculation_bundle_fingerprint)
             VALUES ($1, 1, $2, $3, $4)`,
            [
                targetId,
                snapshot.versionRow.parser_policy_version,
                command.created_by,
                sourceFingerprint,
            ],
        );
        for (const item of snapshot.itemRows) {
            await client.query(
                `INSERT INTO meal_event_items
                    (event_id, version, ordinal, raw_item_text,
                     normalized_name, quantity, portion_value, portion_unit,
                     notes)
                 VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    targetId,
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
        const resultIdMap = new Map<string, string>();
        for (const row of snapshot.providerRows) {
            const { rows: inserted } = await client.query(
                `INSERT INTO meal_event_nutrition_results
                    (event_id, version, ordinal, provider, source_id, status,
                     request_fingerprint, algorithm_version, raw_payload,
                     provenance, basis, units, ${NUTRIENT_FIELDS.join(", ")},
                     error_code, error_message, calculated_at)
                 VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                         ${NUTRIENT_FIELDS.map((_, i) => `$${12 + i}`).join(",")},
                         $${12 + NUTRIENT_FIELDS.length},
                         $${13 + NUTRIENT_FIELDS.length},
                         $${14 + NUTRIENT_FIELDS.length})
                 RETURNING id`,
                [
                    targetId,
                    row.ordinal ?? null,
                    row.provider,
                    row.source_id ?? null,
                    row.status,
                    row.request_fingerprint,
                    row.algorithm_version,
                    JSON.stringify(row.raw_payload ?? {}),
                    row.provenance == null
                        ? null
                        : JSON.stringify(row.provenance),
                    row.basis ?? null,
                    row.units ?? null,
                    ...NUTRIENT_FIELDS.map((f) => row[f] ?? null),
                    row.error_code ?? null,
                    row.error_message ?? null,
                    row.calculated_at,
                ],
            );
            resultIdMap.set(row.id as string, inserted[0]!.id as string);
        }
        let sourceEventCanonicalId: string | null = null;
        for (const row of snapshot.canonicalRows) {
            const remappedIds = (
                (row.source_result_ids as string[] | null) ?? []
            ).map((sourceId) => {
                const targetResultId = resultIdMap.get(sourceId);
                if (!targetResultId) {
                    throw new Error(
                        `canonical source_result_id ${sourceId} has no copied provider row — copy is incomplete`,
                    );
                }
                return targetResultId;
            });
            if (row.ordinal === null) {
                sourceEventCanonicalId = row.id as string;
            }
            await client.query(
                `INSERT INTO meal_event_canonical_results
                    (event_id, version, ordinal, status, consensus_status,
                     ${NUTRIENT_FIELDS.join(", ")},
                     eligible_providers, outlier_providers, threshold_percent,
                     policy_version, source_result_ids, audit_evidence,
                     algorithm_version, created_at)
                 VALUES ($1, 1, $2, $3, $4,
                         ${NUTRIENT_FIELDS.map((_, i) => `$${5 + i}`).join(",")},
                         $${5 + NUTRIENT_FIELDS.length},
                         $${6 + NUTRIENT_FIELDS.length},
                         $${7 + NUTRIENT_FIELDS.length},
                         $${8 + NUTRIENT_FIELDS.length},
                         $${9 + NUTRIENT_FIELDS.length},
                         $${10 + NUTRIENT_FIELDS.length},
                         $${11 + NUTRIENT_FIELDS.length},
                         $${12 + NUTRIENT_FIELDS.length})`,
                [
                    targetId,
                    row.ordinal ?? null,
                    row.status,
                    row.consensus_status,
                    ...NUTRIENT_FIELDS.map((f) => row[f] ?? null),
                    row.eligible_providers ?? [],
                    row.outlier_providers ?? [],
                    row.threshold_percent,
                    row.policy_version,
                    remappedIds,
                    JSON.stringify(row.audit_evidence ?? {}),
                    row.algorithm_version ?? null,
                    row.created_at,
                ],
            );
        }

        // 6. Immutable lineage: the source relationship and per-provider
        // mappings, verified by 007's composite foreign keys.
        await client.query(
            `INSERT INTO meal_event_reuse_sources
                (event_id, version, user_id, source_event_id, source_version,
                 source_canonical_result_id, source_bundle_fingerprint,
                 reuse_idempotency_key, confirmation_received, created_by)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, true, $8)`,
            [
                targetId,
                command.user_id,
                command.source_event_id,
                command.source_version,
                sourceEventCanonicalId,
                sourceFingerprint,
                command.idempotency_key,
                command.created_by,
            ],
        );
        for (const row of snapshot.providerRows) {
            await client.query(
                `INSERT INTO meal_event_reuse_provider_sources
                    (event_id, version, target_provider_result_id,
                     source_provider_result_id, source_request_fingerprint,
                     source_event_id, source_version)
                 VALUES ($1, 1, $2, $3, $4, $5, $6)`,
                [
                    targetId,
                    resultIdMap.get(row.id as string),
                    row.id,
                    row.request_fingerprint,
                    command.source_event_id,
                    command.source_version,
                ],
            );
        }

        await opts.beforeCommit?.();

        // 7. In-transaction readback: the copy must re-derive ready from its
        // own persisted rows before commit, or nothing persists.
        const persisted = await readPersistedWriteStatus(client, targetId, 1);
        if (
            persisted.provenance_status !== "ready" ||
            persisted.compatibility !== false
        ) {
            throw new Error(
                "reused event readback did not derive ready — copy is incomplete",
            );
        }
        return {
            event_id: targetId,
            version: 1,
            deduplicated: false,
            source_event_id: command.source_event_id,
            source_version: command.source_version,
            source_was_current: sourceWasCurrent,
            source_bundle_fingerprint: sourceFingerprint,
            provenance_status: "ready",
            compatibility: false,
        };
    };

    try {
        return await withTransaction(pool, persist);
    } catch (err) {
        // Concurrency convergence: a same-key racer aborted on the lineage or
        // root unique index. Read the now-committed winner and converge or
        // declare the conflict — never partial or doubled state.
        if (
            isUniqueViolation(err, "uniq_meal_reuse_user_idem") ||
            isUniqueViolation(err, "uniq_meal_events_user_idem")
        ) {
            const winner = await withTransaction(pool, async (client) =>
                lockExistingReuse(
                    client,
                    command.user_id,
                    command.idempotency_key,
                ),
            );
            if (!winner) throw err;
            const matches = reuseIdentityMatches(
                {
                    source_event_id: winner.source_event_id,
                    source_version: winner.source_version,
                    reported_at: tsIso(winner.reported_at),
                    consumed_at: tsIso(winner.consumed_at),
                },
                {
                    source_event_id: command.source_event_id,
                    source_version: command.source_version,
                    reported_at: command.reported_at,
                    consumed_at: command.consumed_at,
                },
            );
            if (!matches) throw new MealReuseIdempotencyConflictError();
            return withTransaction(pool, (client) =>
                existingReuseResult(client, command.user_id, winner),
            );
        }
        throw err;
    }
}

/** User-scoped lineage readback; null for cross-user/absent — no leak. */
export async function getReuseLineage(
    pool: Pool,
    userId: string,
    eventId: string,
): Promise<{
    source_event_id: string;
    source_version: number;
    source_canonical_result_id: string | null;
    source_bundle_fingerprint: string | null;
    reuse_idempotency_key: string;
    confirmation_received: boolean;
    copied_at: string;
    provider_mappings: Array<{
        target_provider_result_id: string;
        source_provider_result_id: string;
        source_request_fingerprint: string;
    }>;
} | null> {
    const { rows } = await pool.query(
        `SELECT source_event_id, source_version, source_canonical_result_id,
                source_bundle_fingerprint, reuse_idempotency_key,
                confirmation_received, copied_at
           FROM meal_event_reuse_sources
          WHERE event_id = $1 AND user_id = $2`,
        [eventId, userId],
    );
    const row = rows[0];
    if (!row) return null;
    const mappings = await pool.query(
        `SELECT target_provider_result_id, source_provider_result_id,
                source_request_fingerprint
           FROM meal_event_reuse_provider_sources
          WHERE event_id = $1 AND version = $2
          ORDER BY target_provider_result_id`,
        [eventId, 1],
    );
    return {
        source_event_id: row.source_event_id as string,
        source_version: Number(row.source_version),
        source_canonical_result_id:
            (row.source_canonical_result_id as string | null) ?? null,
        source_bundle_fingerprint:
            (row.source_bundle_fingerprint as string | null) ?? null,
        reuse_idempotency_key: row.reuse_idempotency_key as string,
        confirmation_received: row.confirmation_received as boolean,
        copied_at: tsIso(row.copied_at),
        provider_mappings: mappings.rows.map((m) => ({
            target_provider_result_id: m.target_provider_result_id as string,
            source_provider_result_id: m.source_provider_result_id as string,
            source_request_fingerprint: m.source_request_fingerprint as string,
        })),
    };
}
