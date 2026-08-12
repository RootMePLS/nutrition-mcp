import { describe, expect, test } from "bun:test";
import { summarizeDay, type MealDayRow } from "./daily-nutrient-summary.js";
import { emptyNutrients } from "./meal-types.js";

function meal(
    overrides: Partial<ReturnType<typeof emptyNutrients>>,
): MealDayRow {
    return { nutrients: { ...emptyNutrients(), ...overrides } };
}

describe("totals", () => {
    test("sums only non-null values; all-null nutrient totals null, not 0", () => {
        const s = summarizeDay(
            [meal({ calories: 500, sodium_mg: 800 }), meal({ calories: 600 })],
            null,
        );
        const sodium = s.nutrients.find((n) => n.key === "sodium_mg")!;
        expect(sodium.total).toBe(800);
        const calcium = s.nutrients.find((n) => n.key === "calcium_mg")!;
        expect(calcium.total).toBeNull();
        expect(calcium.completeness_status).toBe("none");
    });
    test("empty day yields full payload with nulls", () => {
        const s = summarizeDay([], null);
        expect(s.meal_count).toBe(0);
        for (const n of s.nutrients) {
            expect(n.total).toBeNull();
            expect(n.completeness_status).toBe("none");
            expect(n.data_coverage_percent).toBe(0);
        }
    });
});

describe("coverage & completeness", () => {
    test("calorie-weighted coverage when all meals have calories", () => {
        // 1800 kcal day; sodium known for the 1200 kcal of it -> 67%
        const s = summarizeDay(
            [meal({ calories: 1200, sodium_mg: 900 }), meal({ calories: 600 })],
            null,
        );
        const sodium = s.nutrients.find((n) => n.key === "sodium_mg")!;
        expect(sodium.data_coverage_percent).toBe(67);
        expect(sodium.completeness_status).toBe("partial");
        expect(sodium.contributing_meal_count).toBe(1);
        expect(sodium.missing_meal_count).toBe(1);
    });
    test("meal-count coverage when any meal lacks calories", () => {
        const s = summarizeDay(
            [meal({ sodium_mg: 500 }), meal({ calories: 400 })],
            null,
        );
        expect(
            s.nutrients.find((n) => n.key === "sodium_mg")!
                .data_coverage_percent,
        ).toBe(50);
    });
    test("status bands: >=90 high, >=50 partial, >0 low, 0 none", () => {
        const many = [
            ...Array.from({ length: 9 }, () =>
                meal({ calories: 100, iron_mg: 2 }),
            ),
            meal({ calories: 100 }),
        ];
        expect(
            summarizeDay(many, null).nutrients.find((n) => n.key === "iron_mg")!
                .completeness_status,
        ).toBe("high");
        const one = [
            meal({ calories: 100, iron_mg: 2 }),
            meal({ calories: 100 }),
            meal({ calories: 100 }),
        ];
        expect(
            summarizeDay(one, null).nutrients.find((n) => n.key === "iron_mg")!
                .completeness_status,
        ).toBe("low");
    });
    test("macro-only meal is never counted micronutrient-complete", () => {
        const s = summarizeDay([meal({ calories: 700, protein_g: 30 })], null);
        expect(s.micronutrient_completeness_percent).toBe(0);
    });
});

describe("goals", () => {
    const goals = {
        daily_calories: 2200,
        daily_protein_g: 160,
        daily_carbs_g: null,
        daily_fat_g: null,
        daily_fiber_g: null,
        daily_sugar_g: null,
        daily_alcohol_g: null,
    };
    test("remaining and percent_of_goal; micros have null goals in slice 1", () => {
        const s = summarizeDay(
            [meal({ calories: 1774, protein_g: 96, sodium_mg: 1850 })],
            goals as never,
        );
        const cal = s.nutrients.find((n) => n.key === "calories")!;
        expect(cal.goal).toBe(2200);
        expect(cal.remaining).toBe(426);
        expect(cal.percent_of_goal).toBe(81);
        const sodium = s.nutrients.find((n) => n.key === "sodium_mg")!;
        expect(sodium.goal).toBeNull();
        expect(sodium.remaining).toBeNull();
        expect(sodium.percent_of_goal).toBeNull();
    });
    test("over-goal remaining goes negative, not clamped", () => {
        const s = summarizeDay([meal({ calories: 2500 })], goals as never);
        expect(s.nutrients.find((n) => n.key === "calories")!.remaining).toBe(
            -300,
        );
    });
});
