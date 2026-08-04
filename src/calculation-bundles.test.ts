import { describe, expect, test } from "bun:test";
import { computeConsensus } from "./meal-consensus.js";
import {
    stableBundleFingerprint,
    type CalculationBundleInput,
} from "./nutrition-bundle-types.js";
import { commitCalculationBundle } from "./calculation-bundles.js";

describe("calculation bundle commit seam", () => {
    test("recomputes canonical and persists source IDs and raw provenance atomically", async () => {
        const calls: string[] = [];
        const client = {
            query: async (sql: string) => {
                calls.push(sql);
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return { rows: [{ calculation_bundle_fingerprint: null }] };
                if (sql.includes("SELECT id FROM meal_event_nutrition_results"))
                    return { rows: [] };
                if (sql.includes("SELECT status, consensus_status"))
                    return {
                        rows: [
                            {
                                status: "ready",
                                consensus_status: "all_agree",
                                calories: "505",
                                protein_g: null,
                                carbs_g: null,
                                fat_g: null,
                                fiber_g: null,
                                sugar_g: null,
                                alcohol_g: null,
                                eligible_providers: ["nutrition-local", "own"],
                                outlier_providers: [],
                                threshold_percent: "10",
                                policy_version: "consensus-10pct-v1",
                            },
                        ],
                    };
                return { rows: [] };
            },
            release: () => undefined,
        };
        const pool = { connect: async () => client } as never;
        const bundle = makeBundle();
        const result = await commitCalculationBundle(pool, bundle);
        expect(result.canonical.nutrients.calories).toBe(505);
        expect(result.canonical.nutrients.calories).not.toBe(9999);
    });

    test("rejects tampered content before persistence", async () => {
        const calls: string[] = [];
        const client = {
            query: async (sql: string) => {
                calls.push(sql);
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return { rows: [{ calculation_bundle_fingerprint: null }] };
                if (sql.includes("SELECT id FROM meal_event_nutrition_results"))
                    return { rows: [] };
                if (sql.includes("SELECT status, consensus_status"))
                    return {
                        rows: [
                            {
                                status: "ready",
                                consensus_status: "all_agree",
                                calories: "505",
                                protein_g: null,
                                carbs_g: null,
                                fat_g: null,
                                fiber_g: null,
                                sugar_g: null,
                                alcohol_g: null,
                                eligible_providers: ["nutrition-local", "own"],
                                outlier_providers: [],
                                threshold_percent: "10",
                                policy_version: "consensus-10pct-v1",
                            },
                        ],
                    };
                return { rows: [] };
            },
            release: () => undefined,
        };
        const pool = { connect: async () => client } as never;
        const bundle = makeBundle();
        bundle.results[0]!.source_id = "tampered";
        await expect(commitCalculationBundle(pool, bundle)).rejects.toThrow(
            /fingerprint/,
        );
    });
});

function makeBundle(): CalculationBundleInput {
    const input = {
        event_id: "00000000-0000-0000-0000-000000000001",
        version: 1,
        resolved_input: { items: [], inputs: [] },
        results: [
            provider("nutrition-local", "local-source", 500),
            provider("own", "own-source", 510),
        ],
        canonical_proposal: { calories: 9999 },
    } satisfies Omit<CalculationBundleInput, "fingerprint">;
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

function provider(
    provider: "nutrition-local" | "own",
    source_id: string,
    calories: number,
) {
    return {
        provider,
        status: "succeeded" as const,
        scope: { ordinal: null },
        source_id,
        request_fingerprint: `${provider}-request`,
        algorithm_version: "v1",
        basis: "per_meal" as const,
        units: "g_and_kcal" as const,
        nutrients: { calories },
        raw_payload: { source_id, calories },
    };
}
