// Ingest-time unit conversion into the canonical nutrient units. The canonical
// unit of every field is carried by its name suffix (see NUTRIENT_UNITS in
// meal-types.ts). Policy (governing doc, 2026-08-12):
//   - convert at ingest, never at render;
//   - original provider units belong in raw_payload/provenance, not here;
//   - anything ambiguous (vitamin A IU without a declared form, %DV) returns
//     null — unknown stays null, NEVER zero and NEVER a guess.

import { NUTRIENT_UNITS, type NutrientField } from "./meal-types.js";

function finiteOrNull(n: number): number | null {
    return Number.isFinite(n) ? n : null;
}

export function gToMg(g: number): number | null {
    return Number.isFinite(g) ? g * 1000 : null;
}
export function mgToG(mg: number): number | null {
    return Number.isFinite(mg) ? mg / 1000 : null;
}
export function mcgToMg(mcg: number): number | null {
    return Number.isFinite(mcg) ? mcg / 1000 : null;
}
export function mgToMcg(mg: number): number | null {
    return Number.isFinite(mg) ? mg * 1000 : null;
}

/**
 * Vitamin A IU -> mcg RAE. Only retinol has a fixed, unambiguous factor
 * (1 IU = 0.3 mcg RAE). Beta-carotene depends on dietary vs supplement
 * context, and unlabeled IU could be either — both refuse with null.
 */
export function vitaminAIuToMcgRae(
    iu: number,
    form: string | null,
): number | null {
    if (!Number.isFinite(iu)) return null;
    if (form !== "retinol") return null;
    return iu * 0.3;
}

/** Source units this module understands. Everything else refuses. */
export type SourceMassUnit = "g" | "mg" | "mcg" | "µg" | "kcal";

/**
 * Convert `value` expressed in `sourceUnit` into the canonical unit of
 * `field`. Returns null for unknown units, non-finite values, and any
 * conversion that would require a guess (IU, %DV, unit-less).
 */
export function convertToCanonical(
    field: NutrientField,
    value: number,
    sourceUnit: string,
): number | null {
    if (!Number.isFinite(value)) return null;
    const canonical = NUTRIENT_UNITS[field];
    const unit = sourceUnit === "µg" ? "mcg" : sourceUnit;
    if (unit === canonical) return finiteOrNull(value);
    if (canonical === "mg" && unit === "g") return gToMg(value);
    if (canonical === "mg" && unit === "mcg") return mcgToMg(value);
    if (canonical === "g" && unit === "mg") return mgToG(value);
    // mcg RAE: only an identity mcg mapping is safe without a declared form.
    if (canonical === "mcg_rae" && unit === "mcg") return finiteOrNull(value);
    if (canonical === "mcg_rae" && unit === "g")
        return finiteOrNull(value * 1_000_000);
    return null;
}
