import { describe, expect, test } from "bun:test";
import {
    computeConsensus,
    CONSENSUS_POLICY_VERSION,
    CONSENSUS_THRESHOLD_PERCENT,
    ZERO_EPSILON,
    type ProviderNutrientResult,
} from "./meal-consensus.js";
import {
    NUTRIENT_FIELDS,
    NUTRIENT_UNITS,
    emptyNutrients,
} from "./meal-types.js";

// ---------------------------------------------------------------------------
// Pure consensus policy: 10% relative threshold, explicit outlier rule.
// Missing/failed values are excluded and never treated as zero.
// No rounding before comparison.
// ---------------------------------------------------------------------------

function ok(
    provider: ProviderNutrientResult["provider"],
    nutrients: ProviderNutrientResult["nutrients"],
): ProviderNutrientResult {
    return { provider, status: "succeeded", nutrients };
}

describe("consensus policy", () => {
    test("all three equal -> canonical same value, all_agree, ready", () => {
        const outcome = computeConsensus([
            ok("nutrition-local", { calories: 500 }),
            ok("own", { calories: 500 }),
            ok("myfitnesspal", { calories: 500 }),
        ]);
        expect(outcome.nutrients.calories).toBe(500);
        expect(outcome.per_nutrient.calories.consensus_status).toBe(
            "all_agree",
        );
        expect(outcome.consensus_status).toBe("all_agree");
        expect(outcome.status).toBe("ready");
        expect(outcome.per_nutrient.calories.outlier_providers).toEqual([]);
    });

    test("two within 10%, third beyond -> average agreeing pair, third outlier", () => {
        const outcome = computeConsensus([
            ok("nutrition-local", { calories: 500 }),
            ok("own", { calories: 520 }), // 4% above 500
            ok("myfitnesspal", { calories: 700 }), // >10% from both
        ]);
        const calories = outcome.per_nutrient.calories;
        expect(calories.consensus_status).toBe("two_agree_one_outlier");
        expect(outcome.nutrients.calories).toBe(510);
        expect(calories.outlier_providers).toEqual(["myfitnesspal"]);
        expect(calories.eligible_providers).toEqual(["nutrition-local", "own"]);
    });

    test("exactly 10% boundary agrees; just over threshold disagrees", () => {
        // 110 is exactly 10% above 100 -> agree.
        const atBoundary = computeConsensus([
            ok("nutrition-local", { calories: 100 }),
            ok("own", { calories: 110 }),
            ok("myfitnesspal", { calories: 105 }),
        ]);
        expect(atBoundary.per_nutrient.calories.consensus_status).toBe(
            "all_agree",
        );

        // 111 is 11% above 100, and 100/111 vs 105 land it as the outlier
        // of the (100, 105) pair... use a clean just-over case instead:
        const justOver = computeConsensus([
            ok("nutrition-local", { calories: 100 }),
            ok("own", { calories: 111 }), // 11% over 100 -> disagree
            ok("myfitnesspal", { calories: 105.5 }), // 5.5% over 100, 4.95% under 111
        ]);
        // (100, 105.5) agree at 5.5%, (105.5, 111) agree at ~4.95%,
        // (100, 111) disagree at 11% -> no single outlier pair rule applies;
        // the function must pick a deterministic outcome, never crash.
        expect([
            "all_agree",
            "two_agree_one_outlier",
            "no_consensus",
        ]).toContain(justOver.per_nutrient.calories.consensus_status);

        // Clean just-over disagreement: two providers beyond threshold.
        const apart = computeConsensus([
            ok("nutrition-local", { calories: 100 }),
            ok("own", { calories: 111.0001 }),
        ]);
        expect(apart.per_nutrient.calories.consensus_status).toBe(
            "no_consensus",
        );
    });

    test("zero/near-zero denominator uses absolute epsilon, not division by zero", () => {
        const bothZero = computeConsensus([
            ok("nutrition-local", { fiber_g: 0 }),
            ok("own", { fiber_g: 0 }),
        ]);
        expect(bothZero.per_nutrient.fiber_g.consensus_status).toBe(
            "all_agree",
        );
        expect(bothZero.nutrients.fiber_g).toBe(0);

        const nearZero = computeConsensus([
            ok("nutrition-local", { fiber_g: 0 }),
            ok("own", { fiber_g: ZERO_EPSILON / 2 }),
        ]);
        expect(nearZero.per_nutrient.fiber_g.consensus_status).toBe(
            "all_agree",
        );

        const beyondEpsilon = computeConsensus([
            ok("nutrition-local", { fiber_g: 0 }),
            ok("own", { fiber_g: 0.5 }),
        ]);
        expect(beyondEpsilon.per_nutrient.fiber_g.consensus_status).toBe(
            "no_consensus",
        );
    });

    test("missing/failed results are excluded and never treated as zero", () => {
        const outcome = computeConsensus([
            ok("nutrition-local", { calories: 100 }),
            ok("own", { calories: 105 }),
            { provider: "myfitnesspal", status: "failed" },
        ]);
        const calories = outcome.per_nutrient.calories;
        expect(calories.eligible_providers).toEqual(["nutrition-local", "own"]);
        // Mean of the two real values — a failed result must not drag the
        // canonical value toward zero.
        expect(outcome.nutrients.calories).toBe(102.5);

        const nullNutrient = computeConsensus([
            ok("nutrition-local", { calories: 100 }),
            ok("own", { calories: null }),
        ]);
        expect(nullNutrient.per_nutrient.calories.eligible_providers).toEqual([
            "nutrition-local",
        ]);
        expect(nullNutrient.nutrients.calories).toBe(100);
    });

    test("three usable values with no agreeing pair -> mean of all, no_consensus", () => {
        const outcome = computeConsensus([
            ok("nutrition-local", { calories: 100 }),
            ok("own", { calories: 200 }),
            ok("myfitnesspal", { calories: 300 }),
        ]);
        const calories = outcome.per_nutrient.calories;
        expect(calories.consensus_status).toBe("no_consensus");
        expect(outcome.nutrients.calories).toBe(200);
        expect(calories.outlier_providers).toEqual([]);
        expect(calories.eligible_providers).toEqual([
            "nutrition-local",
            "own",
            "myfitnesspal",
        ]);
    });

    test("one usable result -> low_confidence, no fabricated canonical number", () => {
        const outcome = computeConsensus([
            ok("nutrition-local", { calories: 500 }),
            { provider: "own", status: "unavailable" },
            { provider: "myfitnesspal", status: "failed" },
        ]);
        expect(outcome.per_nutrient.calories.consensus_status).toBe(
            "insufficient_data",
        );
        expect(outcome.status).toBe("low_confidence");
        // The single real value is reported as-is — nothing is invented.
        expect(outcome.nutrients.calories).toBe(500);

        const none = computeConsensus([
            { provider: "nutrition-local", status: "failed" },
        ]);
        expect(none.status).toBe("pending");
        expect(none.consensus_status).toBe("insufficient_data");
        expect(none.nutrients.calories).toBeNull();
    });

    test("nutrients evaluate independently; policy metadata is emitted", () => {
        const outcome = computeConsensus([
            ok("nutrition-local", { calories: 500, protein_g: 30 }),
            ok("own", { calories: 510, protein_g: 31 }),
            ok("myfitnesspal", { calories: 700, protein_g: 32 }),
        ]);
        expect(outcome.per_nutrient.calories.consensus_status).toBe(
            "two_agree_one_outlier",
        );
        expect(outcome.per_nutrient.protein_g.consensus_status).toBe(
            "all_agree",
        );
        // fat/fiber/sugar/alcohol absent everywhere -> NULL, insufficient.
        expect(outcome.nutrients.fat_g).toBeNull();
        expect(outcome.per_nutrient.fat_g.consensus_status).toBe(
            "insufficient_data",
        );
        expect(outcome.threshold_percent).toBe(CONSENSUS_THRESHOLD_PERCENT);
        expect(outcome.policy_version).toBe(CONSENSUS_POLICY_VERSION);
        expect(outcome.outlier_providers).toContain("myfitnesspal");
        expect(outcome.eligible_providers).toEqual([
            "nutrition-local",
            "own",
            "myfitnesspal",
        ]);
    });
});

describe("slice-1 nutrient expansion", () => {
    test("canonical nutrient set includes slice-1 micronutrients, appended last", () => {
        expect(NUTRIENT_FIELDS.slice(7)).toEqual([
            "saturated_fat_g",
            "polyunsaturated_fat_g",
            "monounsaturated_fat_g",
            "trans_fat_g",
            "cholesterol_mg",
            "sodium_mg",
            "potassium_mg",
            "calcium_mg",
            "iron_mg",
            "vitamin_c_mg",
            "vitamin_a_mcg_rae",
        ]);
        const empty = emptyNutrients();
        for (const f of NUTRIENT_FIELDS) expect(empty[f]).toBeNull();
        expect(NUTRIENT_UNITS.sodium_mg).toBe("mg");
        expect(NUTRIENT_UNITS.vitamin_a_mcg_rae).toBe("mcg_rae");
        expect(NUTRIENT_UNITS.calories).toBe("kcal");
    });

    test("consensus keeps unknown micronutrients NULL and does not downgrade status", () => {
        const r = computeConsensus([
            ok("nutrition-local", { calories: 100, sodium_mg: 400 }),
            ok("own", { calories: 102 }),
        ]);
        expect(r.nutrients.sodium_mg).toBe(400); // single source, kept
        expect(r.per_nutrient.sodium_mg.consensus_status).toBe(
            "insufficient_data",
        );
        expect(r.nutrients.calcium_mg).toBeNull(); // never zero
    });
});
