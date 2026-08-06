import { describe, expect, test } from "bun:test";
import { normalizeDescription } from "./search.js";
import {
    MAX_REUSE_CANDIDATES,
    MAX_REUSE_VARIATIONS,
    rankReuseVariations,
    REUSE_WINDOW_DAYS,
} from "./meal-reuse.js";

// ---------------------------------------------------------------------------
// Slice 3 pure layer: lexical variation grouping/ranking contract. No DB.
// ---------------------------------------------------------------------------

function match(id: string, description: string, logged_at: string) {
    return { id, description, logged_at };
}

describe("normalizeDescription (exported from search.ts)", () => {
    test("normalizes case, whitespace, and trailing punctuation", () => {
        expect(normalizeDescription(" OATMEAL  with raisins. ")).toBe(
            "oatmeal with raisins",
        );
        expect(normalizeDescription("Soup!!")).toBe("soup");
        expect(normalizeDescription("rice,   beans")).toBe("rice, beans");
    });
});

describe("reuse constants", () => {
    test("locked 90-day / 10-variation / 2-candidate contract", () => {
        expect(REUSE_WINDOW_DAYS).toBe(90);
        expect(MAX_REUSE_VARIATIONS).toBe(10);
        expect(MAX_REUSE_CANDIDATES).toBe(2);
    });
});

describe("rankReuseVariations", () => {
    test("groups by normalizeDescription key (case/whitespace/punct collapse)", () => {
        const ranked = rankReuseVariations([
            match("a", "Oatmeal with raisins", "2026-08-01T08:00:00.000Z"),
            match("b", " oatmeal  WITH raisins. ", "2026-08-02T08:00:00.000Z"),
            match("c", "oatmeal with banana", "2026-08-03T08:00:00.000Z"),
        ]);
        expect(ranked).toHaveLength(2);
        const raisins = ranked.find((v) => v.key === "oatmeal with raisins")!;
        const banana = ranked.find((v) => v.key === "oatmeal with banana")!;
        expect(raisins.count).toBe(2);
        expect(banana.count).toBe(1);
        // Label is the newest occurrence's rendered description.
        expect(raisins.label).toBe(" oatmeal  WITH raisins. ");
    });

    test("frequency desc; equal counts tie-break by newer lastConsumedAt", () => {
        const ranked = rankReuseVariations([
            match("a", "soup", "2026-07-01T12:00:00.000Z"),
            match("b", "salad", "2026-08-01T12:00:00.000Z"),
            match("c", "salad", "2026-08-02T12:00:00.000Z"),
            match("d", "soup", "2026-07-02T12:00:00.000Z"),
        ]);
        expect(ranked.map((v) => v.key)).toEqual(["salad", "soup"]);
        expect(ranked[0]!.count).toBe(2);
        expect(ranked[0]!.lastConsumedAt).toBe("2026-08-02T12:00:00.000Z");
        const tied = rankReuseVariations([
            match("a", "older", "2026-07-01T12:00:00.000Z"),
            match("b", "newer", "2026-08-01T12:00:00.000Z"),
        ]);
        expect(tied.map((v) => v.key)).toEqual(["newer", "older"]);
    });

    test("candidateIds: at most 2, newest logged_at first, id tie-break", () => {
        const ranked = rankReuseVariations([
            match("id-3", "soup", "2026-08-03T12:00:00.000Z"),
            match("id-1", "soup", "2026-08-01T12:00:00.000Z"),
            match("id-2", "soup", "2026-08-02T12:00:00.000Z"),
            // Same timestamp as id-2: deterministic tie-break by id desc.
            match("id-9", "soup", "2026-08-02T12:00:00.000Z"),
        ]);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]!.candidateIds).toEqual(["id-3", "id-9"]);
    });

    test("variation cap: 11 distinct variations in -> 10 out; override works", () => {
        const matches = Array.from({ length: 11 }, (_, i) =>
            match(
                `id-${i}`,
                `variation ${i}`,
                `2026-08-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`,
            ),
        );
        const ranked = rankReuseVariations(matches);
        expect(ranked).toHaveLength(10);
        const uncapped = rankReuseVariations(matches, { maxVariations: 11 });
        expect(uncapped).toHaveLength(11);
        // candidate cap override
        const many = rankReuseVariations(
            [
                match("a", "soup", "2026-08-01T12:00:00.000Z"),
                match("b", "soup", "2026-08-02T12:00:00.000Z"),
                match("c", "soup", "2026-08-03T12:00:00.000Z"),
            ],
            { maxCandidates: 1 },
        );
        expect(many[0]!.candidateIds).toEqual(["c"]);
    });

    test("empty input -> []", () => {
        expect(rankReuseVariations([])).toEqual([]);
    });
});
