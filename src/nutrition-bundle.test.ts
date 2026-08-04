import { expect, test } from "bun:test";
import {
    stableBundleFingerprint,
    validateCalculationBundle,
    type CalculationBundle,
} from "./nutrition-bundle-types.js";

const base: CalculationBundle = {
    event_id: "e",
    version: 1,
    resolved_input: { items: [], inputs: [] },
    fingerprint: "",
    results: [
        {
            provider: "own",
            status: "succeeded",
            scope: { ordinal: null },
            source_id: "own:e",
            request_fingerprint: "r",
            algorithm_version: "hermes.v1",
            basis: "per_meal",
            units: "g_and_kcal",
            nutrients: { calories: 100 },
            raw_payload: { source: "hermes" },
        },
    ],
};
base.fingerprint = stableBundleFingerprint(base);

test("calculation bundles accept supplied provider provenance", () =>
    expect(validateCalculationBundle(base)).toEqual([]));
test("calculation bundles reject non-finite values and duplicate scopes", () =>
    expect(
        validateCalculationBundle({
            ...base,
            results: [
                base.results[0]!,
                { ...base.results[0]!, nutrients: { calories: Number.NaN } },
            ],
        }),
    ).toEqual(
        expect.arrayContaining([
            "duplicate provider scope: own:event",
            "calories must be finite",
        ]),
    ));
test("bundle fingerprints are independent of provider completion order", () =>
    expect(
        stableBundleFingerprint({
            ...base,
            results: [...base.results].reverse(),
        }),
    ).toBe(base.fingerprint));
test("bundle fingerprint includes resolved input and rejects tampering", () => {
    expect(
        validateCalculationBundle({ ...base, fingerprint: "wrong" }),
    ).toContain("bundle fingerprint mismatch");
    expect(
        stableBundleFingerprint({
            ...base,
            resolved_input: { items: [{ portion: 2 }], inputs: [] },
        }),
    ).not.toBe(base.fingerprint);
});
test("failed and unavailable provider rows require honest errors", () => {
    const result = {
        ...base.results[0]!,
        status: "unavailable" as const,
        error_code: null,
        error_message: null,
    };
    expect(
        validateCalculationBundle({
            ...base,
            results: [result],
            fingerprint: stableBundleFingerprint({
                ...base,
                results: [result],
            }),
        }),
    ).toContain(
        "failed/unavailable results require error_code and error_message",
    );
});
