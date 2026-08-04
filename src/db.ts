import { Pool, type PoolClient } from "pg";
import { zonedDayStartUtc, zonedNextDayStartUtc } from "./tz.js";
import { decodeEscapeSequences } from "./normalize.js";
import { isWeightUnit, toStoredInteger, type WeightUnit } from "./units.js";
import { isDrinkUnit, type DrinkUnit } from "./alcohol.js";
import { escapeLikePattern, tokenizeQuery } from "./search.js";
import { existsSync, unlinkSync } from "node:fs";

// ============================================================================
// CONNECTION POOL & SINGLE USER
// ============================================================================

export const SINGLE_USER_ID = "00000000-0000-0000-0000-000000000001";

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export function getPool(): Pool {
    return pool;
}

// Graceful shutdown: call pool.end() before process exit.
export async function closePool(): Promise<void> {
    await pool.end();
}

// Narrowly scoped transaction helper for the append-only food-tracking model
// (src/meal-events.ts). Takes the pool explicitly so integration tests can
// point at a scratch database; legacy code above keeps using `pool` directly.
export async function withTransaction<T>(
    targetPool: Pool,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await targetPool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

// ============================================================================
// IDEMPOTENCY
// ============================================================================

function deriveIdempotencyKey(
    parts: (string | number | null | undefined)[],
): string {
    const digest = new Bun.CryptoHasher("sha256")
        .update(parts.map((p) => p ?? "").join("\u0000"))
        .digest("hex");
    return `auto:${digest}`;
}

// ============================================================================
// TYPES
// ============================================================================

export interface Meal {
    id: string;
    user_id: string;
    logged_at: string;
    meal_type: string | null;
    description: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;
    alcohol_g: number | null;
    notes: string | null;
    idempotency_key: string | null;
}

export interface MealInput {
    description: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number;
    sugar_g?: number;
    alcohol_g?: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface MealInsertResult {
    meal: Meal;
    deduplicated: boolean;
}

// ============================================================================
// TYPE COERCION HELPERS
// ============================================================================

// pg returns numeric/integer columns as strings; cast to number.
function num(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function mealFromRow(row: Record<string, unknown>): Meal {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        logged_at: (row.logged_at instanceof Date
            ? row.logged_at.toISOString()
            : String(row.logged_at)) as string,
        meal_type: (row.meal_type as string | null) ?? null,
        description: row.description as string,
        calories: num(row.calories),
        protein_g: num(row.protein_g),
        carbs_g: num(row.carbs_g),
        fat_g: num(row.fat_g),
        fiber_g: num(row.fiber_g),
        sugar_g: num(row.sugar_g),
        alcohol_g: num(row.alcohol_g),
        notes: (row.notes as string | null) ?? null,
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

// ============================================================================
// MEALS
// ============================================================================

export function mealIdempotencyKey(
    userId: string,
    input: MealInput,
    loggedAt: string,
): string {
    return deriveIdempotencyKey([
        userId,
        input.description,
        input.meal_type,
        input.calories,
        input.protein_g,
        input.carbs_g,
        input.fat_g,
        input.notes,
        loggedAt,
    ]);
}

export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<MealInsertResult> {
    const meal: MealInput =
        input.calories == null
            ? input
            : { ...input, calories: toStoredInteger(input.calories) };

    const loggedAt = meal.logged_at ?? new Date().toISOString();
    const idempotencyKey =
        meal.idempotency_key ?? mealIdempotencyKey(userId, meal, loggedAt);

    // Check for existing meal with same idempotency key.
    {
        const { rows } = await pool.query(
            `SELECT * FROM meals WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, idempotencyKey],
        );
        if (rows.length > 0) {
            return { meal: mealFromRow(rows[0]!), deduplicated: true };
        }
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO meals
                (user_id, description, meal_type, calories, protein_g, carbs_g, fat_g,
                 fiber_g, sugar_g, alcohol_g, logged_at, notes, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [
                userId,
                decodeEscapeSequences(meal.description),
                meal.meal_type,
                meal.calories ?? null,
                meal.protein_g ?? null,
                meal.carbs_g ?? null,
                meal.fat_g ?? null,
                meal.fiber_g ?? null,
                meal.sugar_g ?? null,
                meal.alcohol_g ?? null,
                loggedAt,
                meal.notes != null ? decodeEscapeSequences(meal.notes) : null,
                idempotencyKey,
            ],
        );
        return { meal: mealFromRow(rows[0]!), deduplicated: false };
    } catch (error) {
        // 23505: concurrent retry with same idempotency key.
        if ((error as { code?: string }).code === "23505") {
            const { rows } = await pool.query(
                `SELECT * FROM meals WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, idempotencyKey],
            );
            if (rows.length > 0) {
                return { meal: mealFromRow(rows[0]!), deduplicated: true };
            }
        }
        throw new Error(
            `Failed to insert meal: ${(error as Error).message}`,
        );
    }
}

export async function getMealsByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    const startUtc = zonedDayStartUtc(date, tz);
    const endUtc = zonedNextDayStartUtc(date, tz);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM meals
             WHERE user_id = $1 AND logged_at >= $2 AND logged_at < $3
             ORDER BY logged_at ASC`,
            [userId, startUtc.toISOString(), endUtc.toISOString()],
        );
        return rows.map(mealFromRow);
    } catch (error) {
        throw new Error(`Failed to get meals: ${(error as Error).message}`);
    }
}

export async function getMealsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM meals
             WHERE user_id = $1 AND logged_at >= $2 AND logged_at < $3
             ORDER BY logged_at ASC`,
            [userId, startUtc.toISOString(), endUtc.toISOString()],
        );
        return rows.map(mealFromRow);
    } catch (error) {
        throw new Error(`Failed to get meals: ${(error as Error).message}`);
    }
}

export async function countMeals(userId: string): Promise<number> {
    try {
        const { rows } = await pool.query(
            `SELECT count(*)::int AS count FROM meals WHERE user_id = $1`,
            [userId],
        );
        return (rows[0] as { count: number }).count ?? 0;
    } catch (error) {
        throw new Error(`Failed to count meals: ${(error as Error).message}`);
    }
}

export async function existingIdempotencyKeys(
    userId: string,
    keys: string[],
): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    try {
        const { rows } = await pool.query(
            `SELECT idempotency_key FROM meals
             WHERE user_id = $1 AND idempotency_key = ANY($2::text[])`,
            [userId, keys],
        );
        return new Set(
            rows
                .map((r: { idempotency_key: string | null }) => r.idempotency_key)
                .filter((k: string | null): k is string => k !== null),
        );
    } catch (error) {
        throw new Error(
            `Failed to check existing meals: ${(error as Error).message}`,
        );
    }
}

export async function fetchAllPages<T>(
    fetchPage: (offset: number, limit: number) => Promise<T[]>,
    pageSize = 1000,
): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
        const page = await fetchPage(offset, pageSize);
        all.push(...page);
        if (page.length < pageSize) break;
    }
    return all;
}

export async function getAllMeals(userId: string): Promise<Meal[]> {
    const expected = await countMeals(userId);
    if (expected === 0) return [];

    const meals = await fetchAllPages<Meal>(async (offset, limit) => {
        const { rows } = await pool.query(
            `SELECT * FROM meals
             WHERE user_id = $1
             ORDER BY logged_at ASC, id ASC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset],
        );
        return rows.map(mealFromRow);
    });

    if (meals.length < expected) {
        throw new Error(
            `getAllMeals: fetched ${meals.length} meals but countMeals reported ${expected} — export would be truncated`,
        );
    }
    return meals;
}

export async function searchMeals(
    userId: string,
    queries: string[],
    opts: { limit?: number; sinceIso?: string } = {},
): Promise<Meal[]> {
    const limit = opts.limit ?? 50;
    const tokenized = queries
        .map(tokenizeQuery)
        .filter((tokens) => tokens.length > 0);
    if (tokenized.length === 0) return [];

    const buildQuery = async (
        tokens: string[],
        column: "description" | "notes",
    ): Promise<Meal[]> => {
        const params: unknown[] = [userId];
        const conditions: string[] = ["user_id = $1"];

        let paramIdx = 2;
        if (opts.sinceIso) {
            conditions.push(`logged_at >= $${paramIdx}`);
            params.push(opts.sinceIso);
            paramIdx++;
        }

        for (const token of tokens) {
            conditions.push(`${column} ILIKE $${paramIdx}`);
            params.push(`%${escapeLikePattern(token)}%`);
            paramIdx++;
        }

        const sql = `SELECT * FROM meals WHERE ${conditions.join(" AND ")}
                     ORDER BY logged_at DESC LIMIT $${paramIdx}`;
        params.push(limit);

        const { rows } = await pool.query(sql, params);
        return rows.map(mealFromRow);
    };

    const results = await Promise.all(
        tokenized.flatMap((tokens) => [
            buildQuery(tokens, "description"),
            buildQuery(tokens, "notes"),
        ]),
    );

    const seen = new Set<string>();
    const merged: Meal[] = [];
    for (const meals of results) {
        for (const meal of meals) {
            if (!seen.has(meal.id)) {
                seen.add(meal.id);
                merged.push(meal);
            }
        }
    }
    merged.sort((a, b) => b.logged_at.localeCompare(a.logged_at));
    return merged.slice(0, limit);
}

export async function deleteMeal(userId: string, id: string): Promise<void> {
    try {
        await pool.query(
            `DELETE FROM meals WHERE id = $1 AND user_id = $2`,
            [id, userId],
        );
    } catch (error) {
        throw new Error(`Failed to delete meal: ${(error as Error).message}`);
    }
}

export async function updateMeal(
    userId: string,
    id: string,
    fields: Partial<MealInput>,
): Promise<Meal> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (fields.description !== undefined) {
        setClauses.push(`description = $${paramIdx}`);
        params.push(decodeEscapeSequences(fields.description));
        paramIdx++;
    }
    if (fields.meal_type !== undefined) {
        setClauses.push(`meal_type = $${paramIdx}`);
        params.push(fields.meal_type);
        paramIdx++;
    }
    if (fields.calories !== undefined) {
        setClauses.push(`calories = $${paramIdx}`);
        params.push(toStoredInteger(fields.calories));
        paramIdx++;
    }
    if (fields.protein_g !== undefined) {
        setClauses.push(`protein_g = $${paramIdx}`);
        params.push(fields.protein_g);
        paramIdx++;
    }
    if (fields.carbs_g !== undefined) {
        setClauses.push(`carbs_g = $${paramIdx}`);
        params.push(fields.carbs_g);
        paramIdx++;
    }
    if (fields.fat_g !== undefined) {
        setClauses.push(`fat_g = $${paramIdx}`);
        params.push(fields.fat_g);
        paramIdx++;
    }
    if (fields.fiber_g !== undefined) {
        setClauses.push(`fiber_g = $${paramIdx}`);
        params.push(fields.fiber_g);
        paramIdx++;
    }
    if (fields.sugar_g !== undefined) {
        setClauses.push(`sugar_g = $${paramIdx}`);
        params.push(fields.sugar_g);
        paramIdx++;
    }
    if (fields.alcohol_g !== undefined) {
        setClauses.push(`alcohol_g = $${paramIdx}`);
        params.push(fields.alcohol_g);
        paramIdx++;
    }
    if (fields.logged_at !== undefined) {
        setClauses.push(`logged_at = $${paramIdx}`);
        params.push(fields.logged_at);
        paramIdx++;
    }
    if (fields.notes !== undefined) {
        setClauses.push(`notes = $${paramIdx}`);
        params.push(
            fields.notes != null
                ? decodeEscapeSequences(fields.notes)
                : fields.notes,
        );
        paramIdx++;
    }

    if (setClauses.length === 0) {
        // Nothing to update — return the existing row.
        const { rows } = await pool.query(
            `SELECT * FROM meals WHERE id = $1 AND user_id = $2`,
            [id, userId],
        );
        if (rows.length === 0) {
            throw new Error("Meal not found");
        }
        return mealFromRow(rows[0]!);
    }

    params.push(id, userId);
    const sql = `UPDATE meals SET ${setClauses.join(", ")}
                 WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}
                 RETURNING *`;

    try {
        const { rows } = await pool.query(sql, params);
        if (rows.length === 0) {
            throw new Error("Meal not found");
        }
        return mealFromRow(rows[0]!);
    } catch (error) {
        throw new Error(`Failed to update meal: ${(error as Error).message}`);
    }
}

// ============================================================================
// PROFILES
// ============================================================================

export interface Profile {
    user_id: string;
    timezone: string;
    preferred_weight_unit: WeightUnit | null;
    widgets_enabled: boolean;
    alcohol_tracking_enabled: boolean;
    preferred_drink_unit: DrinkUnit | null;
    created_at: string;
    updated_at: string;
}

function profileFromRow(row: Record<string, unknown>): Profile {
    const wu = row.preferred_weight_unit;
    const du = row.preferred_drink_unit;
    return {
        user_id: row.user_id as string,
        timezone: (row.timezone as string) ?? "UTC",
        preferred_weight_unit: isWeightUnit(wu) ? (wu as WeightUnit) : null,
        widgets_enabled: (row.widgets_enabled as boolean) ?? true,
        alcohol_tracking_enabled:
            (row.alcohol_tracking_enabled as boolean) ?? false,
        preferred_drink_unit: isDrinkUnit(du) ? (du as DrinkUnit) : null,
        created_at: (row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at)),
        updated_at: (row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : String(row.updated_at)),
    };
}

export async function getProfile(userId: string): Promise<Profile | null> {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM profiles WHERE user_id = $1`,
            [userId],
        );
        if (rows.length === 0) return null;
        return profileFromRow(rows[0]!);
    } catch (error) {
        throw new Error(`Failed to get profile: ${(error as Error).message}`);
    }
}

export async function getUserTimezone(userId: string): Promise<string> {
    const profile = await getProfile(userId);
    return profile?.timezone ?? "UTC";
}

export async function getPreferredWeightUnit(
    userId: string,
): Promise<WeightUnit | null> {
    const profile = await getProfile(userId);
    const unit = profile?.preferred_weight_unit;
    return isWeightUnit(unit) ? unit : null;
}

export function widgetsEnabledFromProfile(
    profile: Profile | null | undefined,
): boolean {
    return profile?.widgets_enabled ?? true;
}

export async function getWidgetsEnabled(userId: string): Promise<boolean> {
    return widgetsEnabledFromProfile(await getProfile(userId));
}

export function alcoholTrackingEnabledFromProfile(
    profile: Profile | null | undefined,
): boolean {
    return profile?.alcohol_tracking_enabled ?? false;
}

export async function getAlcoholTrackingEnabled(
    userId: string,
): Promise<boolean> {
    return alcoholTrackingEnabledFromProfile(await getProfile(userId));
}

export function preferredDrinkUnitFromProfile(
    profile: Profile | null | undefined,
): DrinkUnit | null {
    const unit = profile?.preferred_drink_unit;
    return isDrinkUnit(unit) ? unit : null;
}

export async function getPreferredDrinkUnit(
    userId: string,
): Promise<DrinkUnit | null> {
    return preferredDrinkUnitFromProfile(await getProfile(userId));
}

export async function upsertProfile(
    userId: string,
    patch: {
        timezone?: string;
        preferred_weight_unit?: WeightUnit | null;
        widgets_enabled?: boolean;
        alcohol_tracking_enabled?: boolean;
        preferred_drink_unit?: DrinkUnit | null;
    },
): Promise<Profile> {
    try {
        const { rows } = await pool.query(
            `INSERT INTO profiles (user_id, timezone, preferred_weight_unit,
                 widgets_enabled, alcohol_tracking_enabled, preferred_drink_unit, updated_at)
             VALUES ($1,
                 COALESCE($2, 'UTC'),
                 $3,
                 COALESCE($4, true),
                 COALESCE($5, false),
                 $6,
                 $7)
             ON CONFLICT (user_id) DO UPDATE SET
                 timezone = COALESCE(EXCLUDED.timezone, profiles.timezone),
                 preferred_weight_unit = EXCLUDED.preferred_weight_unit,
                 widgets_enabled = COALESCE(EXCLUDED.widgets_enabled, profiles.widgets_enabled),
                 alcohol_tracking_enabled = COALESCE(EXCLUDED.alcohol_tracking_enabled, profiles.alcohol_tracking_enabled),
                 preferred_drink_unit = EXCLUDED.preferred_drink_unit,
                 updated_at = EXCLUDED.updated_at
             RETURNING *`,
            [
                userId,
                patch.timezone ?? null,
                patch.preferred_weight_unit ?? null,
                patch.widgets_enabled ?? null,
                patch.alcohol_tracking_enabled ?? null,
                patch.preferred_drink_unit ?? null,
                new Date().toISOString(),
            ],
        );
        return profileFromRow(rows[0]!);
    } catch (error) {
        throw new Error(`Failed to save profile: ${(error as Error).message}`);
    }
}

// ============================================================================
// NUTRITION GOALS
// ============================================================================

export interface NutritionGoals {
    user_id: string;
    daily_calories: number | null;
    daily_protein_g: number | null;
    daily_carbs_g: number | null;
    daily_fat_g: number | null;
    daily_fiber_g: number | null;
    daily_sugar_g: number | null;
    daily_alcohol_g: number | null;
    daily_water_ml: number | null;
    target_weight_g: number | null;
    updated_at: string;
}

export interface NutritionGoalsInput {
    daily_calories?: number | null;
    daily_protein_g?: number | null;
    daily_carbs_g?: number | null;
    daily_fat_g?: number | null;
    daily_fiber_g?: number | null;
    daily_sugar_g?: number | null;
    daily_alcohol_g?: number | null;
    daily_water_ml?: number | null;
    target_weight_g?: number | null;
}

function goalsFromRow(row: Record<string, unknown>): NutritionGoals {
    return {
        user_id: row.user_id as string,
        daily_calories: num(row.daily_calories),
        daily_protein_g: num(row.daily_protein_g),
        daily_carbs_g: num(row.daily_carbs_g),
        daily_fat_g: num(row.daily_fat_g),
        daily_fiber_g: num(row.daily_fiber_g),
        daily_sugar_g: num(row.daily_sugar_g),
        daily_alcohol_g: num(row.daily_alcohol_g),
        daily_water_ml: num(row.daily_water_ml),
        target_weight_g: num(row.target_weight_g),
        updated_at: (row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : String(row.updated_at)),
    };
}

export async function upsertNutritionGoals(
    userId: string,
    input: NutritionGoalsInput,
): Promise<NutritionGoals> {
    try {
        const { rows } = await pool.query(
            `INSERT INTO nutrition_goals
                (user_id, daily_calories, daily_protein_g, daily_carbs_g, daily_fat_g,
                 daily_fiber_g, daily_sugar_g, daily_alcohol_g, daily_water_ml,
                 target_weight_g, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (user_id) DO UPDATE SET
                 daily_calories = EXCLUDED.daily_calories,
                 daily_protein_g = EXCLUDED.daily_protein_g,
                 daily_carbs_g = EXCLUDED.daily_carbs_g,
                 daily_fat_g = EXCLUDED.daily_fat_g,
                 daily_fiber_g = EXCLUDED.daily_fiber_g,
                 daily_sugar_g = EXCLUDED.daily_sugar_g,
                 daily_alcohol_g = EXCLUDED.daily_alcohol_g,
                 daily_water_ml = EXCLUDED.daily_water_ml,
                 target_weight_g = EXCLUDED.target_weight_g,
                 updated_at = EXCLUDED.updated_at
             RETURNING *`,
            [
                userId,
                input.daily_calories == null
                    ? null
                    : toStoredInteger(input.daily_calories),
                input.daily_protein_g ?? null,
                input.daily_carbs_g ?? null,
                input.daily_fat_g ?? null,
                input.daily_fiber_g ?? null,
                input.daily_sugar_g ?? null,
                input.daily_alcohol_g ?? null,
                input.daily_water_ml == null
                    ? null
                    : toStoredInteger(input.daily_water_ml),
                input.target_weight_g ?? null,
                new Date().toISOString(),
            ],
        );
        return goalsFromRow(rows[0]!);
    } catch (error) {
        throw new Error(`Failed to save goals: ${(error as Error).message}`);
    }
}

export async function getNutritionGoals(
    userId: string,
): Promise<NutritionGoals | null> {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM nutrition_goals WHERE user_id = $1`,
            [userId],
        );
        if (rows.length === 0) return null;
        return goalsFromRow(rows[0]!);
    } catch (error) {
        throw new Error(`Failed to get goals: ${(error as Error).message}`);
    }
}

// ============================================================================
// WATER LOG
// ============================================================================

export interface WaterEntry {
    id: string;
    user_id: string;
    amount_ml: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface WaterInput {
    amount_ml: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface WaterInsertResult {
    entry: WaterEntry;
    deduplicated: boolean;
}

function waterFromRow(row: Record<string, unknown>): WaterEntry {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        amount_ml: num(row.amount_ml) ?? 0,
        logged_at: (row.logged_at instanceof Date
            ? row.logged_at.toISOString()
            : String(row.logged_at)),
        notes: (row.notes as string | null) ?? null,
        created_at: (row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at)),
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

export async function insertWater(
    userId: string,
    input: WaterInput,
): Promise<WaterInsertResult> {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    const idempotencyKey =
        input.idempotency_key ??
        deriveIdempotencyKey([userId, input.amount_ml, input.notes, loggedAt]);

    {
        const { rows } = await pool.query(
            `SELECT * FROM water_log WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, idempotencyKey],
        );
        if (rows.length > 0) {
            return { entry: waterFromRow(rows[0]!), deduplicated: true };
        }
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO water_log (user_id, amount_ml, logged_at, notes, idempotency_key)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [userId, input.amount_ml, loggedAt, input.notes ?? null, idempotencyKey],
        );
        return { entry: waterFromRow(rows[0]!), deduplicated: false };
    } catch (error) {
        if ((error as { code?: string }).code === "23505") {
            const { rows } = await pool.query(
                `SELECT * FROM water_log WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, idempotencyKey],
            );
            if (rows.length > 0) {
                return { entry: waterFromRow(rows[0]!), deduplicated: true };
            }
        }
        throw new Error(`Failed to insert water: ${(error as Error).message}`);
    }
}

export async function getWaterByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WaterEntry[]> {
    const startUtc = zonedDayStartUtc(date, tz);
    const endUtc = zonedNextDayStartUtc(date, tz);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM water_log
             WHERE user_id = $1 AND logged_at >= $2 AND logged_at < $3
             ORDER BY logged_at ASC`,
            [userId, startUtc.toISOString(), endUtc.toISOString()],
        );
        return rows.map(waterFromRow);
    } catch (error) {
        throw new Error(`Failed to get water: ${(error as Error).message}`);
    }
}

export async function getWaterInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<WaterEntry[]> {
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM water_log
             WHERE user_id = $1 AND logged_at >= $2 AND logged_at < $3
             ORDER BY logged_at ASC`,
            [userId, startUtc.toISOString(), endUtc.toISOString()],
        );
        return rows.map(waterFromRow);
    } catch (error) {
        throw new Error(`Failed to get water: ${(error as Error).message}`);
    }
}

export async function deleteWater(userId: string, id: string): Promise<void> {
    try {
        await pool.query(
            `DELETE FROM water_log WHERE id = $1 AND user_id = $2`,
            [id, userId],
        );
    } catch (error) {
        throw new Error(`Failed to delete water: ${(error as Error).message}`);
    }
}

// ============================================================================
// WEIGHT LOG
// ============================================================================

export interface WeightEntry {
    id: string;
    user_id: string;
    weight_g: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface WeightInput {
    weight_g: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface WeightInsertResult {
    entry: WeightEntry;
    deduplicated: boolean;
}

function weightFromRow(row: Record<string, unknown>): WeightEntry {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        weight_g: num(row.weight_g) ?? 0,
        logged_at: (row.logged_at instanceof Date
            ? row.logged_at.toISOString()
            : String(row.logged_at)),
        notes: (row.notes as string | null) ?? null,
        created_at: (row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at)),
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

export async function insertWeight(
    userId: string,
    input: WeightInput,
): Promise<WeightInsertResult> {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    const idempotencyKey =
        input.idempotency_key ??
        deriveIdempotencyKey([userId, input.weight_g, input.notes, loggedAt]);

    {
        const { rows } = await pool.query(
            `SELECT * FROM weight_log WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, idempotencyKey],
        );
        if (rows.length > 0) {
            return { entry: weightFromRow(rows[0]!), deduplicated: true };
        }
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO weight_log (user_id, weight_g, logged_at, notes, idempotency_key)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [userId, input.weight_g, loggedAt, input.notes ?? null, idempotencyKey],
        );
        return { entry: weightFromRow(rows[0]!), deduplicated: false };
    } catch (error) {
        if ((error as { code?: string }).code === "23505") {
            const { rows } = await pool.query(
                `SELECT * FROM weight_log WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, idempotencyKey],
            );
            if (rows.length > 0) {
                return { entry: weightFromRow(rows[0]!), deduplicated: true };
            }
        }
        throw new Error(`Failed to insert weight: ${(error as Error).message}`);
    }
}

export async function getWeightByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WeightEntry[]> {
    const startUtc = zonedDayStartUtc(date, tz);
    const endUtc = zonedNextDayStartUtc(date, tz);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM weight_log
             WHERE user_id = $1 AND logged_at >= $2 AND logged_at < $3
             ORDER BY logged_at ASC`,
            [userId, startUtc.toISOString(), endUtc.toISOString()],
        );
        return rows.map(weightFromRow);
    } catch (error) {
        throw new Error(`Failed to get weight: ${(error as Error).message}`);
    }
}

export async function getWeightInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<WeightEntry[]> {
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM weight_log
             WHERE user_id = $1 AND logged_at >= $2 AND logged_at < $3
             ORDER BY logged_at ASC`,
            [userId, startUtc.toISOString(), endUtc.toISOString()],
        );
        return rows.map(weightFromRow);
    } catch (error) {
        throw new Error(`Failed to get weight: ${(error as Error).message}`);
    }
}

export async function getLatestWeight(
    userId: string,
): Promise<WeightEntry | null> {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM weight_log
             WHERE user_id = $1
             ORDER BY logged_at DESC
             LIMIT 1`,
            [userId],
        );
        if (rows.length === 0) return null;
        return weightFromRow(rows[0]!);
    } catch (error) {
        throw new Error(
            `Failed to get latest weight: ${(error as Error).message}`,
        );
    }
}

export async function updateWeight(
    userId: string,
    id: string,
    fields: { weight_g?: number; logged_at?: string; notes?: string | null },
): Promise<WeightEntry> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (fields.weight_g !== undefined) {
        setClauses.push(`weight_g = $${paramIdx}`);
        params.push(fields.weight_g);
        paramIdx++;
    }
    if (fields.logged_at !== undefined) {
        setClauses.push(`logged_at = $${paramIdx}`);
        params.push(fields.logged_at);
        paramIdx++;
    }
    if (fields.notes !== undefined) {
        setClauses.push(`notes = $${paramIdx}`);
        params.push(
            fields.notes != null
                ? decodeEscapeSequences(fields.notes)
                : fields.notes,
        );
        paramIdx++;
    }

    if (setClauses.length === 0) {
        const { rows } = await pool.query(
            `SELECT * FROM weight_log WHERE id = $1 AND user_id = $2`,
            [id, userId],
        );
        if (rows.length === 0) throw new Error("Weight entry not found");
        return weightFromRow(rows[0]!);
    }

    params.push(id, userId);
    const sql = `UPDATE weight_log SET ${setClauses.join(", ")}
                 WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}
                 RETURNING *`;

    try {
        const { rows } = await pool.query(sql, params);
        if (rows.length === 0) throw new Error("Weight entry not found");
        return weightFromRow(rows[0]!);
    } catch (error) {
        throw new Error(`Failed to update weight: ${(error as Error).message}`);
    }
}

export async function deleteWeight(
    userId: string,
    id: string,
): Promise<boolean> {
    try {
        const { rows } = await pool.query(
            `DELETE FROM weight_log WHERE id = $1 AND user_id = $2 RETURNING id`,
            [id, userId],
        );
        return rows.length > 0;
    } catch (error) {
        throw new Error(`Failed to delete weight: ${(error as Error).message}`);
    }
}

// ============================================================================
// DELETE ALL USER DATA
// ============================================================================

export async function deleteAllUserData(userId: string): Promise<void> {
    // Delete in dependency order (child tables first).
    const tables = [
        "tool_analytics",
        "water_log",
        "weight_log",
        "nutrition_goals",
        "profiles",
        "meals",
    ] as const;

    for (const table of tables) {
        try {
            await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [
                userId,
            ]);
        } catch (error) {
            throw new Error(
                `Failed to delete ${table}: ${(error as Error).message}`,
            );
        }
    }

    // Clean up any local export file (best-effort; ENOENT is not an error).
    try {
        const exportPath = `./exports/${userId}/meals.csv`;
        if (existsSync(exportPath)) {
            unlinkSync(exportPath);
        }
    } catch {
        // Ignore — the export file is transient.
    }
}

// ============================================================================
// PUBLIC LANDING STATS
// ============================================================================

export interface LandingStats {
    food_logs: number;
    total_calories: number;
    total_protein_g: number;
    total_carbs_g: number;
    total_fat_g: number;
    timezones: number;
    timezone_list: string[];
}

export async function getLandingStats(): Promise<LandingStats> {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM public_landing_stats()`,
        );
        const raw = (rows[0] as { public_landing_stats: LandingStats })
            .public_landing_stats;
        return raw;
    } catch (error) {
        throw new Error(
            `Failed to get landing stats: ${(error as Error).message}`,
        );
    }
}
