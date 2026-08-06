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

// ---------------------------------------------------------------------------
// Slice 4 pure layer: reuse idempotency identity equality and eligibility
// classification contracts. No DB.
// ---------------------------------------------------------------------------

import {
    classifyReuseEligibility,
    reuseIdentityMatches,
} from "./meal-reuse.js";

describe("slice 4 pure reuse helpers", () => {
    describe("reuseIdentityMatches (millisecond-equal identity)", () => {
        const stored = {
            source_event_id: "11111111-1111-1111-1111-111111111111",
            source_version: 2,
            reported_at: "2026-08-06T10:00:00.123+00:00",
            consumed_at: "2026-08-06T08:30:00.000Z",
        };

        test("identical values match", () => {
            expect(reuseIdentityMatches(stored, { ...stored })).toBe(true);
        });

        test("Z vs +00:00 ISO variants of the same instant match", () => {
            expect(
                reuseIdentityMatches(stored, {
                    ...stored,
                    reported_at: "2026-08-06T10:00:00.123Z",
                }),
            ).toBe(true);
            expect(
                reuseIdentityMatches(stored, {
                    ...stored,
                    consumed_at: "2026-08-06T08:30:00.000+00:00",
                }),
            ).toBe(true);
        });

        test("sub-millisecond precision variants of the same ms match", () => {
            // timestamptz round-trips keep microseconds; identity compares
            // Date.parse millisecond values, so sub-ms differences are inert.
            expect(
                reuseIdentityMatches(stored, {
                    ...stored,
                    reported_at: "2026-08-06T10:00:00.123456Z",
                }),
            ).toBe(true);
        });

        test("different source_event_id does not match", () => {
            expect(
                reuseIdentityMatches(stored, {
                    ...stored,
                    source_event_id: "22222222-2222-2222-2222-222222222222",
                }),
            ).toBe(false);
        });

        test("different source_version does not match", () => {
            expect(
                reuseIdentityMatches(stored, { ...stored, source_version: 1 }),
            ).toBe(false);
        });

        test("different reported_at does not match", () => {
            expect(
                reuseIdentityMatches(stored, {
                    ...stored,
                    reported_at: "2026-08-06T10:00:01.123Z",
                }),
            ).toBe(false);
        });

        test("different consumed_at does not match", () => {
            expect(
                reuseIdentityMatches(stored, {
                    ...stored,
                    consumed_at: "2026-08-06T08:30:00.001Z",
                }),
            ).toBe(false);
        });
    });

    describe("classifyReuseEligibility (deriveAggregateProvenance verdict)", () => {
        test("ready + non-compatibility is eligible", () => {
            expect(
                classifyReuseEligibility({
                    provenance_status: "ready",
                    compatibility: false,
                }),
            ).toEqual({ eligible: true });
        });

        test("compatibility wins over a ready status", () => {
            expect(
                classifyReuseEligibility({
                    provenance_status: "ready",
                    compatibility: true,
                }),
            ).toEqual({ eligible: false, category: "compatibility" });
        });

        test("compatibility wins over a pending status", () => {
            expect(
                classifyReuseEligibility({
                    provenance_status: "pending",
                    compatibility: true,
                }),
            ).toEqual({ eligible: false, category: "compatibility" });
        });

        test("pending maps to the pending category", () => {
            expect(
                classifyReuseEligibility({
                    provenance_status: "pending",
                    compatibility: false,
                }),
            ).toEqual({ eligible: false, category: "pending" });
        });

        test("unavailable maps to the unavailable category", () => {
            expect(
                classifyReuseEligibility({
                    provenance_status: "unavailable",
                    compatibility: false,
                }),
            ).toEqual({ eligible: false, category: "unavailable" });
        });

        test("missing maps to the missing category", () => {
            expect(
                classifyReuseEligibility({
                    provenance_status: "missing",
                    compatibility: false,
                }),
            ).toEqual({ eligible: false, category: "missing" });
        });
    });
});
