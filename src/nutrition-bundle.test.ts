import { describe, expect, test } from "bun:test";
import {
    stableBundleFingerprint,
    validateCalculationBundle,
    type CalculationBundle,
} from "./nutrition-bundle-types.js";

const base: CalculationBundle = {
    event_id: "e",
    version: 1,
    fingerprint: "fp",
    results: [
        {
            provider: "own",
            status: "succeeded",
            scope: { ordinal: null },
            request_fingerprint: "r",
            algorithm_version: "hermes.v1",
            basis: "per_meal",
            units: "g_and_kcal",
            nutrients: { calories: 100 },
            raw_payload: { source: "hermes" },
        },
    ],
};

test("calculation bundles accept supplied provider provenance", () =>
    expect(validateCalculationBundle(base)).toEqual([]));
test("calculation bundles reject non-finite values and duplicate scopes", () =>
    expect(
        validateCalculationBundle({
            ...base,
            results: [
                base.results[0]!,
                {
                    ...base.results[0]!,
                    provider: "own",
                    nutrients: { calories: Number.NaN },
                },
            ],
        }),
    ).toEqual(
        expect.arrayContaining([
            "duplicate provider scope: own:event",
            "calories must be finite",
        ]),
    ));
test("bundle fingerprints are independent of provider completion order", () =>
    expect(stableBundleFingerprint(base)).toBe(
        stableBundleFingerprint({
            event_id: base.event_id,
            version: base.version,
            results: [...base.results].reverse(),
        }),
    ));
