import { Pool, type PoolClient } from "pg";
import { zonedDayStartUtc, zonedNextDayStartUtc } from "./tz.js";
import { decodeEscapeSequences } from "./normalize.js";
import { isWeightUnit, toStoredInteger, type WeightUnit } from "./units.js";
import { isDrinkUnit, type DrinkUnit } from "./alcohol.js";
import { escapeLikePattern, tokenizeQuery } from "./search.js";
import { existsSync, unlinkSync } from "node:fs";
import {
    getMealProjectionsByRange,
    getMealProjection,
    countMealProjections,
    getAllMealProjections,
    existingMealIdempotencyKeys,
    searchMealProjections,
    type MealEventProjection,
} from "./meal-event-projection.js";
import { createMealEvent, correctMealEvent } from "./meal-events.js";
import type {
    CreateMealEventCommand,
    CorrectMealEventCommand,
} from "./meal-types.js";

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
    notes?: string | null;
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

function projectionAsMeal(row: MealEventProjection): Meal {
    return { ...row };
}

function compatibilityCommand(
    userId: string,
    input: MealInput,
): CreateMealEventCommand {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    const idempotencyKey =
        input.idempotency_key ?? mealIdempotencyKey(userId, input, loggedAt);
    const description = decodeEscapeSequences(input.description);
    const notes =
        input.notes == null ? null : decodeEscapeSequences(input.notes);
    return {
        user_id: userId,
        idempotency_key: idempotencyKey,
        reported_at: loggedAt,
        consumed_at: loggedAt,
        meal_type: input.meal_type,
        items: [
            {
                ordinal: 0,
                raw_item_text: description,
                normalized_name: description,
                notes,
            },
        ],
        inputs: [
            {
                source_kind: "user_text",
                content: description,
                metadata: { compatibility: "legacy_log_meal" },
            },
        ],
        media: [],
        provider_results: [
            {
                provider: "own",
                status: "succeeded",
                request_fingerprint: `legacy:${idempotencyKey}`,
                algorithm_version: "legacy-compat",
                nutrients: {
                    calories:
                        input.calories == null
                            ? null
                            : toStoredInteger(input.calories),
                    protein_g: input.protein_g ?? null,
                    carbs_g: input.carbs_g ?? null,
                    fat_g: input.fat_g ?? null,
                    fiber_g: input.fiber_g ?? null,
                    sugar_g: input.sugar_g ?? null,
                    alcohol_g: input.alcohol_g ?? null,
                },
            },
        ],
        parser_policy_version: "legacy-compat-v1",
        created_by: "legacy-log-meal",
    };
}

export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<MealInsertResult> {
    const result = await createMealEvent(
        pool,
        compatibilityCommand(userId, input),
    );
    const meal = await getMealProjection(pool, userId, result.event_id);
    if (!meal) throw new Error("Failed to read created meal event");
    return { meal: projectionAsMeal(meal), deduplicated: result.deduplicated };
}

export async function getMealsByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    const startUtc = zonedDayStartUtc(date, tz).toISOString();
    const endUtc = zonedNextDayStartUtc(date, tz).toISOString();
    return (
        await getMealProjectionsByRange(pool, userId, startUtc, endUtc)
    ).map(projectionAsMeal);
}

export async function getMealsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    const startUtc = zonedDayStartUtc(startDate, tz).toISOString();
    const endUtc = zonedNextDayStartUtc(endDate, tz).toISOString();
    return (
        await getMealProjectionsByRange(pool, userId, startUtc, endUtc)
    ).map(projectionAsMeal);
}

export async function countMeals(userId: string): Promise<number> {
    return countMealProjections(pool, userId);
}

export async function existingIdempotencyKeys(
    userId: string,
    keys: string[],
): Promise<Set<string>> {
    return existingMealIdempotencyKeys(pool, userId, keys);
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
    return (await getAllMealProjections(pool, userId)).map(projectionAsMeal);
}

export async function searchMeals(
    userId: string,
    queries: string[],
    opts: { limit?: number; sinceIso?: string } = {},
): Promise<Meal[]> {
    return (await searchMealProjections(pool, userId, queries, opts)).map(
        projectionAsMeal,
    );
}

export async function deleteMeal(userId: string, id: string): Promise<void> {
    await pool.query(
        `UPDATE meal_events SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), updated_at = now() WHERE id = $1 AND user_id = $2`,
        [id, userId],
    );
}

export async function updateMeal(
    userId: string,
    id: string,
    fields: Partial<MealInput>,
): Promise<Meal> {
    const current = await getMealProjection(pool, userId, id);
    if (!current) throw new Error("Meal not found");
    const merged: MealInput = {
        description: fields.description ?? current.description,
        meal_type:
            fields.meal_type ?? (current.meal_type as MealInput["meal_type"]),
        calories: fields.calories ?? current.calories ?? undefined,
        protein_g: fields.protein_g ?? current.protein_g ?? undefined,
        carbs_g: fields.carbs_g ?? current.carbs_g ?? undefined,
        fat_g: fields.fat_g ?? current.fat_g ?? undefined,
        fiber_g: fields.fiber_g ?? current.fiber_g ?? undefined,
        sugar_g: fields.sugar_g ?? current.sugar_g ?? undefined,
        alcohol_g: fields.alcohol_g ?? current.alcohol_g ?? undefined,
        logged_at: fields.logged_at ?? current.logged_at,
        notes: fields.notes !== undefined ? fields.notes : current.notes,
    };
    const cmd = compatibilityCommand(userId, merged);
    const correction: CorrectMealEventCommand = {
        event_id: id,
        user_id: userId,
        correction_idempotency_key: `legacy-update:${id}:${JSON.stringify(fields)}`,
        correction_reason: "legacy update_meal compatibility correction",
        items: cmd.items,
        inputs: cmd.inputs,
        media: [],
        provider_results: cmd.provider_results,
        raw_text_snapshot: merged.description,
        parser_policy_version: "legacy-compat-v1",
        created_by: "legacy-update-meal",
        consumed_at: merged.logged_at,
        meal_type: merged.meal_type,
    };
    await correctMealEvent(pool, correction);
    const updated = await getMealProjection(pool, userId, id);
    if (!updated) throw new Error("Meal not found");
    return projectionAsMeal(updated);
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
        created_at:
            row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
        updated_at:
            row.updated_at instanceof Date
                ? row.updated_at.toISOString()
                : String(row.updated_at),
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
        updated_at:
            row.updated_at instanceof Date
                ? row.updated_at.toISOString()
                : String(row.updated_at),
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
        logged_at:
            row.logged_at instanceof Date
                ? row.logged_at.toISOString()
                : String(row.logged_at),
        notes: (row.notes as string | null) ?? null,
        created_at:
            row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
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
            [
                userId,
                input.amount_ml,
                loggedAt,
                input.notes ?? null,
                idempotencyKey,
            ],
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
        logged_at:
            row.logged_at instanceof Date
                ? row.logged_at.toISOString()
                : String(row.logged_at),
        notes: (row.notes as string | null) ?? null,
        created_at:
            row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
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
            [
                userId,
                input.weight_g,
                loggedAt,
                input.notes ?? null,
                idempotencyKey,
            ],
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
    const eventChildren = [
        "meal_event_sync_journal",
        "meal_event_canonical_results",
        "meal_event_nutrition_results",
        "meal_event_media",
        "meal_event_inputs",
        "meal_event_items",
        "meal_event_versions",
    ] as const;
    for (const table of eventChildren) {
        await pool.query(
            `DELETE FROM ${table} WHERE event_id IN (SELECT id FROM meal_events WHERE user_id = $1)`,
            [userId],
        );
    }
    await pool.query("DELETE FROM meal_events WHERE user_id = $1", [userId]);
    for (const table of [
        "tool_analytics",
        "water_log",
        "weight_log",
        "nutrition_goals",
        "profiles",
    ] as const) {
        await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }

    try {
        const exportPath = `./exports/${userId}/meals.csv`;
        if (existsSync(exportPath)) unlinkSync(exportPath);
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
