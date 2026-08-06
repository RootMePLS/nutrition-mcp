import type { Pool } from "pg";
import { escapeLikePattern, tokenizeQuery } from "./search.js";

export interface MealEventProjection {
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
    current_version: number;
}

function n(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const value = Number(v);
    return Number.isFinite(value) ? value : null;
}

export function renderMealItems(items: Array<Record<string, unknown>>): {
    description: string;
    notes: string | null;
} {
    const description = items
        .slice()
        .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
        .map((item) => String(item.normalized_name ?? item.raw_item_text ?? ""))
        .join(", ");
    const notes =
        items
            .map((item) => item.notes)
            .filter((x): x is string => typeof x === "string" && x.length > 0)
            .join("; ") || null;
    return { description, notes };
}

function projection(row: Record<string, unknown>): MealEventProjection {
    const items = Array.isArray(row.items)
        ? (row.items as Array<Record<string, unknown>>)
        : [];
    const rendered = renderMealItems(items);
    return {
        id: String(row.id),
        user_id: String(row.user_id),
        logged_at:
            row.logged_at instanceof Date
                ? row.logged_at.toISOString()
                : String(row.logged_at),
        meal_type: (row.meal_type as string | null) ?? null,
        description: rendered.description,
        calories: n(row.calories),
        protein_g: n(row.protein_g),
        carbs_g: n(row.carbs_g),
        fat_g: n(row.fat_g),
        fiber_g: n(row.fiber_g),
        sugar_g: n(row.sugar_g),
        alcohol_g: n(row.alcohol_g),
        notes: rendered.notes,
        idempotency_key: (row.idempotency_key as string | null) ?? null,
        current_version: Number(row.current_version),
    };
}

const SELECT = `
SELECT e.id, e.user_id, e.consumed_at AS logged_at, e.meal_type,
       e.idempotency_key, e.current_version,
       c.calories, c.protein_g, c.carbs_g, c.fat_g, c.fiber_g, c.sugar_g, c.alcohol_g,
       COALESCE(jsonb_agg(jsonb_build_object(
           'ordinal', i.ordinal, 'raw_item_text', i.raw_item_text,
           'normalized_name', i.normalized_name, 'notes', i.notes
       ) ORDER BY i.ordinal) FILTER (WHERE i.ordinal IS NOT NULL), '[]'::jsonb) AS items
FROM meal_events e
JOIN meal_event_versions v ON v.event_id = e.id AND v.version = e.current_version
LEFT JOIN meal_event_items i ON i.event_id = v.event_id AND i.version = v.version
LEFT JOIN meal_event_canonical_results c ON c.event_id = v.event_id AND c.version = v.version AND c.ordinal IS NULL
WHERE e.user_id = $1 AND e.status = 'active'`;

const GROUP = ` GROUP BY e.id, e.user_id, e.consumed_at, e.meal_type, e.idempotency_key, e.current_version,
 c.calories, c.protein_g, c.carbs_g, c.fat_g, c.fiber_g, c.sugar_g, c.alcohol_g`;

export async function getMealProjectionsByRange(
    pool: Pool,
    userId: string,
    startUtc: string,
    endUtc: string,
): Promise<MealEventProjection[]> {
    const { rows } = await pool.query(
        `${SELECT} AND e.consumed_at >= $2 AND e.consumed_at < $3${GROUP} ORDER BY e.consumed_at ASC, e.id ASC`,
        [userId, startUtc, endUtc],
    );
    return rows.map(projection);
}

export async function getMealProjection(
    pool: Pool,
    userId: string,
    id: string,
): Promise<MealEventProjection | null> {
    const { rows } = await pool.query(`${SELECT} AND e.id = $2${GROUP}`, [
        userId,
        id,
    ]);
    return rows.length ? projection(rows[0]!) : null;
}

export async function countMealProjections(
    pool: Pool,
    userId: string,
): Promise<number> {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM meal_events WHERE user_id = $1 AND status = 'active'`,
        [userId],
    );
    return Number(rows[0]?.count ?? 0);
}

export async function getAllMealProjections(
    pool: Pool,
    userId: string,
): Promise<MealEventProjection[]> {
    const { rows } = await pool.query(
        `${SELECT}${GROUP} ORDER BY e.consumed_at ASC, e.id ASC`,
        [userId],
    );
    return rows.map(projection);
}

export async function existingMealIdempotencyKeys(
    pool: Pool,
    userId: string,
    keys: string[],
): Promise<Set<string>> {
    if (!keys.length) return new Set();
    const { rows } = await pool.query(
        `SELECT idempotency_key FROM meal_events WHERE user_id = $1 AND idempotency_key = ANY($2::text[])`,
        [userId, keys],
    );
    return new Set(rows.map((r) => String(r.idempotency_key)));
}

export async function searchMealProjections(
    pool: Pool,
    userId: string,
    queries: string[],
    opts: { limit?: number | null; sinceIso?: string } = {},
): Promise<MealEventProjection[]> {
    // limit: null omits the LIMIT clause entirely — required by the 90-day
    // reuse-discovery ranking, which must count the FULL match set before
    // grouping; all existing callers keep the default 50-row cap.
    const limit = opts.limit === undefined ? 50 : opts.limit;
    const alternatives = queries
        .map(tokenizeQuery)
        .filter((tokens) => tokens.length);
    if (!alternatives.length) return [];
    const params: unknown[] = [userId];
    const where = [`e.user_id = $1`, `e.status = 'active'`];
    if (opts.sinceIso) {
        params.push(opts.sinceIso);
        where.push(`e.consumed_at >= $${params.length}`);
    }
    const tokenClauses: string[] = [];
    for (const tokens of alternatives) {
        tokenClauses.push(
            `(${tokens
                .map((token) => {
                    params.push(`%${escapeLikePattern(token)}%`);
                    const p = params.length;
                    return `(i.raw_item_text ILIKE $${p} OR i.normalized_name ILIKE $${p} OR i.notes ILIKE $${p})`;
                })
                .join(" AND ")})`,
        );
    }
    where.push(`(${tokenClauses.join(" OR ")})`);
    let sql = `${SELECT} AND ${where.slice(1).join(" AND ")}${GROUP} ORDER BY e.consumed_at DESC, e.id DESC`;
    if (limit !== null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
    }
    const { rows } = await pool.query(sql, params);
    return rows.map(projection);
}
