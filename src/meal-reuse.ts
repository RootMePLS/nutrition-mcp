// src/meal-reuse.ts — READ-ONLY reusable-meal discovery. Lexical matching
// only (ILIKE over persisted item text/notes); this module performs no
// writes, no provider calls, and registers nothing. Slice 4 owns mutation.
import type { Pool } from "pg";
import { normalizeDescription } from "./search.js";
import {
    searchMealProjections,
    type MealEventProjection,
} from "./meal-event-projection.js";
import {
    getMealEventProvenance,
    type MealEventCanonical,
} from "./meal-events.js";

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
    | "compatibility"
    | "pending"
    | "unavailable"
    | "missing";

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
}): { eligible: true } | { eligible: false; category: MealReuseIneligibleCategory } {
    if (derived.compatibility === true) {
        return { eligible: false, category: "compatibility" };
    }
    if (derived.provenance_status !== "ready") {
        return { eligible: false, category: derived.provenance_status };
    }
    return { eligible: true };
}
