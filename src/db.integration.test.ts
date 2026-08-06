import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { createMealEvent } from "./meal-events.js";
import { checkDatabaseReadiness } from "./readiness.js";
import {
    createSupplementProduct,
    type CreateSupplementProductCommand,
} from "./supplements.js";

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
const MIGRATION_007 = "db/migrations/007_ownership_lineage_integrity.sql";
const MIGRATION_008 = "db/migrations/008_supplement_create_idempotency.sql";
const MIGRATION_009 =
    "db/migrations/009_supplement_create_idem_reconciliation.sql";

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
        await applyMigration(client, MIGRATION_007);
        await applyMigration(client, MIGRATION_008);
        await applyMigration(client, MIGRATION_009);

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
        await applyMigration(client, MIGRATION_007);
        await applyMigration(client, MIGRATION_008);
        await applyMigration(client, MIGRATION_009);

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
        await applyMigration(client, MIGRATION_007);
        await applyMigration(client, MIGRATION_008);
        await applyMigration(client, MIGRATION_009);

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
        await applyMigration(client, MIGRATION_007);
        await applyMigration(client, MIGRATION_008);
        await applyMigration(client, MIGRATION_009);
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
        await applyMigration(client, MIGRATION_007);
        await applyMigration(client, MIGRATION_008);
        await applyMigration(client, MIGRATION_009);
        // Rerunning 006-009 must be safe (additive/idempotent like 003-005).
        await applyMigration(client, MIGRATION_006);
        await applyMigration(client, MIGRATION_007);
        await applyMigration(client, MIGRATION_008);
        await applyMigration(client, MIGRATION_009);

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

// Migration chain applied by the ownership/lineage integrity suite. The
// adversarial tests below must pass against this exact head.
const INTEGRITY_CHAIN = [
    MIGRATION_001,
    MIGRATION_002,
    MIGRATION_003,
    MIGRATION_004,
    MIGRATION_005,
    MIGRATION_006,
    MIGRATION_007,
    MIGRATION_008,
    MIGRATION_009,
];

// Reviewer-terra finding 2: direct persistence must not be able to create
// cross-user or provenance-invalid reuse/supplement facts. Every adversarial
// insert below targets the real database constraint boundary, never an
// application-level validator.
describeDb(
    "migration 007 ownership/lineage integrity (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;
        let client: PoolClient;

        beforeAll(async () => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 1 });
            client = await pool.connect();
        });

        afterAll(async () => {
            client.release();
            await pool.end();
        });

        async function applyIntegrityChain(): Promise<void> {
            await resetSchema(client);
            for (const migration of INTEGRITY_CHAIN) {
                await applyMigration(client, migration);
            }
        }

        async function seedEvent(
            userId: string,
            idempotencyKey: string,
        ): Promise<{ eventId: string; providerResultId: string }> {
            const event = await createMealEvent(
                pool,
                {
                    user_id: userId,
                    idempotency_key: idempotencyKey,
                    reported_at: "2026-08-05T12:00:00.000Z",
                    items: [{ ordinal: 0, raw_item_text: "oats" }],
                    inputs: [],
                    media: [],
                    provider_results: [
                        {
                            provider: "own",
                            status: "succeeded",
                            request_fingerprint: `fp-${idempotencyKey}`,
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
                "SELECT id FROM meal_event_nutrition_results WHERE event_id = $1",
                [event.event_id],
            );
            return { eventId: event.event_id, providerResultId: rows[0].id };
        }

        async function seedProduct(
            userId: string,
            displayName: string,
        ): Promise<string> {
            const { rows: products } = await client.query(
                `INSERT INTO supplement_products (user_id, category)
             VALUES ($1, 'supplement') RETURNING id`,
                [userId],
            );
            const productId = products[0].id as string;
            await client.query(
                `INSERT INTO supplement_product_versions
                (product_id, version, user_id, display_name, label_evidence, created_by)
             VALUES ($1, 1, $2, $3, '{}', 'test')`,
                [productId, userId, displayName],
            );
            return productId;
        }

        test("reuse lineage user_id must own both target and source events", async () => {
            await applyIntegrityChain();
            const target = await seedEvent("u1", "integrity-target");
            const ownSource = await seedEvent("u1", "integrity-own-source");
            const foreign = await seedEvent("u2", "integrity-foreign");

            // Cross-user source: lineage claims u1 but the source belongs to u2.
            await expect(
                client.query(
                    `INSERT INTO meal_event_reuse_sources
                    (event_id, version, user_id, source_event_id, source_version,
                     reuse_idempotency_key, confirmation_received, created_by)
                 VALUES ($1, 1, 'u1', $2, 1, 'r-cross-source', true, 'test')`,
                    [target.eventId, foreign.eventId],
                ),
            ).rejects.toThrow();

            // Mismatched target owner: lineage claims u2 but target belongs to u1.
            await expect(
                client.query(
                    `INSERT INTO meal_event_reuse_sources
                    (event_id, version, user_id, source_event_id, source_version,
                     reuse_idempotency_key, confirmation_received, created_by)
                 VALUES ($1, 1, 'u2', $2, 1, 'r-cross-target', true, 'test')`,
                    [target.eventId, foreign.eventId],
                ),
            ).rejects.toThrow();

            // Valid same-user lineage is accepted.
            await client.query(
                `INSERT INTO meal_event_reuse_sources
                (event_id, version, user_id, source_event_id, source_version,
                 reuse_idempotency_key, confirmation_received, created_by)
             VALUES ($1, 1, 'u1', $2, 1, 'r-valid', true, 'test')`,
                [target.eventId, ownSource.eventId],
            );
            const { rows } = await client.query(
                "SELECT count(*)::int AS n FROM meal_event_reuse_sources",
            );
            expect(rows[0].n).toBe(1);
        });

        test("reuse provider sources must match the declared target/source event+version pair", async () => {
            await applyIntegrityChain();
            const target = await seedEvent("u1", "ps-target");
            const source = await seedEvent("u1", "ps-source");
            const other = await seedEvent("u1", "ps-other");
            await client.query(
                `INSERT INTO meal_event_reuse_sources
                (event_id, version, user_id, source_event_id, source_version,
                 reuse_idempotency_key, confirmation_received, created_by)
             VALUES ($1, 1, 'u1', $2, 1, 'r-ps', true, 'test')`,
                [target.eventId, source.eventId],
            );

            // Target provider result must belong to the declared target pair.
            await expect(
                client.query(
                    `INSERT INTO meal_event_reuse_provider_sources
                    (event_id, version, target_provider_result_id,
                     source_provider_result_id, source_request_fingerprint,
                     source_event_id, source_version)
                 VALUES ($1, 1, $2, $3, 'fp-ps-source', $4, 1)`,
                    [
                        target.eventId,
                        other.providerResultId,
                        source.providerResultId,
                        source.eventId,
                    ],
                ),
            ).rejects.toThrow();

            // Source provider result must belong to the declared source pair.
            await expect(
                client.query(
                    `INSERT INTO meal_event_reuse_provider_sources
                    (event_id, version, target_provider_result_id,
                     source_provider_result_id, source_request_fingerprint,
                     source_event_id, source_version)
                 VALUES ($1, 1, $2, $3, 'fp-ps-other', $4, 1)`,
                    [
                        target.eventId,
                        target.providerResultId,
                        other.providerResultId,
                        source.eventId,
                    ],
                ),
            ).rejects.toThrow();

            // Declared source pair must equal the lineage row's source pair.
            await expect(
                client.query(
                    `INSERT INTO meal_event_reuse_provider_sources
                    (event_id, version, target_provider_result_id,
                     source_provider_result_id, source_request_fingerprint,
                     source_event_id, source_version)
                 VALUES ($1, 1, $2, $3, 'fp-ps-other', $4, 1)`,
                    [
                        target.eventId,
                        target.providerResultId,
                        other.providerResultId,
                        other.eventId,
                    ],
                ),
            ).rejects.toThrow();

            // The recorded source request fingerprint must be the source
            // result's real fingerprint, not a caller-invented one.
            await expect(
                client.query(
                    `INSERT INTO meal_event_reuse_provider_sources
                    (event_id, version, target_provider_result_id,
                     source_provider_result_id, source_request_fingerprint,
                     source_event_id, source_version)
                 VALUES ($1, 1, $2, $3, 'fp-invented', $4, 1)`,
                    [
                        target.eventId,
                        target.providerResultId,
                        source.providerResultId,
                        source.eventId,
                    ],
                ),
            ).rejects.toThrow();

            // Valid correlated mapping is accepted.
            await client.query(
                `INSERT INTO meal_event_reuse_provider_sources
                (event_id, version, target_provider_result_id,
                 source_provider_result_id, source_request_fingerprint,
                 source_event_id, source_version)
             VALUES ($1, 1, $2, $3, 'fp-ps-source', $4, 1)`,
                [
                    target.eventId,
                    target.providerResultId,
                    source.providerResultId,
                    source.eventId,
                ],
            );
            const { rows } = await client.query(
                "SELECT count(*)::int AS n FROM meal_event_reuse_provider_sources",
            );
            expect(rows[0].n).toBe(1);
        });

        test("product children, regimens, and intakes must share the product owner", async () => {
            await applyIntegrityChain();
            const productU1 = await seedProduct("u1", "Creatine");
            await seedProduct("u2", "Whey");

            // Alias user_id must equal the product version owner.
            await expect(
                client.query(
                    `INSERT INTO supplement_product_aliases
                    (product_id, version, user_id, alias, normalized_alias)
                 VALUES ($1, 1, 'u2', 'creatine', 'creatine')`,
                    [productU1],
                ),
            ).rejects.toThrow();
            await client.query(
                `INSERT INTO supplement_product_aliases
                (product_id, version, user_id, alias, normalized_alias)
             VALUES ($1, 1, 'u1', 'creatine', 'creatine')`,
                [productU1],
            );

            // Regimen user_id must equal the product version owner.
            await expect(
                client.query(
                    `INSERT INTO supplement_regimens
                    (user_id, product_id, product_version, dose_servings,
                     schedule, timezone, starts_on, created_by)
                 VALUES ('u2', $1, 1, 1,
                     '{"timezone":"UTC","frequency":"daily","local_time":"08:00"}',
                     'UTC', '2026-08-01', 'test')`,
                    [productU1],
                ),
            ).rejects.toThrow();
            const { rows: regimens } = await client.query(
                `INSERT INTO supplement_regimens
                (user_id, product_id, product_version, dose_servings,
                 schedule, timezone, starts_on, created_by)
             VALUES ('u1', $1, 1, 1,
                 '{"timezone":"UTC","frequency":"daily","local_time":"08:00"}',
                 'UTC', '2026-08-01', 'test')
             RETURNING id`,
                [productU1],
            );
            const regimenId = regimens[0].id as string;

            // Intake user_id must equal the product version owner.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_events
                    (user_id, product_id, product_version, servings,
                     occurred_at, state_action, actor, idempotency_key)
                 VALUES ('u2', $1, 1, 1, now(), 'done', 'test', 'i-cross')`,
                    [productU1],
                ),
            ).rejects.toThrow();

            // Intake user_id must equal the bound regimen owner.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_events
                    (user_id, product_id, product_version, regimen_id, servings,
                     occurred_at, state_action, actor, idempotency_key)
                 VALUES ('u2', $1, 1, $2, 1, now(), 'done', 'test', 'i-cross-reg')`,
                    [productU1, regimenId],
                ),
            ).rejects.toThrow();

            // Valid same-user intake bound to the regimen is accepted.
            await client.query(
                `INSERT INTO supplement_intake_events
                (user_id, product_id, product_version, regimen_id, servings,
                 occurred_at, state_action, actor, idempotency_key)
             VALUES ('u1', $1, 1, $2, 1, now(), 'done', 'test', 'i-valid')`,
                [productU1, regimenId],
            );
        });

        test("intake snapshots and meal links bind product/version data to their actual intake and user", async () => {
            await applyIntegrityChain();
            const productU1 = await seedProduct("u1", "Creatine");
            const foreignEvent = await seedEvent("u2", "link-foreign");
            const ownEvent = await seedEvent("u1", "link-own");
            await client.query(
                `INSERT INTO supplement_product_nutrients
                (product_id, version, nutrient_key, display_name, amount, unit, source_evidence)
             VALUES ($1, 1, 'creatine_g', 'Creatine', 5, 'g', '{}')`,
                [productU1],
            );
            const { rows: intakes } = await client.query(
                `INSERT INTO supplement_intake_events
                (user_id, product_id, product_version, servings,
                 occurred_at, state_action, actor, idempotency_key)
             VALUES ('u1', $1, 1, 2, now(), 'done', 'test', 'snap-intake')
             RETURNING id`,
                [productU1],
            );
            const intakeId = intakes[0].id as string;

            // Snapshot user must equal the actual intake owner.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_nutrient_snapshots
                    (intake_id, user_id, product_id, product_version,
                     nutrient_key, unit, original_amount, scaled_amount)
                 VALUES ($1, 'u2', $2, 1, 'creatine_g', 'g', 5, 10)`,
                    [intakeId, productU1],
                ),
            ).rejects.toThrow();

            // Snapshot product/version must equal the actual intake's pair.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_nutrient_snapshots
                    (intake_id, user_id, product_id, product_version,
                     nutrient_key, unit, original_amount, scaled_amount)
                 VALUES ($1, 'u1', $2, 2, 'creatine_g', 'g', 5, 10)`,
                    [intakeId, productU1],
                ),
            ).rejects.toThrow();

            // Snapshot nutrient must exist on that exact product version label.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_nutrient_snapshots
                    (intake_id, user_id, product_id, product_version,
                     nutrient_key, unit, original_amount, scaled_amount)
                 VALUES ($1, 'u1', $2, 1, 'vitamin_d_iu', 'iu', 1000, 2000)`,
                    [intakeId, productU1],
                ),
            ).rejects.toThrow();

            // Valid correlated snapshot is accepted.
            await client.query(
                `INSERT INTO supplement_intake_nutrient_snapshots
                (intake_id, user_id, product_id, product_version,
                 nutrient_key, unit, original_amount, scaled_amount)
             VALUES ($1, 'u1', $2, 1, 'creatine_g', 'g', 5, 10)`,
                [intakeId, productU1],
            );

            // Meal link user must equal the actual intake owner.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_meal_links
                    (user_id, intake_id, event_id, version, product_id,
                     product_version, idempotency_fingerprint)
                 VALUES ('u2', $1, $2, 1, $3, 1, 'linkfp-1')`,
                    [intakeId, ownEvent.eventId, productU1],
                ),
            ).rejects.toThrow();

            // Meal link event must belong to the same user as the link/intake.
            await expect(
                client.query(
                    `INSERT INTO supplement_intake_meal_links
                    (user_id, intake_id, event_id, version, product_id,
                     product_version, idempotency_fingerprint)
                 VALUES ('u1', $1, $2, 1, $3, 1, 'linkfp-2')`,
                    [intakeId, foreignEvent.eventId, productU1],
                ),
            ).rejects.toThrow();

            // Valid same-user link to the user's own snack event is accepted.
            await client.query(
                `INSERT INTO supplement_intake_meal_links
                (user_id, intake_id, event_id, version, product_id,
                 product_version, idempotency_fingerprint)
             VALUES ('u1', $1, $2, 1, $3, 1, 'linkfp-3')`,
                [intakeId, ownEvent.eventId, productU1],
            );
            const { rows } = await client.query(
                `SELECT
                (SELECT count(*)::int FROM supplement_intake_nutrient_snapshots) AS snapshots,
                (SELECT count(*)::int FROM supplement_intake_meal_links) AS links`,
            );
            expect(rows[0]).toEqual({ snapshots: 1, links: 1 });
        });

        test("007 hardening constraints exist and the chain stays rerunnable", async () => {
            await applyIntegrityChain();

            const expectedConstraints = [
                "meal_reuse_sources_target_owner_fk",
                "meal_reuse_sources_source_owner_fk",
                "reuse_provider_sources_target_result_fk",
                "reuse_provider_sources_source_pair_fk",
                "reuse_provider_sources_source_result_fk",
                "reuse_provider_sources_source_fp_fk",
                "supplement_aliases_same_user_fk",
                "supplement_regimens_same_user_product_fk",
                "supplement_intake_same_user_product_fk",
                "supplement_intake_same_user_regimen_fk",
                "intake_snapshots_intake_fk",
                "intake_snapshots_product_nutrient_fk",
                "intake_meal_links_intake_fk",
                "intake_meal_links_event_owner_fk",
            ];
            const { rows } = await client.query(
                `SELECT conname FROM pg_constraint
             WHERE connamespace = 'public'::regnamespace AND conname = ANY($1)`,
                [expectedConstraints],
            );
            expect(rows.map((r) => r.conname).sort()).toEqual(
                [...expectedConstraints].sort(),
            );

            // Rerunning the head migrations must be safe (additive/idempotent).
            await applyMigration(client, MIGRATION_007);
            await applyMigration(client, MIGRATION_008);
            await applyMigration(client, MIGRATION_009);
        });
    },
);

// Reviewer-terra slice 2 finding: concurrent first-time product creates with
// the same idempotency key must serialize at the database. Migration 008's
// partial unique index is the enforcement boundary; these tests attack it
// with direct SQL, bypassing every application-level validator.
describeDb(
    "migration 008 supplement create idempotency (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;
        let client: PoolClient;

        beforeAll(async () => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 1 });
            client = await pool.connect();
        });

        afterAll(async () => {
            client.release();
            await pool.end();
        });

        async function applyChain(): Promise<void> {
            await resetSchema(client);
            for (const migration of INTEGRITY_CHAIN) {
                await applyMigration(client, migration);
            }
        }

        async function insertRoot(userId: string): Promise<string> {
            const { rows } = await client.query(
                `INSERT INTO supplement_products (user_id, category)
                 VALUES ($1, 'supplement') RETURNING id`,
                [userId],
            );
            return rows[0].id as string;
        }

        async function insertVersion(
            productId: string,
            userId: string,
            version: number,
            key: string | null,
        ): Promise<void> {
            await client.query(
                `INSERT INTO supplement_product_versions
                    (product_id, version, user_id, revision_idempotency_key,
                     display_name, label_evidence, created_by)
                 VALUES ($1, $2, $3, $4, 'Label', '{}', 'test')`,
                [productId, version, userId, key],
            );
        }

        test("partial unique index exists with the version-1/non-null-key predicate", async () => {
            await applyChain();
            const { rows } = await client.query(
                `SELECT indexdef FROM pg_indexes
                 WHERE schemaname = 'public' AND indexname = 'uniq_spv_user_create_idem'`,
            );
            expect(rows.length).toBe(1);
            const def = rows[0].indexdef as string;
            expect(def).toContain("UNIQUE");
            expect(def).toContain("user_id");
            expect(def).toContain("revision_idempotency_key");
            expect(def).toContain("version = 1");
            expect(def).toContain("IS NOT NULL");
        });

        test("duplicate (user, key) version-1 rows are rejected; cross-user, null-key, and revision keys stay free", async () => {
            await applyChain();

            const rootA = await insertRoot("u1");
            await insertVersion(rootA, "u1", 1, "shared-key");

            // Same user, same key, another first-time create: rejected by the
            // database, never by application code.
            const rootB = await insertRoot("u1");
            await expect(
                insertVersion(rootB, "u1", 1, "shared-key"),
            ).rejects.toMatchObject({
                code: "23505",
                constraint: "uniq_spv_user_create_idem",
            });

            // Different user, same key: independent.
            const rootC = await insertRoot("u2");
            await insertVersion(rootC, "u2", 1, "shared-key");

            // Null/empty-keyed first-time creates are never forced unique.
            const rootD = await insertRoot("u1");
            await insertVersion(rootD, "u1", 1, null);

            // Revision keys live in their own per-product namespace: a
            // version-2 row may reuse ANOTHER product's create key (008's
            // predicate is version = 1 only; 006's per-product revision index
            // governs within one product).
            const rootE = await insertRoot("u1");
            await insertVersion(rootE, "u1", 1, "other-key");
            await insertVersion(rootE, "u1", 2, "shared-key");

            // Rerunning 008 must be safe (IF NOT EXISTS).
            await applyMigration(client, MIGRATION_008);
        });
    },
);

// Reviewer-terra slice 2 remediation: 008 is immutable (pushed to main, which
// auto-deploys) and genuinely blocks any 001-007 database carrying pre-008
// race duplicates — CREATE UNIQUE INDEX cannot build over duplicate keys.
// Migration 009 is the forward-safe fix: it reconciles duplicates
// deterministically and non-destructively, appends one audit row per
// decision, and creates the same partial unique index IF NOT EXISTS, so a
// stuck database reaches head by applying 009 and then re-applying 008.
describeDb(
    "migration 009 create-idempotency reconciliation (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;
        let client: PoolClient;

        beforeAll(async () => {
            // No max=1: the repository convergence check below acquires its
            // own connection while this suite's client stays checked out.
            pool = new Pool({ connectionString: DATABASE_URL_TEST });
            client = await pool.connect();
        });

        afterAll(async () => {
            client.release();
            await pool.end();
        });

        // The pre-008 chain: the state a duplicate-bearing database is in
        // when the upgrade to 008 first fails.
        const PRE_008_CHAIN = INTEGRITY_CHAIN.slice(0, 7);

        async function applyPre008(): Promise<void> {
            await resetSchema(client);
            for (const migration of PRE_008_CHAIN) {
                await applyMigration(client, migration);
            }
        }

        async function insertRoot(userId: string): Promise<string> {
            const { rows } = await client.query(
                `INSERT INTO supplement_products (user_id, category)
                 VALUES ($1, 'supplement') RETURNING id`,
                [userId],
            );
            return rows[0].id as string;
        }

        async function insertVersion(
            productId: string,
            userId: string,
            key: string | null,
            createdAt: string,
        ): Promise<void> {
            await client.query(
                `INSERT INTO supplement_product_versions
                    (product_id, version, user_id, revision_idempotency_key,
                     display_name, label_evidence, created_by, created_at)
                 VALUES ($1, 1, $2, $3, 'Label', '{}', 'test', $4)`,
                [productId, userId, key, createdAt],
            );
        }

        // Full label identity matching the repository convergence command in
        // the race test, plus one alias and one nutrient child row so the
        // non-destructive assertions have real label data to check.
        async function insertVersionWithChildren(
            productId: string,
            userId: string,
            key: string | null,
            createdAt: string,
        ): Promise<void> {
            await client.query(
                `INSERT INTO supplement_product_versions
                    (product_id, version, user_id, revision_idempotency_key,
                     display_name, short_name, brand, form,
                     serving_amount, serving_unit, serving_description,
                     label_evidence, label_source_kind, created_by, created_at)
                 VALUES ($1, 1, $2, $3,
                         'Race Whey', 'RW', 'RaceBrand', 'powder',
                         30, 'g', '1 scoop',
                         '{"kind":"label_photo"}', 'user_verified_label',
                         'test', $4)`,
                [productId, userId, key, createdAt],
            );
            await client.query(
                `INSERT INTO supplement_product_aliases
                    (product_id, version, user_id, alias, normalized_alias)
                 VALUES ($1, 1, $2, 'Race Whey', 'race whey')`,
                [productId, userId],
            );
            await client.query(
                `INSERT INTO supplement_product_nutrients
                    (product_id, version, nutrient_key, display_name,
                     amount, unit, source_evidence)
                 VALUES ($1, 1, 'protein_g', NULL, 21, 'g', '{}')`,
                [productId],
            );
        }

        async function versionKeys(
            productIds: string[],
        ): Promise<Map<string, string | null>> {
            const { rows } = await client.query(
                `SELECT product_id, revision_idempotency_key
                 FROM supplement_product_versions
                 WHERE version = 1 AND product_id = ANY($1)`,
                [productIds],
            );
            return new Map(
                rows.map((r) => [
                    r.product_id as string,
                    r.revision_idempotency_key as string | null,
                ]),
            );
        }

        async function auditRows(): Promise<Record<string, unknown>[]> {
            const { rows } = await client.query(
                `SELECT * FROM supplement_create_idem_reconciliation_audit`,
            );
            return rows;
        }

        test("001-007 database with race duplicates: 008 blocks, 009 reconciles deterministically, head is reachable, retries converge on the winner", async () => {
            await applyPre008();

            // Pre-008 race: two roots, same user, same create key, each with
            // alias + nutrient children. The older one must win.
            const winner = await insertRoot("u1");
            await insertVersionWithChildren(
                winner,
                "u1",
                "race-key",
                "2026-08-01T00:00:00Z",
            );
            const loser = await insertRoot("u1");
            await insertVersionWithChildren(
                loser,
                "u1",
                "race-key",
                "2026-08-01T00:00:01Z",
            );

            // Independent controls that reconciliation must never touch.
            const controlSolo = await insertRoot("u1");
            await insertVersion(
                controlSolo,
                "u1",
                "solo-key",
                "2026-08-01T00:00:02Z",
            );
            const controlOtherUser = await insertRoot("u2");
            await insertVersion(
                controlOtherUser,
                "u2",
                "race-key",
                "2026-08-01T00:00:03Z",
            );
            const controlNull = await insertRoot("u1");
            await insertVersion(
                controlNull,
                "u1",
                null,
                "2026-08-01T00:00:04Z",
            );

            // Deployment reality: immutable 008 genuinely blocks this
            // database — the unique index cannot build over duplicates.
            await expect(
                applyMigration(client, MIGRATION_008),
            ).rejects.toMatchObject({ code: "23505" });

            // 009 is the forward-safe remediation path.
            await applyMigration(client, MIGRATION_009);

            // Deterministic winner (oldest created_at) keeps the retry key;
            // the loser releases exactly its version-1 key and nothing else.
            const keys = await versionKeys([
                winner,
                loser,
                controlSolo,
                controlOtherUser,
                controlNull,
            ]);
            expect(keys.get(winner)).toBe("race-key");
            expect(keys.get(loser)).toBeNull();
            expect(keys.get(controlSolo)).toBe("solo-key");
            expect(keys.get(controlOtherUser)).toBe("race-key");
            expect(keys.get(controlNull)).toBeNull();

            // Non-destructive: the losing root, its version row, and every
            // child label fact remain fully readable.
            const { rows: loserData } = await client.query(
                `SELECT
                    (SELECT status FROM supplement_products
                      WHERE id = $1) AS root_status,
                    (SELECT count(*)::int FROM supplement_product_versions
                      WHERE product_id = $1) AS versions,
                    (SELECT count(*)::int FROM supplement_product_aliases
                      WHERE product_id = $1) AS aliases,
                    (SELECT count(*)::int FROM supplement_product_nutrients
                      WHERE product_id = $1) AS nutrients`,
                [loser],
            );
            expect(loserData[0]).toEqual({
                root_status: "active",
                versions: 1,
                aliases: 1,
                nutrients: 1,
            });

            // Exactly one complete append-only audit row for the group.
            const audit = await auditRows();
            expect(audit.length).toBe(1);
            expect(audit[0]).toMatchObject({
                migration: "009_supplement_create_idem_reconciliation",
                user_id: "u1",
                revision_idempotency_key: "race-key",
                winner_product_id: winner,
                winner_version: 1,
                loser_product_id: loser,
                loser_version: 1,
                decision: "null_loser_revision_idempotency_key",
            });
            expect(audit[0]!.reason).toContain("created_at");
            expect(audit[0]!.created_at).toBeTruthy();

            // The index now exists — created by 009 itself after
            // reconciliation, with the same definition 008 ships.
            const { rows: indexes } = await client.query(
                `SELECT indexdef FROM pg_indexes
                 WHERE schemaname = 'public'
                   AND indexname = 'uniq_spv_user_create_idem'`,
            );
            expect(indexes.length).toBe(1);
            expect(indexes[0].indexdef as string).toContain("UNIQUE");

            // 008 re-applies cleanly as a no-op: the chain reaches head.
            await applyMigration(client, MIGRATION_008);

            // A fresh same-key create converges on the reconciled winner
            // through the real repository path — deduplicated readback of
            // the winner, never a second root.
            const result = await createSupplementProduct(pool, {
                user_id: "u1",
                category: "supplement",
                display_name: "Race Whey",
                short_name: "RW",
                brand: "RaceBrand",
                form: "powder",
                serving_amount: 30,
                serving_unit: "g",
                serving_description: "1 scoop",
                aliases: ["Race Whey"],
                nutrients: [
                    { nutrient_key: "protein_g", amount: 21, unit: "g" },
                ],
                label_evidence: { kind: "label_photo" },
                label_source_kind: "user_verified_label",
                idempotency_key: "race-key",
                created_by: "test",
            } as CreateSupplementProductCommand);
            expect(result.deduplicated).toBe(true);
            expect(result.product.product_id).toBe(winner);
        });

        test("identical created_at breaks the tie by lowest product_id; rerun writes no duplicate audit and loses no data", async () => {
            await applyPre008();

            const LOW = "00000000-0000-0000-0000-000000000001";
            const HIGH = "00000000-0000-0000-0000-000000000002";
            await client.query(
                `INSERT INTO supplement_products (id, user_id, category)
                 VALUES ($1, 'u1', 'supplement'), ($2, 'u1', 'supplement')`,
                [LOW, HIGH],
            );
            // Insert the higher UUID first with an identical timestamp so
            // neither insertion order nor created_at can decide — only the
            // stable product_id tie-break can.
            const stamp = "2026-08-01T00:00:00Z";
            await insertVersionWithChildren(HIGH, "u1", "tie-key", stamp);
            await insertVersionWithChildren(LOW, "u1", "tie-key", stamp);

            await applyMigration(client, MIGRATION_009);

            const keys = await versionKeys([LOW, HIGH]);
            expect(keys.get(LOW)).toBe("tie-key");
            expect(keys.get(HIGH)).toBeNull();

            const audit = await auditRows();
            expect(audit.length).toBe(1);
            expect(audit[0]).toMatchObject({
                user_id: "u1",
                revision_idempotency_key: "tie-key",
                winner_product_id: LOW,
                loser_product_id: HIGH,
            });

            // Rerun: append-only audit stays at one row, keys stay decided,
            // and no product/label data is touched again.
            await applyMigration(client, MIGRATION_009);

            expect((await auditRows()).length).toBe(1);
            const keysAfter = await versionKeys([LOW, HIGH]);
            expect(keysAfter.get(LOW)).toBe("tie-key");
            expect(keysAfter.get(HIGH)).toBeNull();
            const { rows: survivorData } = await client.query(
                `SELECT
                    (SELECT count(*)::int FROM supplement_products) AS roots,
                    (SELECT count(*)::int FROM supplement_product_versions) AS versions,
                    (SELECT count(*)::int FROM supplement_product_aliases) AS aliases,
                    (SELECT count(*)::int FROM supplement_product_nutrients) AS nutrients`,
            );
            expect(survivorData[0]).toEqual({
                roots: 2,
                versions: 2,
                aliases: 2,
                nutrients: 2,
            });

            // After 009 the immutable 008 applies cleanly: head reached.
            await applyMigration(client, MIGRATION_008);
        });
    },
);

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
