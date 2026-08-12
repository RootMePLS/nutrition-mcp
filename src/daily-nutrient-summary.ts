// ============================================================================
// DAILY NUTRIENT SUMMARY (pure)
// ============================================================================
// Aggregates one local day of event-scope canonical nutrients into the
// MFP-like total/goal/remaining view, with explicit completeness so missing
// micronutrient data is reported as missing instead of disguised as zero.
// No database imports — the DB adapter lives in the MCP layer.

import {
    NUTRIENT_FIELDS,
    NUTRIENT_UNITS,
    type NutrientField,
    type Nutrients,
    type NutrientUnit,
} from "./meal-types.js";
import type { NutritionGoals } from "./db.js"; // type-only: no runtime dep
import type { Pool } from "pg";
import { zonedDayStartUtc, zonedNextDayStartUtc } from "./tz.js";

export interface MealDayRow {
    nutrients: Nutrients;
}

export type CompletenessStatus = "high" | "partial" | "low" | "none";

export interface NutrientSummaryEntry {
    key: NutrientField;
    unit: NutrientUnit;
    total: number | null;
    goal: number | null;
    remaining: number | null;
    percent_of_goal: number | null;
    completeness_status: CompletenessStatus;
    data_coverage_percent: number;
    contributing_meal_count: number;
    missing_meal_count: number;
}

export interface DailyNutrientSummary {
    meal_count: number;
    nutrients: NutrientSummaryEntry[];
    micronutrient_completeness_percent: number;
    notes: string[];
}

/** Macro-scope goals reused from nutrition_goals in slice 1 (read-only). */
export type MacroGoals = Pick<
    NutritionGoals,
    | "daily_calories"
    | "daily_protein_g"
    | "daily_carbs_g"
    | "daily_fat_g"
    | "daily_fiber_g"
    | "daily_sugar_g"
    | "daily_alcohol_g"
>;

/** Slice-1 goal mapping: existing macro goals only; micros come in Phase 3. */
const GOAL_FIELD_BY_NUTRIENT: Partial<Record<NutrientField, keyof MacroGoals>> =
    {
        calories: "daily_calories",
        protein_g: "daily_protein_g",
        carbs_g: "daily_carbs_g",
        fat_g: "daily_fat_g",
        fiber_g: "daily_fiber_g",
        sugar_g: "daily_sugar_g",
        alcohol_g: "daily_alcohol_g",
    };

const MICRONUTRIENT_FIELDS = NUTRIENT_FIELDS.slice(7) as NutrientField[];

function statusFor(contributing: number, coverage: number): CompletenessStatus {
    if (contributing === 0) return "none";
    if (coverage >= 90) return "high";
    if (coverage >= 50) return "partial";
    return "low";
}

export function summarizeDay(
    meals: MealDayRow[],
    goals: MacroGoals | null,
): DailyNutrientSummary {
    const mealCount = meals.length;
    const allHaveCalories =
        mealCount > 0 &&
        meals.every(
            (m) =>
                m.nutrients.calories != null &&
                Number.isFinite(m.nutrients.calories),
        );
    const totalCalories = allHaveCalories
        ? meals.reduce((s, m) => s + (m.nutrients.calories as number), 0)
        : 0;

    const entries: NutrientSummaryEntry[] = NUTRIENT_FIELDS.map((key) => {
        const contributing = meals.filter(
            (m) =>
                m.nutrients[key] != null && Number.isFinite(m.nutrients[key]),
        );
        const total =
            contributing.length === 0
                ? null
                : contributing.reduce(
                      (s, m) => s + (m.nutrients[key] as number),
                      0,
                  );

        let coverage = 0;
        if (mealCount > 0 && contributing.length > 0) {
            coverage =
                allHaveCalories && totalCalories > 0
                    ? Math.round(
                          (100 *
                              contributing.reduce(
                                  (s, m) =>
                                      s + (m.nutrients.calories as number),
                                  0,
                              )) /
                              totalCalories,
                      )
                    : Math.round((100 * contributing.length) / mealCount);
        }

        const goalField = GOAL_FIELD_BY_NUTRIENT[key];
        const goal = goals && goalField ? goals[goalField] : null;
        const remaining = goal != null && total != null ? goal - total : null;
        const percentOfGoal =
            goal != null && goal > 0 && total != null
                ? Math.round((total / goal) * 100)
                : null;

        return {
            key,
            unit: NUTRIENT_UNITS[key],
            total,
            goal,
            remaining,
            percent_of_goal: percentOfGoal,
            completeness_status: statusFor(contributing.length, coverage),
            data_coverage_percent: coverage,
            contributing_meal_count: contributing.length,
            missing_meal_count: mealCount - contributing.length,
        };
    });

    const microEntries = entries.filter((e) =>
        MICRONUTRIENT_FIELDS.includes(e.key),
    );
    const microCompleteness =
        microEntries.length === 0
            ? 0
            : Math.round(
                  microEntries.reduce(
                      (s, e) => s + e.data_coverage_percent,
                      0,
                  ) / microEntries.length,
              );

    const notes: string[] = [];
    const macroOnlyMicros = microEntries
        .filter((e) => e.missing_meal_count > 0 && mealCount > 0)
        .map((e) => e.key);
    if (macroOnlyMicros.length > 0) {
        const worst = Math.max(
            ...microEntries.map((e) => e.missing_meal_count),
        );
        notes.push(
            `${worst} of ${mealCount} meals were macro-only for ${macroOnlyMicros.join(", ")}`,
        );
    }

    return {
        meal_count: mealCount,
        nutrients: entries,
        micronutrient_completeness_percent: microCompleteness,
        notes,
    };
}

/**
 * Event-scope canonical nutrients for every active meal event consumed on
 * `date` (local calendar day in `tz`), at each event's current version.
 * Events whose canonical row is missing still count as meals — their
 * nutrients are all-null, which the summarizer reports as missing data.
 */
export async function getMealDayRows(
    pool: Pool,
    userId: string,
    date: string,
    tz: string,
): Promise<MealDayRow[]> {
    const start = zonedDayStartUtc(date, tz);
    const end = zonedNextDayStartUtc(date, tz);
    const cols = NUTRIENT_FIELDS.map((f) => `c.${f}`).join(", ");
    const { rows } = await pool.query(
        `SELECT ${cols}
           FROM meal_events e
           LEFT JOIN meal_event_canonical_results c
             ON c.event_id = e.id
            AND c.version = e.current_version
            AND c.ordinal IS NULL
          WHERE e.user_id = $1
            AND e.status = 'active'
            AND e.consumed_at >= $2
            AND e.consumed_at < $3
          ORDER BY e.consumed_at ASC, e.id ASC`,
        [userId, start, end],
    );
    return rows.map((row) => ({
        nutrients: Object.fromEntries(
            NUTRIENT_FIELDS.map((f) => {
                const v = row[f];
                const n = v == null ? null : Number(v);
                return [f, n != null && Number.isFinite(n) ? n : null];
            }),
        ) as Nutrients,
    }));
}
