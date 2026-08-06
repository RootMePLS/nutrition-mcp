import { describe, expect, test } from "bun:test";
import { deriveReuseIdempotencyFingerprint } from "./meal-types.js";
import {
    FOOD_COMPATIBLE_NUTRIENT_KEYS,
    isSupplementProductCategory,
    normalizeSupplementAlias,
    projectIntakeVisibleState,
    validateLabelNutrients,
    validateRegimenSchedule,
    deriveSupplementIntakeIdempotencyFingerprint,
    deriveSupplementRegimenIdempotencyFingerprint,
    deriveRegimenOccurrences,
    reduceOccurrenceState,
    type RegimenSchedule,
    type SupplementRegimenIdempotencyIdentity,
    type IntakeFactForProjection,
} from "./supplement-types.js";

// Pure contracts for the supplement/sports-nutrition catalogue and meal-reuse
// substrate introduced by migration 006. No database, no MCP, no providers.

describe("supplement product category", () => {
    test("accepts exactly supplement and sports_nutrition", () => {
        expect(isSupplementProductCategory("supplement")).toBe(true);
        expect(isSupplementProductCategory("sports_nutrition")).toBe(true);
    });

    test("rejects any other category vocabulary", () => {
        for (const value of [
            "",
            "vitamin",
            "food",
            "SPORTS_NUTRITION",
            "sports-nutrition",
            "supplements",
        ]) {
            expect(isSupplementProductCategory(value)).toBe(false);
        }
    });
});

describe("label nutrients: unknown is absent, explicit zero is real data", () => {
    test("an explicit numeric zero is valid and preserved as zero", () => {
        const errors = validateLabelNutrients([
            {
                nutrient_key: "caffeine_mg",
                display_name: "Caffeine",
                amount: 0,
                unit: "mg",
            },
        ]);
        expect(errors).toEqual([]);
    });

    test("null/undefined amounts are rejected: unknown must be omitted, never stored", () => {
        const errors = validateLabelNutrients([
            { nutrient_key: "vitamin_d_iu", amount: null, unit: "iu" },
        ]);
        expect(errors.length).toBeGreaterThan(0);
        const errors2 = validateLabelNutrients([
            { nutrient_key: "vitamin_d_iu", unit: "iu" },
        ]);
        expect(errors2.length).toBeGreaterThan(0);
    });

    test("rejects negative and non-finite amounts", () => {
        for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const errors = validateLabelNutrients([
                { nutrient_key: "protein_g", amount, unit: "g" },
            ]);
            expect(errors.length).toBeGreaterThan(0);
        }
    });

    test("rejects empty nutrient keys and empty units", () => {
        expect(
            validateLabelNutrients([
                { nutrient_key: "  ", amount: 5, unit: "mg" },
            ]).length,
        ).toBeGreaterThan(0);
        expect(
            validateLabelNutrients([
                { nutrient_key: "caffeine_mg", amount: 5, unit: "" },
            ]).length,
        ).toBeGreaterThan(0);
    });

    test("rejects duplicate nutrient identity (key + unit) within one label", () => {
        const errors = validateLabelNutrients([
            { nutrient_key: "caffeine_mg", amount: 100, unit: "mg" },
            { nutrient_key: "caffeine_mg", amount: 120, unit: "mg" },
        ]);
        expect(errors.length).toBeGreaterThan(0);
    });

    test("the same key in different units is a distinct nutrient fact", () => {
        const errors = validateLabelNutrients([
            { nutrient_key: "sodium", amount: 100, unit: "mg" },
            { nutrient_key: "sodium", amount: 0.1, unit: "g" },
        ]);
        expect(errors).toEqual([]);
    });

    // Regression for reviewer-terra finding 1: identity is the tuple
    // (nutrient_key, unit), never a concatenated string. Concatenation
    // collides for valid distinct facts and must not reject them.
    test("distinct (key, unit) tuples never collide under concatenation", () => {
        const errors = validateLabelNutrients([
            { nutrient_key: "ab", amount: 1, unit: "c" },
            { nutrient_key: "a", amount: 2, unit: "bc" },
        ]);
        expect(errors).toEqual([]);
    });

    test("tuple identity is exact: only the same trimmed key AND same trimmed unit duplicates", () => {
        const errors = validateLabelNutrients([
            { nutrient_key: "ab", amount: 1, unit: "c" },
            { nutrient_key: "a", amount: 2, unit: "bc" },
            { nutrient_key: "ab", amount: 3, unit: "c" },
        ]);
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("duplicate nutrient identity");
        // A same key with a different unit is still a distinct fact.
        expect(
            validateLabelNutrients([
                { nutrient_key: "ab", amount: 1, unit: "c" },
                { nutrient_key: "ab", amount: 2, unit: "c " },
            ]).length,
        ).toBe(1);
        expect(
            validateLabelNutrients([
                { nutrient_key: "ab", amount: 1, unit: "c" },
                { nutrient_key: "ab", amount: 2, unit: "mg" },
            ]),
        ).toEqual([]);
    });

    test("malformed payloads fail safely instead of throwing", () => {
        for (const payload of [null, undefined, 42, "x", {}]) {
            expect(validateLabelNutrients(payload).length).toBeGreaterThan(0);
        }
    });

    test("food-compatible keys are the seven canonical meal fields only", () => {
        const keys: string[] = [...FOOD_COMPATIBLE_NUTRIENT_KEYS];
        expect(keys.sort()).toEqual(
            [
                "alcohol_g",
                "calories",
                "carbs_g",
                "fat_g",
                "fiber_g",
                "protein_g",
                "sugar_g",
            ].sort(),
        );
    });
});

describe("regimen schedule validation", () => {
    test("accepts a valid daily schedule", () => {
        expect(
            validateRegimenSchedule({
                timezone: "Europe/London",
                frequency: "daily",
                local_time: "08:30",
            }),
        ).toEqual([]);
    });

    test("accepts a valid weekly schedule with ISO weekdays", () => {
        expect(
            validateRegimenSchedule({
                timezone: "Europe/London",
                frequency: "weekly",
                local_time: "07:00",
                weekdays: [1, 3, 5],
            }),
        ).toEqual([]);
    });

    test("weekly requires a non-empty weekday list", () => {
        for (const weekdays of [undefined, null, []]) {
            expect(
                validateRegimenSchedule({
                    timezone: "Europe/London",
                    frequency: "weekly",
                    local_time: "07:00",
                    weekdays,
                }).length,
            ).toBeGreaterThan(0);
        }
    });

    test("daily must not carry weekdays", () => {
        expect(
            validateRegimenSchedule({
                timezone: "Europe/London",
                frequency: "daily",
                local_time: "07:00",
                weekdays: [1],
            }).length,
        ).toBeGreaterThan(0);
    });

    test("rejects invalid IANA timezones", () => {
        for (const timezone of ["", "Mars/Olympus", "GMT+25", 12, null]) {
            expect(
                validateRegimenSchedule({
                    timezone,
                    frequency: "daily",
                    local_time: "07:00",
                }).length,
            ).toBeGreaterThan(0);
        }
    });

    test("rejects malformed local times", () => {
        for (const localTime of ["", "7:00", "24:00", "12:60", " noon ", 700]) {
            expect(
                validateRegimenSchedule({
                    timezone: "UTC",
                    frequency: "daily",
                    local_time: localTime,
                }).length,
            ).toBeGreaterThan(0);
        }
        expect(
            validateRegimenSchedule({
                timezone: "UTC",
                frequency: "daily",
                local_time: "23:59",
            }),
        ).toEqual([]);
    });

    test("rejects out-of-range, fractional, or duplicate weekdays", () => {
        for (const weekdays of [[0], [8], [1.5], [1, 1], ["mon"]]) {
            expect(
                validateRegimenSchedule({
                    timezone: "UTC",
                    frequency: "weekly",
                    local_time: "07:00",
                    weekdays,
                }).length,
            ).toBeGreaterThan(0);
        }
    });
});

describe("intake state projection: visible states are exactly undefined|done|missed", () => {
    test("an absent mark projects undefined, not missed", () => {
        expect(projectIntakeVisibleState(null)).toBe("undefined");
        expect(projectIntakeVisibleState(undefined)).toBe("undefined");
    });

    test("done and missed project to themselves", () => {
        expect(projectIntakeVisibleState("done")).toBe("done");
        expect(projectIntakeVisibleState("missed")).toBe("missed");
    });

    test("cleared projects back to undefined, completing the cycle", () => {
        expect(projectIntakeVisibleState("cleared")).toBe("undefined");
    });

    test("the projected vocabulary never leaks the internal cleared action", () => {
        const projected = new Set(
            [null, "done", "missed", "cleared"].map((a) =>
                projectIntakeVisibleState(a as "done"),
            ),
        );
        expect([...projected].sort()).toEqual(["done", "missed", "undefined"]);
    });
});

describe("alias normalization", () => {
    test("trims, collapses whitespace, and lowercases case-insensitively", () => {
        expect(normalizeSupplementAlias("  Creatine   Monohydrate ")).toBe(
            "creatine monohydrate",
        );
        expect(normalizeSupplementAlias("WHEY\tGold")).toBe("whey gold");
    });

    test("normalization makes case/whitespace variants identical", () => {
        const a = normalizeSupplementAlias("Creatine Mono");
        const b = normalizeSupplementAlias("creatine   mono");
        const c = normalizeSupplementAlias("CREATINE MONO");
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    test("distinct aliases stay distinct after normalization", () => {
        expect(normalizeSupplementAlias("creatine hcl")).not.toBe(
            normalizeSupplementAlias("creatine mono"),
        );
    });

    test("empty aliases are rejected as null", () => {
        expect(normalizeSupplementAlias("")).toBeNull();
        expect(normalizeSupplementAlias("   \t  ")).toBeNull();
    });
});

describe("supplement intake idempotency identity", () => {
    const base = {
        user_id: "u1",
        idempotency_key: "intake-1",
        product_id: "11111111-1111-1111-1111-111111111111",
        product_version: 1,
        servings: 1.5,
        occurred_at: "2026-08-06T08:00:00.000Z",
        state_action: "done",
    } as const;

    test("is deterministic for identical semantic identity", () => {
        expect(deriveSupplementIntakeIdempotencyFingerprint(base)).toBe(
            deriveSupplementIntakeIdempotencyFingerprint({ ...base }),
        );
    });

    test("same key with differing identity yields a different fingerprint (conflict)", () => {
        const original = deriveSupplementIntakeIdempotencyFingerprint(base);
        const variants = [
            { ...base, product_version: 2 },
            { ...base, servings: 2 },
            { ...base, occurred_at: "2026-08-06T09:00:00.000Z" },
            { ...base, state_action: "missed" as const },
            { ...base, product_id: "22222222-2222-2222-2222-222222222222" },
            { ...base, user_id: "u2" },
        ];
        for (const variant of variants) {
            expect(
                deriveSupplementIntakeIdempotencyFingerprint(variant),
            ).not.toBe(original);
        }
    });

    test("a different key under the same user yields a different identity", () => {
        expect(
            deriveSupplementIntakeIdempotencyFingerprint({
                ...base,
                idempotency_key: "intake-2",
            }),
        ).not.toBe(deriveSupplementIntakeIdempotencyFingerprint(base));
    });
});

describe("meal reuse idempotency identity", () => {
    const base = {
        user_id: "u1",
        reuse_idempotency_key: "reuse-1",
        source_event_id: "33333333-3333-3333-3333-333333333333",
        source_version: 1,
        reported_at: "2026-08-06T12:00:00.000Z",
        consumed_at: "2026-08-06T11:30:00.000Z",
    } as const;

    test("is deterministic for identical source pair and timestamps", () => {
        expect(deriveReuseIdempotencyFingerprint(base)).toBe(
            deriveReuseIdempotencyFingerprint({ ...base }),
        );
    });

    test("same key with differing source/version/timestamps conflicts", () => {
        const original = deriveReuseIdempotencyFingerprint(base);
        const variants = [
            { ...base, source_version: 2 },
            {
                ...base,
                source_event_id: "44444444-4444-4444-4444-444444444444",
            },
            { ...base, reported_at: "2026-08-06T13:00:00.000Z" },
            { ...base, consumed_at: "2026-08-06T12:30:00.000Z" },
            { ...base, user_id: "u2" },
        ];
        for (const variant of variants) {
            expect(deriveReuseIdempotencyFingerprint(variant)).not.toBe(
                original,
            );
        }
    });

    test("reuse identity is namespaced away from create/correction fingerprints", () => {
        expect(deriveReuseIdempotencyFingerprint(base)).toMatch(/^reuse:/);
    });
});

describe("supplement regimen idempotency identity", () => {
    const schedule: RegimenSchedule = {
        timezone: "Europe/Berlin",
        frequency: "weekly",
        local_time: "08:30",
        weekdays: [1, 4],
    };
    const base: SupplementRegimenIdempotencyIdentity = {
        user_id: "u1",
        idempotency_key: "reg-key-1",
        product_id: "11111111-1111-1111-1111-111111111111",
        product_version: 2,
        dose_servings: 1.5,
        schedule,
        starts_on: "2026-08-01",
        ends_on: "2026-12-31",
    };

    test("is deterministic and namespaced", () => {
        const fp = deriveSupplementRegimenIdempotencyFingerprint(base);
        expect(fp).toBe(
            deriveSupplementRegimenIdempotencyFingerprint({ ...base }),
        );
        expect(fp).toMatch(/^supplement-regimen:/);
    });

    test("is stable across schedule object key order", () => {
        const reordered: RegimenSchedule = {
            weekdays: [1, 4],
            local_time: "08:30",
            frequency: "weekly",
            timezone: "Europe/Berlin",
        };
        expect(
            deriveSupplementRegimenIdempotencyFingerprint({
                ...base,
                schedule: reordered,
            }),
        ).toBe(deriveSupplementRegimenIdempotencyFingerprint(base));
    });

    test("same key with any differing identity field conflicts", () => {
        const original = deriveSupplementRegimenIdempotencyFingerprint(base);
        const variants: SupplementRegimenIdempotencyIdentity[] = [
            { ...base, user_id: "u2" },
            { ...base, idempotency_key: "reg-key-2" },
            {
                ...base,
                product_id: "22222222-2222-2222-2222-222222222222",
            },
            { ...base, product_version: 3 },
            { ...base, dose_servings: 2 },
            { ...base, schedule: { ...schedule, local_time: "09:00" } },
            { ...base, schedule: { ...schedule, frequency: "daily" } },
            { ...base, schedule: { ...schedule, weekdays: [2] } },
            { ...base, starts_on: "2026-08-02" },
            { ...base, ends_on: null },
            { ...base, ends_on: "2026-11-30" },
        ];
        for (const variant of variants) {
            expect(
                deriveSupplementRegimenIdempotencyFingerprint(variant),
            ).not.toBe(original);
        }
    });
});

describe("regimen occurrence derivation (pure, bounded, tz-aware)", () => {
    const daily: RegimenSchedule = {
        timezone: "Europe/Berlin",
        frequency: "daily",
        local_time: "08:00",
    };

    test("daily schedule yields every date in the effective range", () => {
        const occurrences = deriveRegimenOccurrences(
            daily,
            "2026-08-01",
            null,
            "2026-08-01",
            "2026-08-05",
        );
        expect(occurrences.map((o) => o.local_date)).toEqual([
            "2026-08-01",
            "2026-08-02",
            "2026-08-03",
            "2026-08-04",
            "2026-08-05",
        ]);
        for (const o of occurrences) {
            expect(o.local_time).toBe("08:00");
        }
    });

    test("effective range is window intersected with [starts_on, ends_on]", () => {
        // starts_on inside the window clips the front.
        expect(
            deriveRegimenOccurrences(
                daily,
                "2026-08-03",
                null,
                "2026-08-01",
                "2026-08-05",
            ).map((o) => o.local_date),
        ).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
        // ends_on inside the window clips the tail.
        expect(
            deriveRegimenOccurrences(
                daily,
                "2026-08-01",
                "2026-08-03",
                "2026-08-01",
                "2026-08-05",
            ).map((o) => o.local_date),
        ).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    });

    test("an inverted effective range yields zero occurrences", () => {
        expect(
            deriveRegimenOccurrences(
                daily,
                "2026-08-10",
                null,
                "2026-08-01",
                "2026-08-05",
            ),
        ).toEqual([]);
        expect(
            deriveRegimenOccurrences(
                daily,
                "2026-08-01",
                "2026-08-02",
                "2026-08-03",
                "2026-08-05",
            ),
        ).toEqual([]);
    });

    test("weekly schedule keeps only listed ISO weekdays (1 = Monday)", () => {
        // 2026-08-03 is a Monday, 2026-08-06 a Thursday, 2026-08-08 a Saturday.
        const weekly: RegimenSchedule = {
            timezone: "UTC",
            frequency: "weekly",
            local_time: "21:15",
            weekdays: [1, 6],
        };
        const occurrences = deriveRegimenOccurrences(
            weekly,
            "2026-08-01",
            null,
            "2026-08-03",
            "2026-08-09",
        );
        expect(occurrences.map((o) => o.local_date)).toEqual([
            "2026-08-03",
            "2026-08-08",
        ]);
        expect(occurrences[0]!.local_time).toBe("21:15");
    });

    test("a DST-transition local date still yields exactly one occurrence", () => {
        // Europe/Berlin springs forward on 2026-03-29 and falls back on
        // 2026-10-25; each local date must appear exactly once either way.
        const spring = deriveRegimenOccurrences(
            daily,
            "2026-03-27",
            null,
            "2026-03-27",
            "2026-03-31",
        );
        expect(spring.map((o) => o.local_date)).toEqual([
            "2026-03-27",
            "2026-03-28",
            "2026-03-29",
            "2026-03-30",
            "2026-03-31",
        ]);
        const autumn = deriveRegimenOccurrences(
            daily,
            "2026-10-24",
            null,
            "2026-10-24",
            "2026-10-27",
        );
        expect(autumn.map((o) => o.local_date)).toEqual([
            "2026-10-24",
            "2026-10-25",
            "2026-10-26",
            "2026-10-27",
        ]);
    });
});

describe("occurrence state reduction (latest fact wins by append order)", () => {
    function fact(
        id: string,
        state_action: "done" | "missed" | "cleared",
        created_at: string,
    ): IntakeFactForProjection {
        return {
            id,
            regimen_id: "reg-1",
            occurred_at: "2026-08-06T08:00:00.000Z",
            state_action,
            created_at,
        };
    }

    test("no facts projects undefined (an absent mark is never missed)", () => {
        expect(reduceOccurrenceState([])).toBe("undefined");
    });

    test("a single done or missed fact projects itself", () => {
        expect(
            reduceOccurrenceState([fact("a", "done", "2026-08-06T08:00:00Z")]),
        ).toBe("done");
        expect(
            reduceOccurrenceState([
                fact("a", "missed", "2026-08-06T08:00:00Z"),
            ]),
        ).toBe("missed");
    });

    test("done then cleared projects undefined (the cycle returns)", () => {
        expect(
            reduceOccurrenceState([
                fact("a", "done", "2026-08-06T08:00:00Z"),
                fact("b", "cleared", "2026-08-06T09:00:00Z"),
            ]),
        ).toBe("undefined");
    });

    test("done then missed projects missed; missed then cleared returns to undefined", () => {
        expect(
            reduceOccurrenceState([
                fact("a", "done", "2026-08-06T08:00:00Z"),
                fact("b", "missed", "2026-08-06T09:00:00Z"),
            ]),
        ).toBe("missed");
        expect(
            reduceOccurrenceState([
                fact("a", "done", "2026-08-06T08:00:00Z"),
                fact("b", "missed", "2026-08-06T09:00:00Z"),
                fact("c", "cleared", "2026-08-06T10:00:00Z"),
            ]),
        ).toBe("undefined");
    });

    test("append order, not input order, decides the latest fact", () => {
        expect(
            reduceOccurrenceState([
                fact("b", "cleared", "2026-08-06T09:00:00Z"),
                fact("a", "done", "2026-08-06T08:00:00Z"),
            ]),
        ).toBe("undefined");
    });

    test("equal created_at breaks the tie by id (higher id is later)", () => {
        expect(
            reduceOccurrenceState([
                fact("b", "missed", "2026-08-06T09:00:00Z"),
                fact("a", "done", "2026-08-06T09:00:00Z"),
            ]),
        ).toBe("missed");
        expect(
            reduceOccurrenceState([
                fact("b", "done", "2026-08-06T09:00:00Z"),
                fact("a", "missed", "2026-08-06T09:00:00Z"),
            ]),
        ).toBe("done");
    });

    test("the projection vocabulary never emits cleared", () => {
        const states = [
            reduceOccurrenceState([]),
            reduceOccurrenceState([
                fact("a", "cleared", "2026-08-06T08:00:00Z"),
            ]),
            reduceOccurrenceState([
                fact("a", "done", "2026-08-06T08:00:00Z"),
                fact("b", "cleared", "2026-08-06T09:00:00Z"),
            ]),
        ];
        for (const state of states) {
            expect(["undefined", "done", "missed"]).toContain(state);
        }
    });
});
