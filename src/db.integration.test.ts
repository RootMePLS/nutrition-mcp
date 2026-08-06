import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { createMealEvent } from "./meal-events.js";
import { checkDatabaseReadiness } from "./readiness.js";

// Opt-in integration suite against a real disposable PostgreSQL database.
// Skipped loudly unless DATABASE_URL_TEST points at a scratch database the
// suite is allowed to destroy — it drops the public schema between tests.
const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

const MIGRATION_001 = "db/migrations/001_initial_schema.sql";
const MIGRATION_002 = "db/migrations/002_food_tracking.sql";
const MIGRATION_003 = "db/migrations/003_meal_captures.sql";
const MIGRATION_004 = "db/migrations/004_calculation_bundles.sql";
const MIGRATION_005 = "db/migrations/005_calculation_corrections.sql";
const MIGRATION_006 = "db/migrations/006_meal_reuse_and_supplements.sql";

const MIGRATION_006_TABLES = [
    "meal_event_reuse_sources",
    "meal_event_reuse_provider_sources",
    "supplement_products",
    "supplement_product_versions",
    "supplement_product_aliases",
    "supplement_product_nutrients",
    "supplement_product_label_limits",
    "supplement_regimens",
    "supplement_intake_events",
    "supplement_intake_nutrient_snapshots",
    "supplement_intake_meal_links",
];

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
    "meal_captures",
    "meal_capture_messages",
    "meal_capture_answers",
    "meal_capture_media",
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
        await applyMigration(client, MIGRATION_003);
        await applyMigration(client, MIGRATION_004);
        await applyMigration(client, MIGRATION_005);
        await applyMigration(client, MIGRATION_006);

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
        await applyMigration(client, MIGRATION_003);
        await applyMigration(client, MIGRATION_004);
        await applyMigration(client, MIGRATION_005);
        await applyMigration(client, MIGRATION_006);

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
        await applyMigration(client, MIGRATION_003);
        await applyMigration(client, MIGRATION_004);
        await applyMigration(client, MIGRATION_005);
        await applyMigration(client, MIGRATION_006);

        const tables = await tableNames(client);
        for (const table of NEW_TABLES) {
            expect(tables).toContain(table);
        }
        expect(tables).not.toContain(LEGACY_TABLE);
    });

    test("migration: normal meal event writes source_id after 004", async () => {
        await resetSchema(client);
        await applyMigration(client, MIGRATION_001);
        await applyMigration(client, MIGRATION_002);
        await applyMigration(client, MIGRATION_003);
        await applyMigration(client, MIGRATION_004);
        await applyMigration(client, MIGRATION_005);
        await applyMigration(client, MIGRATION_006);
        const event = await createMealEvent(
            pool,
            {
                user_id: "u1",
                idempotency_key: "normal-after-004",
                reported_at: "2026-08-05T12:00:00.000Z",
                items: [{ ordinal: 0, raw_item_text: "oats" }],
                inputs: [],
                media: [],
                provider_results: [
                    {
                        provider: "own",
                        status: "succeeded",
                        request_fingerprint: "normal-fp",
                        algorithm_version: "v1",
                        nutrients: { calories: 100 },
                        raw_payload: { calories: 100 },
                    },
                ],
                parser_policy_version: "test",
                created_by: "test",
            },
            client,
        );
        const { rows } = await client.query(
            "SELECT source_id FROM meal_event_nutrition_results WHERE event_id = $1",
            [event.event_id],
        );
        expect(rows[0].source_id).toBe("compatibility:legacy");
        const provenance = await client.query(
            "SELECT provenance FROM meal_event_nutrition_results WHERE event_id = $1",
            [event.event_id],
        );
        expect(provenance.rows[0].provenance).toEqual({ compatibility: true });
    });
    test("migration: 006 upgrades a populated 001-005 database without touching existing rows", async () => {
        await resetSchema(client);
        await applyMigration(client, MIGRATION_001);
        await applyMigration(client, MIGRATION_002);
        await applyMigration(client, MIGRATION_003);
        await applyMigration(client, MIGRATION_004);
        await applyMigration(client, MIGRATION_005);

        // Seed an opt-in alcohol profile (UK units) and a real meal event
        // through the existing write path before the upgrade.
        await client.query(
            `INSERT INTO profiles (user_id, alcohol_tracking_enabled, preferred_drink_unit)
             VALUES ($1, true, 'uk')`,
            ["u1"],
        );
        const event = await createMealEvent(
            pool,
            {
                user_id: "u1",
                idempotency_key: "pre-006-event",
                reported_at: "2026-08-05T12:00:00.000Z",
                items: [{ ordinal: 0, raw_item_text: "oats" }],
                inputs: [],
                media: [],
                provider_results: [
                    {
                        provider: "own",
                        status: "succeeded",
                        request_fingerprint: "pre-006-fp",
                        algorithm_version: "v1",
                        nutrients: { calories: 100 },
                        raw_payload: { calories: 100 },
                    },
                ],
                parser_policy_version: "test",
                created_by: "test",
            },
            client,
        );

        await applyMigration(client, MIGRATION_006);
        // Rerunning 006 must be safe (additive/idempotent like 003-005).
        await applyMigration(client, MIGRATION_006);

        // Existing alcohol profile state survives the upgrade untouched.
        const { rows: profiles } = await client.query(
            "SELECT alcohol_tracking_enabled, preferred_drink_unit FROM profiles WHERE user_id = 'u1'",
        );
        expect(profiles).toEqual([
            { alcohol_tracking_enabled: true, preferred_drink_unit: "uk" },
        ]);

        // Existing meal-event rows survive intact and readable.
        const { rows: events } = await client.query(
            "SELECT id, status, current_version FROM meal_events WHERE id = $1",
            [event.event_id],
        );
        expect(events).toEqual([
            { id: event.event_id, status: "active", current_version: 1 },
        ]);
        const { rows: results } = await client.query(
            "SELECT calories FROM meal_event_nutrition_results WHERE event_id = $1",
            [event.event_id],
        );
        expect(Number(results[0].calories)).toBe(100);

        // All new substrate tables exist.
        const tables = await tableNames(client);
        for (const table of MIGRATION_006_TABLES) {
            expect(tables).toContain(table);
        }

        // Category vocabulary is enforced at the database boundary.
        const badCategory = client.query(
            `INSERT INTO supplement_products (user_id, category) VALUES ('u1', 'vitamin')`,
        );
        await expect(badCategory).rejects.toThrow();

        // Intake state actions are enforced at the database boundary.
        const { rows: productIds } = await client.query(
            `INSERT INTO supplement_products (user_id, category)
             VALUES ('u1', 'supplement') RETURNING id`,
        );
        await client.query(
            `INSERT INTO supplement_product_versions
                (product_id, version, user_id, display_name, label_evidence, created_by)
             VALUES ($1, 1, 'u1', 'Creatine', '{}', 'test')`,
            [productIds[0].id],
        );
        const badAction = client.query(
            `INSERT INTO supplement_intake_events
                (user_id, product_id, product_version, servings, occurred_at, state_action, idempotency_key)
             VALUES ('u1', $1, 1, 1, now(), 'skipped', 'k-bad')`,
            [productIds[0].id],
        );
        await expect(badAction).rejects.toThrow();

        // Load-bearing uniqueness/indexes exist: user-scoped intake
        // idempotency and non-unique alias lookup (ambiguity representable).
        const { rows: intakeUniques } = await client.query(
            `SELECT indexname FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'supplement_intake_events'
               AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%idempotency_key%'`,
        );
        expect(intakeUniques.length).toBe(1);
        const { rows: aliasIndexes } = await client.query(
            `SELECT indexname, indexdef FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'supplement_product_aliases'
               AND indexdef ILIKE '%normalized_alias%'`,
        );
        expect(aliasIndexes.length).toBeGreaterThanOrEqual(1);
        const nonUniqueLookup = aliasIndexes.find(
            (r) => !(r.indexdef as string).includes("UNIQUE"),
        );
        expect(nonUniqueLookup).toBeDefined();

        // Reuse lineage uniqueness: one lineage row per target version and
        // one per (user, reuse idempotency key).
        const { rows: reuseUniques } = await client.query(
            `SELECT indexdef FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'meal_event_reuse_sources'
               AND indexdef ILIKE '%UNIQUE%'`,
        );
        expect(reuseUniques.length).toBeGreaterThanOrEqual(2);
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
        expect(Number(stats.total_calories)).toBe(400);
        expect(Number(stats.total_protein_g)).toBe(10);
        expect(Number(stats.total_carbs_g)).toBe(20);
        expect(Number(stats.total_fat_g)).toBe(30);
        expect(Array.isArray(stats.timezone_list)).toBe(true);
    });
});

describeDb("database readiness probe (requires DATABASE_URL_TEST)", () => {
    test("readiness succeeds against the live test database", async () => {
        const pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 1 });
        try {
            const result = await checkDatabaseReadiness(pool, {
                databaseUrl: DATABASE_URL_TEST,
            });
            expect(result).toEqual({ ok: true });
        } finally {
            await pool.end();
        }
    });

    test("readiness fails in bounded time against a wrong port, redacted", async () => {
        const badUrl =
            "postgres://wrong_port_user:wrong_port_pw@localhost:5439/nope";
        const pool = new Pool({
            connectionString: badUrl,
            max: 1,
            connectionTimeoutMillis: 500,
        });
        const started = Date.now();
        try {
            const result = await checkDatabaseReadiness(pool, {
                databaseUrl: badUrl,
                timeoutMs: 1500,
            });
            expect(Date.now() - started).toBeLessThan(5000);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain("localhost:5439/nope");
                expect(result.error).not.toContain("wrong_port_user");
                expect(result.error).not.toContain("wrong_port_pw");
            }
        } finally {
            await pool.end();
        }
    });

    test("routes: /ready is 200 with a reachable database, /health stays ok", async () => {
        // Importing index.js exercises the real route wiring and the shared
        // pool (pointed at DATABASE_URL by the DB gate) without listening.
        const server = (await import("./index.js")).default;
        const ready = await server.fetch(new Request("http://localhost/ready"));
        expect(ready.status).toBe(200);
        expect(await ready.text()).toBe("ok");
        const health = await server.fetch(
            new Request("http://localhost/health"),
        );
        expect(health.status).toBe(200);
        expect(await health.text()).toBe("ok");
    });
});
