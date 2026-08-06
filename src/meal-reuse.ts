// src/meal-reuse.ts — READ-ONLY reusable-meal discovery. Lexical matching
// only (ILIKE over persisted item text/notes); this module performs no
// writes, no provider calls, and registers nothing. Slice 4 owns mutation.
import { normalizeDescription } from "./search.js";
import type { MealEventProjection } from "./meal-event-projection.js";

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
