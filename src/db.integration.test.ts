import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";

// Opt-in integration suite against a real disposable PostgreSQL database.
// Skipped loudly unless DATABASE_URL_TEST points at a scratch database the
// suite is allowed to destroy — it drops the public schema between tests.
const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

const MIGRATION_001 = "db/migrations/001_initial_schema.sql";
const MIGRATION_002 = "db/migrations/002_food_tracking.sql";

const NEW_TABLES = [
    "meal_events",
    "meal_event_versions",
    "meal_event_items",
    "meal_event_inputs",
    "meal_event_media",
    "meal_event_nutrition_results",
    "meal_event_canonical_results",
    "meal_event_sync_journal",
    "backup_manifests",
];

const LEGACY_TABLE = "meals";

async function applyMigration(client: PoolClient, path: string): Promise<void> {
    const sql = await Bun.file(path).text();
    await client.query(sql);
}

async function resetSchema(client: PoolClient): Promise<void> {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

async function tableNames(client: PoolClient): Promise<string[]> {
    const { rows } = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return rows.map((r) => r.table_name as string);
}

if (!DATABASE_URL_TEST) {
    console.log(
        "src/db.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set; " +
            "integration tests never claim success without a real test database",
    );
}

const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

describeDb("food-tracking migrations (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;
    let client: PoolClient;

    beforeAll(async () => {
        pool = new Pool({
            connectionString: DATABASE_URL_TEST,
            max: 1,
        });
        client = await pool.connect();
    });

    afterAll(async () => {
        client.release();
        await pool.end();
    });

    test("migration: fresh DB applies 001 then 002 and exposes the new schema", async () => {
        await resetSchema(client);
        await applyMigration(client, MIGRATION_001);
        await applyMigration(client, MIGRATION_002);

        const tables = await tableNames(client);
        for (const table of NEW_TABLES) {
            expect(tables).toContain(table);
        }
        expect(tables).not.toContain(LEGACY_TABLE);

        // Spot-check the load-bearing unique index of the new model.
        const { rows: uniques } = await client.query(
            `SELECT indexname FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'meal_events'
               AND indexdef ILIKE '%UNIQUE%'`,
        );
        expect(uniques.length).toBeGreaterThanOrEqual(1);
    });

    test("migration: existing DB loses legacy meals rows but keeps profiles/goals/water/weight", async () => {
        await resetSchema(client);
        await applyMigration(client, MIGRATION_001);

        // Seed legacy nutrition data plus data that must survive the reset.
        await client.query(
            `INSERT INTO meals (user_id, description, calories) VALUES ($1, $2, $3)`,
            ["u1", "legacy breakfast", 500],
        );
        await client.query(
            `INSERT INTO water_log (user_id, amount_ml) VALUES ($1, $2)`,
            ["u1", 250],
        );
        await client.query(
            `INSERT INTO weight_log (user_id, weight_g) VALUES ($1, $2)`,
            ["u1", 80000],
        );
        await client.query(
            `INSERT INTO nutrition_goals (user_id, daily_calories) VALUES ($1, $2)`,
            ["u1", 2000],
        );

        await applyMigration(client, MIGRATION_002);

        const tables = await tableNames(client);
        expect(tables).not.toContain(LEGACY_TABLE);

        const counts = await client.query(
            `SELECT
                (SELECT count(*) FROM profiles) AS profiles,
                (SELECT count(*) FROM nutrition_goals) AS goals,
                (SELECT count(*) FROM water_log) AS water,
                (SELECT count(*) FROM weight_log) AS weight`,
        );
        // profiles: seeded u1 + bootstrap single-user row from 001.
        expect(Number(counts.rows[0].profiles)).toBe(1);
        expect(Number(counts.rows[0].goals)).toBe(1);
        expect(Number(counts.rows[0].water)).toBe(1);
        expect(Number(counts.rows[0].weight)).toBe(1);
    });

    test("migration: rerunning 002 is safe and never half-applies", async () => {
        await resetSchema(client);
        await applyMigration(client, MIGRATION_001);
        await applyMigration(client, MIGRATION_002);
        await applyMigration(client, MIGRATION_002);

        const tables = await tableNames(client);
        for (const table of NEW_TABLES) {
            expect(tables).toContain(table);
        }
        expect(tables).not.toContain(LEGACY_TABLE);
    });

    test("migration: public_landing_stats counts meal_events current versions", async () => {
        await resetSchema(client);
        await applyMigration(client, MIGRATION_001);
        await applyMigration(client, MIGRATION_002);

        const { rows: events } = await client.query(
            `INSERT INTO meal_events (user_id, reported_at, consumed_at, idempotency_key, current_version)
             VALUES ('u1', now(), now(), 'k1', 2)
             RETURNING id`,
        );
        const eventId = events[0].id;
        for (const version of [1, 2]) {
            await client.query(
                `INSERT INTO meal_event_versions (event_id, version, parser_policy_version, created_by)
                 VALUES ($1, $2, 'test-policy', 'test')`,
                [eventId, version],
            );
            await client.query(
                `INSERT INTO meal_event_canonical_results
                    (event_id, version, status, consensus_status, policy_version, calories, protein_g, carbs_g, fat_g)
                 VALUES ($1, $2, 'ready', 'all_agree', 'test-policy', $3, 10, 20, 30)`,
                [eventId, version, version === 1 ? 100 : 400],
            );
        }

        const { rows } = await client.query(
            "SELECT public_landing_stats() AS stats",
        );
        const stats = rows[0].stats;
        expect(stats.food_logs).toBe(1);
        // Only the current version (v2: 400 kcal) counts, not v1's 100.
        expect(Number(stats.total_calories)).toBe(400);
        expect(Number(stats.total_protein_g)).toBe(10);
        expect(Number(stats.total_carbs_g)).toBe(20);
        expect(Number(stats.total_fat_g)).toBe(30);
        expect(Array.isArray(stats.timezone_list)).toBe(true);
    });
});
