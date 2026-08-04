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
    request_fingerprint: string;
    algorithm_version: string;
    basis: NutrientBasis;
    units: "g_and_kcal";
    nutrients: Partial<Nutrients>;
    raw_payload: Record<string, unknown>;
    error_code?: string | null;
    error_message?: string | null;
}
export interface CalculationBundle {
    event_id: string;
    version: number;
    fingerprint: string;
    results: ProviderCalculationResult[];
    canonical_proposal?: Partial<Nutrients> | null;
}

export function validateCalculationBundle(bundle: CalculationBundle): string[] {
    const errors: string[] = [];
    if (
        !bundle.event_id ||
        !Number.isInteger(bundle.version) ||
        bundle.version < 1
    )
        errors.push("event identity is required");
    if (!bundle.fingerprint) errors.push("bundle fingerprint is required");
    const seen = new Set<string>();
    for (const result of bundle.results) {
        if (!isNutritionProvider(result.provider))
            errors.push(`unknown provider: ${result.provider}`);
        if (!isProviderResultStatus(result.status))
            errors.push(`invalid provider status: ${result.status}`);
        const key = `${result.provider}:${result.scope.ordinal ?? "event"}`;
        if (seen.has(key)) errors.push(`duplicate provider scope: ${key}`);
        seen.add(key);
        for (const field of NUTRIENT_FIELDS) {
            const value = result.nutrients[field as NutrientField];
            if (
                value !== undefined &&
                value !== null &&
                !Number.isFinite(value)
            )
                errors.push(`${field} must be finite`);
        }
        if (result.status === "succeeded" && !result.request_fingerprint)
            errors.push("successful results require request fingerprints");
    }
    return errors;
}

export function stableBundleFingerprint(
    input: Omit<CalculationBundle, "fingerprint">,
): string {
    const canonical = JSON.stringify({
        event_id: input.event_id,
        version: input.version,
        results: [...input.results].sort((a, b) =>
            `${a.provider}:${a.scope.ordinal}`.localeCompare(
                `${b.provider}:${b.scope.ordinal}`,
            ),
        ),
    });
    return `bundle:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
}
