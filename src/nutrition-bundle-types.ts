import {
    NUTRIENT_FIELDS,
    isNutritionProvider,
    isProviderResultStatus,
    type NutrientField,
    type Nutrients,
    type NutritionProvider,
    type ProviderResultStatus,
} from "./meal-types.js";

export type CalculationScope = { ordinal: number | null };
export type NutrientBasis = "per_item" | "per_meal" | "per_100g" | "serving";

export interface ProviderCalculationResult {
    provider: NutritionProvider;
    status: ProviderResultStatus;
    scope: CalculationScope;
    source_id: string;
    request_fingerprint: string;
    algorithm_version: string;
    basis: NutrientBasis;
    units: "g_and_kcal";
    nutrients: Partial<Nutrients>;
    raw_payload: Record<string, unknown>;
    error_code?: string | null;
    error_message?: string | null;
}

export interface CalculationBundleInput {
    event_id: string;
    version: number;
    capture_id?: string | null;
    resolved_input: { items: unknown[]; inputs: unknown[] };
    results: ProviderCalculationResult[];
    fingerprint: string;
    canonical_proposal?: Partial<Nutrients> | null;
}

export type CalculationBundle = CalculationBundleInput;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalculationScope(value: unknown): value is CalculationScope {
    if (!isPlainJsonObject(value)) return false;
    const keys = Object.keys(value);
    const ordinal = value.ordinal;
    return (
        keys.length === 1 &&
        keys[0] === "ordinal" &&
        (ordinal === null ||
            (typeof ordinal === "number" &&
                Number.isInteger(ordinal) &&
                ordinal >= 0))
    );
}

function validateNutrients(
    nutrients: Partial<Nutrients> | null | undefined,
    errors: string[],
    prefix: string,
): void {
    if (nutrients === null || nutrients === undefined) return;
    for (const field of NUTRIENT_FIELDS) {
        const value = nutrients[field as NutrientField];
        if (value !== undefined && value !== null && !Number.isFinite(value))
            errors.push(`${prefix}${field} must be finite`);
    }
}

export function validateCalculationBundle(bundle: CalculationBundle): string[] {
    const errors: string[] = [];
    if (!isPlainJsonObject(bundle)) return ["bundle must be an object"];
    if (
        !bundle.event_id ||
        !Number.isInteger(bundle.version) ||
        bundle.version < 1
    )
        errors.push("event identity is required");
    if (!bundle.fingerprint) errors.push("bundle fingerprint is required");
    if (!Array.isArray(bundle.results))
        return [...errors, "results must be an array"];
    const seen = new Set<string>();
    for (const result of bundle.results) {
        if (!isPlainJsonObject(result)) {
            errors.push("provider result must be an object");
            continue;
        }
        if (!isCalculationScope(result.scope)) {
            errors.push("provider result scope is invalid");
            continue;
        }
        if (!isNutritionProvider(result.provider))
            errors.push(`unknown provider: ${result.provider}`);
        if (!isProviderResultStatus(result.status))
            errors.push(`invalid provider status: ${result.status}`);
        const key = `${result.provider}:${result.scope.ordinal ?? "event"}`;
        if (seen.has(key)) errors.push(`duplicate provider scope: ${key}`);
        seen.add(key);
        validateNutrients(
            isPlainJsonObject(result.nutrients)
                ? (result.nutrients as Partial<Nutrients>)
                : result.nutrients === undefined
                  ? undefined
                  : null,
            errors,
            "",
        );
        if (
            result.nutrients !== undefined &&
            result.nutrients !== null &&
            !isPlainJsonObject(result.nutrients)
        )
            errors.push("nutrients must be an object");
        if (result.status === "succeeded" && !result.request_fingerprint)
            errors.push("successful results require request fingerprints");
        if (!result.source_id) errors.push("provider source_id is required");
        if (!isPlainJsonObject(result.raw_payload))
            errors.push("raw_payload must be an object");
        if (
            result.status === "succeeded" &&
            (result.error_code || result.error_message)
        )
            errors.push("successful results cannot contain errors");
        if (
            result.status !== "succeeded" &&
            (!result.error_code || !result.error_message)
        )
            errors.push(
                "failed/unavailable results require error_code and error_message",
            );
    }
    validateNutrients(bundle.canonical_proposal, errors, "canonical proposal ");
    const expected = stableBundleFingerprint({
        event_id: bundle.event_id,
        version: bundle.version,
        capture_id: bundle.capture_id,
        resolved_input: bundle.resolved_input,
        results: bundle.results,
        canonical_proposal: bundle.canonical_proposal,
    });
    if (bundle.fingerprint !== expected)
        errors.push("bundle fingerprint mismatch");
    return errors;
}

export function stableBundleFingerprint(
    input:
        | Omit<CalculationBundleInput, "fingerprint">
        | Omit<CalculationBundle, "fingerprint">,
): string {
    const canonical = JSON.stringify({
        event_id: input.event_id,
        version: input.version,
        capture_id: input.capture_id ?? null,
        resolved_input: input.resolved_input,
        results: [...input.results].sort((a, b) =>
            `${a.provider}:${a.scope.ordinal ?? "event"}:${a.source_id}`.localeCompare(
                `${b.provider}:${b.scope.ordinal ?? "event"}:${b.source_id}`,
            ),
        ),
        canonical_proposal: input.canonical_proposal ?? null,
    });
    return `bundle:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
}
