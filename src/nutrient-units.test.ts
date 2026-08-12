import { describe, expect, test } from "bun:test";
import {
    gToMg,
    mgToG,
    mcgToMg,
    mgToMcg,
    vitaminAIuToMcgRae,
    convertToCanonical,
} from "./nutrient-units.js";

describe("mass conversions", () => {
    test("g <-> mg round trip", () => {
        expect(gToMg(1.85)).toBeCloseTo(1850);
        expect(mgToG(1850)).toBeCloseTo(1.85);
        expect(mgToG(gToMg(0.4)!)).toBeCloseTo(0.4);
    });
    test("mcg <-> mg", () => {
        expect(mcgToMg(900)).toBeCloseTo(0.9);
        expect(mgToMcg(0.9)).toBeCloseTo(900);
    });
    test("non-finite input returns null, never 0", () => {
        expect(gToMg(Number.NaN)).toBeNull();
        expect(mgToG(Infinity)).toBeNull();
    });
});

describe("vitamin A", () => {
    test("IU with declared retinol form converts at 0.3", () => {
        expect(vitaminAIuToMcgRae(3000, "retinol")).toBeCloseTo(900);
    });
    test("IU with unknown form refuses (null)", () => {
        expect(vitaminAIuToMcgRae(3000, null)).toBeNull();
        expect(vitaminAIuToMcgRae(3000, "unknown")).toBeNull();
    });
});

describe("convertToCanonical", () => {
    test("routes by canonical unit", () => {
        expect(convertToCanonical("sodium_mg", 1.2, "g")).toBeCloseTo(1200);
        expect(convertToCanonical("sodium_mg", 740, "mg")).toBe(740);
        expect(convertToCanonical("vitamin_a_mcg_rae", 750, "mcg")).toBe(750);
        expect(convertToCanonical("saturated_fat_g", 4.5, "g")).toBe(4.5);
    });
    test("unknown/ambiguous unit refuses (null)", () => {
        expect(convertToCanonical("vitamin_a_mcg_rae", 3000, "IU")).toBeNull();
        expect(convertToCanonical("sodium_mg", 50, "%DV")).toBeNull();
        expect(convertToCanonical("sodium_mg", 50, "")).toBeNull();
    });
});
