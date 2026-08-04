// ============================================================================
// CONSENSUS POLICY (pure)
// ============================================================================
// Deterministic canonical-nutrient selection across the three provider
// namespaces (nutrition-local, own, myfitnesspal).
//
// Rules:
// - 10% relative disagreement threshold, inclusive boundary: exactly 10% is
//   agreement, anything strictly beyond is disagreement.
// - The comparison base is max(|a|, |b|); when the base is below ZERO_EPSILON
//   an absolute-epsilon rule is used instead of dividing by zero.
// - Two agreeing providers plus one outlier -> canonical is the average of
//   the agreeing pair and the third is recorded as outlier.
// - No agreeing pair -> arithmetic mean of all eligible values, no_consensus.
// - Missing/NULL/failed/unavailable values are excluded; they are never
//   treated as numeric zero.
// - Each nutrient is evaluated independently.
// - No rounding happens here; rounding belongs to the serialization/storage
//   boundary.

import {
    NUTRIENT_FIELDS,
    emptyNutrients,
    type CanonicalStatus,
    type ConsensusStatus,
    type NutrientField,
    type Nutrients,
    type NutritionProvider,
    type ProviderResultStatus,
} from "./meal-types.js";

export const CONSENSUS_THRESHOLD_PERCENT = 10;
export const ZERO_EPSILON = 1e-6;
export const CONSENSUS_POLICY_VERSION = "consensus-10pct-v1";

export interface ProviderNutrientResult {
    provider: NutritionProvider;
    status: ProviderResultStatus;
    nutrients?: Partial<Nutrients>;
}

export interface NutrientConsensus {
    value: number | null;
    consensus_status: ConsensusStatus;
    eligible_providers: NutritionProvider[];
    outlier_providers: NutritionProvider[];
}

export interface ConsensusOutcome {
    status: CanonicalStatus;
    consensus_status: ConsensusStatus;
    nutrients: Nutrients;
    per_nutrient: Record<NutrientField, NutrientConsensus>;
    eligible_providers: NutritionProvider[];
    outlier_providers: NutritionProvider[];
    threshold_percent: number;
    policy_version: string;
}

interface EligibleValue {
    provider: NutritionProvider;
    value: number;
}

function agrees(a: number, b: number, thresholdPercent: number): boolean {
    // Relative disagreement is measured against the smaller magnitude: a
    // value exactly 10% above the other agrees (inclusive boundary), anything
    // strictly beyond disagrees. When both values are near zero an absolute
    // epsilon rule applies instead of dividing by ~zero.
    const base = Math.min(Math.abs(a), Math.abs(b));
    const diff = Math.abs(a - b);
    if (base < ZERO_EPSILON) return diff <= ZERO_EPSILON;
    // Compare without rounding so a value just over the threshold cannot be
    // erased by serialization or floating-point formatting before this check.
    return diff / base <= thresholdPercent / 100;
}

function mean(values: number[]): number {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function evaluateNutrient(
    eligible: EligibleValue[],
    thresholdPercent: number,
): NutrientConsensus {
    const eligibleProviders = eligible.map((e) => e.provider);

    if (eligible.length === 0) {
        return {
            value: null,
            consensus_status: "insufficient_data",
            eligible_providers: [],
            outlier_providers: [],
        };
    }
    if (eligible.length === 1) {
        return {
            value: eligible[0]!.value,
            consensus_status: "insufficient_data",
            eligible_providers: eligibleProviders,
            outlier_providers: [],
        };
    }

    const values = eligible.map((e) => e.value);

    // All pairs agree -> all_agree.
    let allAgree = true;
    for (let i = 0; i < eligible.length && allAgree; i++) {
        for (let j = i + 1; j < eligible.length && allAgree; j++) {
            if (!agrees(values[i]!, values[j]!, thresholdPercent)) {
                allAgree = false;
            }
        }
    }
    if (allAgree) {
        return {
            value: mean(values),
            consensus_status: "all_agree",
            eligible_providers: eligibleProviders,
            outlier_providers: [],
        };
    }

    // Exactly-two-agree rule: find an agreeing pair whose every outside value
    // disagrees with both pair members. Deterministic tie-break: the closest
    // agreeing pair (smallest absolute difference), in input order.
    let bestPair: [number, number] | null = null;
    let bestSpread = Number.POSITIVE_INFINITY;
    for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
            if (!agrees(values[i]!, values[j]!, thresholdPercent)) continue;
            const outsiders = eligible.filter((_, k) => k !== i && k !== j);
            const allOutside = outsiders.every(
                (o) =>
                    !agrees(o.value, values[i]!, thresholdPercent) &&
                    !agrees(o.value, values[j]!, thresholdPercent),
            );
            if (!allOutside) continue;
            const spread = Math.abs(values[i]! - values[j]!);
            if (spread < bestSpread) {
                bestSpread = spread;
                bestPair = [i, j];
            }
        }
    }

    if (bestPair) {
        const [i, j] = bestPair;
        const outliers = eligible.filter((_, k) => k !== i && k !== j);
        return {
            value: (values[i]! + values[j]!) / 2,
            consensus_status: "two_agree_one_outlier",
            eligible_providers: [eligible[i]!.provider, eligible[j]!.provider],
            outlier_providers: outliers.map((o) => o.provider),
        };
    }

    // No agreeing pair -> arithmetic mean of all eligible values.
    return {
        value: mean(values),
        consensus_status: "no_consensus",
        eligible_providers: eligibleProviders,
        outlier_providers: [],
    };
}

export function computeConsensus(
    results: ProviderNutrientResult[],
    options: { thresholdPercent?: number } = {},
): ConsensusOutcome {
    const thresholdPercent =
        options.thresholdPercent ?? CONSENSUS_THRESHOLD_PERCENT;

    const perNutrient = {} as Record<NutrientField, NutrientConsensus>;
    const nutrients = emptyNutrients();

    for (const field of NUTRIENT_FIELDS) {
        const eligible: EligibleValue[] = [];
        for (const result of results) {
            if (result.status !== "succeeded") continue;
            const value = result.nutrients?.[field];
            if (value === null || value === undefined) continue;
            if (!Number.isFinite(value)) continue;
            eligible.push({ provider: result.provider, value });
        }
        const outcome = evaluateNutrient(eligible, thresholdPercent);
        perNutrient[field] = outcome;
        nutrients[field] = outcome.value;
    }

    // Aggregate status across independently evaluated nutrients.
    const statuses = NUTRIENT_FIELDS.map(
        (f) => perNutrient[f].consensus_status,
    );

    let consensusStatus: ConsensusStatus;
    if (statuses.includes("two_agree_one_outlier")) {
        consensusStatus = "two_agree_one_outlier";
    } else if (statuses.includes("no_consensus")) {
        consensusStatus = "no_consensus";
    } else if (statuses.includes("all_agree")) {
        consensusStatus = "all_agree";
    } else {
        consensusStatus = "insufficient_data";
    }

    let status: CanonicalStatus;
    const evaluated = NUTRIENT_FIELDS.filter(
        (f) => perNutrient[f].eligible_providers.length > 0,
    );
    if (evaluated.length === 0) {
        status = "pending";
    } else if (
        evaluated.every((f) =>
            ["all_agree", "two_agree_one_outlier"].includes(
                perNutrient[f].consensus_status,
            ),
        )
    ) {
        // Every nutrient with usable data reached agreement; nutrients with
        // no data at all stay NULL and don't downgrade the row.
        status = "ready";
    } else {
        // Single-value-only nutrients or unresolved disagreement.
        status = "low_confidence";
    }

    const eligibleProviders: NutritionProvider[] = [];
    const outlierProviders: NutritionProvider[] = [];
    for (const result of results) {
        if (
            NUTRIENT_FIELDS.some((f) =>
                perNutrient[f].eligible_providers.includes(result.provider),
            ) &&
            !eligibleProviders.includes(result.provider)
        ) {
            eligibleProviders.push(result.provider);
        }
        if (
            NUTRIENT_FIELDS.some((f) =>
                perNutrient[f].outlier_providers.includes(result.provider),
            ) &&
            !outlierProviders.includes(result.provider)
        ) {
            outlierProviders.push(result.provider);
        }
    }

    return {
        status,
        consensus_status: consensusStatus,
        nutrients,
        per_nutrient: perNutrient,
        eligible_providers: eligibleProviders,
        outlier_providers: outlierProviders,
        threshold_percent: thresholdPercent,
        policy_version: CONSENSUS_POLICY_VERSION,
    };
}
