import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool } from "pg";
import { registerTools } from "./mcp.js";
import { flushAnalytics } from "./analytics.js";

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;
const RUN_DB_REGRESSION =
    process.env.RUN_LEGACY_MEAL_DB_TESTS === "1" &&
    Boolean(DATABASE_URL_TEST) &&
    process.env.DATABASE_URL === DATABASE_URL_TEST;
const describeDb = RUN_DB_REGRESSION ? describe : describe.skip;

if (!RUN_DB_REGRESSION) {
    console.log(
        "src/legacy-meal-tools.integration.test.ts: SKIPPED — set matching DATABASE_URL/DATABASE_URL_TEST and RUN_LEGACY_MEAL_DB_TESTS=1 for the isolated legacy DB regression suite",
    );
}

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

async function callTools(
    run: (
        call: (
            name: string,
            args?: Record<string, unknown>,
        ) => Promise<ToolResult>,
    ) => Promise<void>,
    userId = "u1",
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-legacy-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, userId, false, null);
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "legacy-test-client", version: "0.0.0" });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        await run(
            (name, args = {}) =>
                client.callTool({
                    name,
                    arguments: args,
                }) as Promise<ToolResult>,
        );
    } finally {
        await client.close();
        await server.close();
    }
}

const migrations = [
    "001_initial_schema.sql",
    "002_food_tracking.sql",
    "003_meal_captures.sql",
    "004_calculation_bundles.sql",
    "005_calculation_corrections.sql",
];

async function seedProjectionEvent(
    pool: Pool,
    opts: {
        userId: string;
        idempotencyKey: string;
        consumedAt: string;
        currentVersion?: number;
        status?: "active" | "deleted";
        description: string;
        calories: number | null;
        protein_g?: number | null;
        carbs_g?: number | null;
        fat_g?: number | null;
        canonicalStatus?: "pending" | "ready" | "low_confidence";
        consensusStatus?: string;
    },
): Promise<string> {
    const currentVersion = opts.currentVersion ?? 2;
    const { rows } = await pool.query(
        `INSERT INTO meal_events
            (user_id, reported_at, consumed_at, meal_type, status, current_version, idempotency_key)
         VALUES ($1, $2, $2, 'lunch', $3, $4, $5) RETURNING id`,
        [
            opts.userId,
            opts.consumedAt,
            opts.status ?? "active",
            currentVersion,
            opts.idempotencyKey,
        ],
    );
    const eventId = rows[0]!.id as string;
    for (let version = 1; version <= currentVersion; version++) {
        await pool.query(
            `INSERT INTO meal_event_versions
                (event_id, version, raw_text_snapshot, parser_policy_version, created_by)
             VALUES ($1, $2, $3, 'fixture', 'terra-test')`,
            [eventId, version, `${opts.description} v${version}`],
        );
        await pool.query(
            `INSERT INTO meal_event_items
                (event_id, version, ordinal, raw_item_text, normalized_name, notes)
             VALUES ($1, $2, 0, $3, $3, $4)`,
            [
                eventId,
                version,
                version === currentVersion
                    ? opts.description
                    : `${opts.description} stale`,
                version === currentVersion ? null : "stale note",
            ],
        );
        await pool.query(
            `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status, calories, protein_g,
                 carbs_g, fat_g, fiber_g, sugar_g, alcohol_g, policy_version)
             VALUES ($1, $2, NULL, $5, $6, $3, $4, $7, $8, NULL, NULL, NULL, 'fixture')`,
            [
                eventId,
                version,
                version === currentVersion ? opts.calories : 9999,
                version === currentVersion
                    ? opts.protein_g === undefined
                        ? 20
                        : opts.protein_g
                    : 999,
                opts.canonicalStatus ?? "ready",
                opts.consensusStatus ?? "all_agree",
                version === currentVersion
                    ? opts.carbs_g === undefined
                        ? 10
                        : opts.carbs_g
                    : 10,
                version === currentVersion
                    ? opts.fat_g === undefined
                        ? 5
                        : opts.fat_g
                    : 5,
            ],
        );
    }
    // An item-scope canonical row must not be mistaken for the event total.
    await pool.query(
        `INSERT INTO meal_event_canonical_results
            (event_id, version, ordinal, status, consensus_status, calories, protein_g,
             carbs_g, fat_g, policy_version)
         VALUES ($1, $2, 0, 'ready', 'all_agree', 777, 777, 777, 777, 'fixture')`,
        [eventId, currentVersion],
    );
    return eventId;
}

describeDb("legacy meal MCP tools use the event projection", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(() => pool.end());

    // Drain fire-and-forget analytics writes before the next test drops the
    // schema, so no write lands on a missing tool_analytics table.
    afterEach(async () => {
        await flushAnalytics();
    });

    beforeEach(async () => {
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            for (const migration of migrations) {
                await client.query(
                    await Bun.file(`db/migrations/${migration}`).text(),
                );
            }
        } finally {
            client.release();
        }
    });

    test("log and all eight legacy reads work through the real MCP transport", async () => {
        await callTools(async (call) => {
            const logged = await call("log_meal", {
                description: "oatmeal with banana",
                meal_type: "breakfast",
                calories: 500,
                protein_g: 20,
                carbs_g: 80,
                fat_g: 10,
                fiber_g: 8,
                sugar_g: 12,
                logged_at: "2026-08-05T08:00:00.000Z",
                idempotency_key: "legacy-mcp-read-regression",
            });
            expect(logged.isError).not.toBe(true);

            const byDate = await call("get_meals_by_date", {
                date: "2026-08-05",
            });
            expect(byDate.isError).not.toBe(true);
            expect(byDate.content[0]!.text).toContain("oatmeal");
            expect(byDate.content[0]!.text).toContain("Calories: 500");

            const today = await call("get_meals_today");
            expect(today.isError).not.toBe(true);
            expect(today.content[0]!.text).toContain("oatmeal");

            const range = await call("get_meals_by_date_range", {
                start_date: "2026-08-05",
                end_date: "2026-08-05",
            });
            expect(range.isError).not.toBe(true);
            expect(range.content[0]!.text).toContain("2026-08-05");

            const summary = await call("get_nutrition_summary", {
                start_date: "2026-08-05",
                end_date: "2026-08-05",
            });
            expect(summary.isError).not.toBe(true);
            expect(summary.structuredContent?.logged_days).toBe(1);
            expect((summary.structuredContent?.meals as unknown[]).length).toBe(
                1,
            );

            const progress = await call("get_goal_progress", {
                date: "2026-08-05",
            });
            expect(progress.isError).not.toBe(true);
            expect(progress.structuredContent?.meal_count).toBe(1);

            const trends = await call("get_trends", {
                days: 7,
                end_date: "2026-08-05",
            });
            expect(trends.isError).not.toBe(true);
            expect((trends.structuredContent?.days as unknown[]).length).toBe(
                30,
            );

            const patterns = await call("get_meal_patterns", {
                days: 7,
                end_date: "2026-08-05",
            });
            expect(patterns.isError).not.toBe(true);
            expect(patterns.content[0]!.text).toContain("Patterns —");

            const search = await call("search_meals", {
                queries: ["oatmeal"],
                days: 3650,
                limit: 10,
            });
            expect(search.isError).not.toBe(true);
            expect(search.content[0]!.text).toContain("oatmeal");
        });

        const events = await pool.query(
            "SELECT count(*)::int AS count FROM meal_events WHERE user_id = $1 AND status = 'active'",
            ["u1"],
        );
        expect(events.rows[0]!.count).toBe(1);
        const legacy = await pool.query(
            "SELECT to_regclass('public.meals') AS table_name",
        );
        expect(legacy.rows[0]!.table_name).toBeNull();
    });

    test("bulk import, update, delete and export use current append-only projections", async () => {
        let mealId = "";
        await callTools(async (call) => {
            const imported = await call("bulk_import_meals", {
                meals: [
                    {
                        source_line: 1,
                        description: "bulk oats",
                        meal_type: "breakfast",
                        logged_at: "2026-08-05T23:30:00.000Z",
                        calories: 321,
                        notes: "keep this",
                    },
                ],
                expected_row_count: 1,
                expected_total_kcal: 321,
                dry_run: false,
            });
            expect(imported.isError).not.toBe(true);
            expect(imported.structuredContent?.summary).toMatchObject({
                created: 1,
            });

            const row = await pool.query(
                "SELECT id FROM meal_events WHERE user_id = $1",
                ["u1"],
            );
            mealId = row.rows[0]!.id as string;
            const updated = await call("update_meal", {
                id: mealId,
                meal_type: "dinner",
                logged_at: "2026-08-06T00:30:00.000Z",
                notes: null,
                calories: 333,
            });
            expect(updated.isError).not.toBe(true);
            expect(updated.content[0]!.text).toContain("333");

            const retry = await call("update_meal", {
                id: mealId,
                meal_type: "dinner",
                logged_at: "2026-08-06T00:30:00.000Z",
                notes: null,
                calories: 333,
            });
            expect(retry.isError).not.toBe(true);

            const deleted = await call("delete_meal", { id: mealId });
            expect(deleted.isError).not.toBe(true);
            const exported = await call("export_meals");
            expect(exported.isError).not.toBe(true);
            expect(exported.content[0]!.text).toContain("No meals");
        });

        const versions = await pool.query(
            `SELECT version, raw_text_snapshot FROM meal_event_versions
             WHERE event_id = $1 ORDER BY version`,
            [mealId],
        );
        expect(versions.rows.map((r) => r.version)).toEqual([1, 2]);
        const root = await pool.query(
            "SELECT meal_type, consumed_at, status FROM meal_events WHERE id = $1",
            [mealId],
        );
        expect(root.rows[0]).toMatchObject({
            meal_type: "dinner",
            status: "deleted",
        });
        expect(new Date(root.rows[0]!.consumed_at).toISOString()).toBe(
            "2026-08-06T00:30:00.000Z",
        );
        const notes = await pool.query(
            `SELECT notes FROM meal_event_items WHERE event_id = $1 AND version = 1`,
            [mealId],
        );
        expect(notes.rows[0]!.notes).toBe("keep this");
        const currentNotes = await pool.query(
            `SELECT notes FROM meal_event_items WHERE event_id = $1 AND version = 2`,
            [mealId],
        );
        expect(currentNotes.rows[0]!.notes).toBeNull();
    });

    test("correction and cleanup are user scoped and preserve another user's rows", async () => {
        let userOneId = "";
        await callTools(async (call) => {
            const logged = await call("log_meal", {
                description: "user one meal",
                meal_type: "lunch",
                logged_at: "2026-08-05T23:59:00.000Z",
                idempotency_key: "scope-u1",
            });
            expect(logged.isError).not.toBe(true);
            const row = await pool.query(
                "SELECT id FROM meal_events WHERE user_id = $1",
                ["u1"],
            );
            userOneId = row.rows[0]!.id as string;
        });
        await callTools(async (call) => {
            const logged = await call("log_meal", {
                description: "user two meal",
                meal_type: "dinner",
                idempotency_key: "scope-u2",
            });
            expect(logged.isError).not.toBe(true);
            const foreign = await call("update_meal", {
                id: userOneId,
                notes: "must not change",
            });
            expect(foreign.isError).toBe(true);
        }, "u2");
        const unchanged = await pool.query(
            `SELECT count(*)::int AS count FROM meal_event_items
             WHERE event_id = $1 AND version = 1 AND notes IS NULL`,
            [userOneId],
        );
        expect(unchanged.rows[0]!.count).toBe(1);
    });

    test("projection reads only current event scope, excludes deleted rows, preserves nulls, and respects timezone boundaries", async () => {
        await pool.query(
            "INSERT INTO profiles (user_id, timezone) VALUES ('u1', 'America/New_York')",
        );
        const currentId = await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "projection-current",
            consumedAt: "2026-08-05T04:00:00.000Z",
            description: "current oatmeal",
            calories: 250,
            protein_g: 20,
        });
        await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "projection-deleted",
            consumedAt: "2026-08-05T05:00:00.000Z",
            description: "deleted oatmeal",
            calories: 900,
            status: "deleted",
        });
        await seedProjectionEvent(pool, {
            userId: "u2",
            idempotencyKey: "projection-other-user",
            consumedAt: "2026-08-05T04:00:00.000Z",
            description: "private oatmeal",
            calories: 700,
        });
        await callTools(async (call) => {
            const onBoundary = await call("get_meals_by_date", {
                date: "2026-08-05",
            });
            expect(onBoundary.isError).not.toBe(true);
            expect(onBoundary.content[0]!.text).toContain("current oatmeal");
            expect(onBoundary.content[0]!.text).not.toContain(
                "deleted oatmeal",
            );
            expect(onBoundary.content[0]!.text).toContain("Calories: 250");
            expect(onBoundary.content[0]!.text).not.toContain("9999");

            const summary = await call("get_nutrition_summary", {
                start_date: "2026-08-04",
                end_date: "2026-08-05",
            });
            expect(summary.content[0]!.text).toContain("250 kcal");
            expect(summary.content[0]!.text).not.toContain("9999");

            const search = await call("search_meals", {
                queries: ["oatmeal"],
                days: 3650,
                limit: 10,
            });
            expect(search.content[0]!.text).toContain("current oatmeal");
            expect(search.content[0]!.text).not.toContain("deleted oatmeal");

            const exported = await call("export_meals");
            expect(exported.content[0]!.text).toContain("1 meal");
            const csv = await Bun.file("./exports/u1/meals.csv").text();
            expect(csv).toContain("current oatmeal");
            expect(csv).toContain(",250,20,");
            expect(csv).not.toContain("deleted oatmeal");
        });
        await callTools(async (call) => {
            const foreignDate = await call("get_meals_by_date", {
                date: "2026-08-05",
            });
            expect(foreignDate.content[0]!.text).toContain("private oatmeal");
            expect(foreignDate.content[0]!.text).not.toContain(
                "current oatmeal",
            );
            expect(foreignDate.content[0]!.text).not.toContain(
                "deleted oatmeal",
            );
            const foreignSearch = await call("search_meals", {
                queries: ["oatmeal"],
                days: 3650,
                limit: 10,
            });
            expect(foreignSearch.content[0]!.text).toContain("private oatmeal");
            expect(foreignSearch.content[0]!.text).not.toContain(
                "current oatmeal",
            );
            const foreignExport = await call("export_meals");
            expect(foreignExport.content[0]!.text).toContain("1 meal");
            expect(foreignExport.content[0]!.text).not.toContain(
                "current oatmeal",
            );
            expect(
                (await call("update_meal", { id: currentId, calories: 1 }))
                    .isError,
            ).toBe(true);
            expect(
                (await call("delete_meal", { id: currentId })).isError,
            ).not.toBe(true);
        }, "u2");
        const unchanged = await pool.query(
            "SELECT status, current_version FROM meal_events WHERE id = $1",
            [currentId],
        );
        expect(unchanged.rows[0]).toMatchObject({
            status: "active",
            current_version: 2,
        });
    });

    test("bulk import covers multi-row control totals and duplicate retry idempotency", async () => {
        const rows = [
            {
                source_line: 10,
                description: "bulk one",
                meal_type: "breakfast",
                logged_at: "2026-08-05T08:00:00.000Z",
                calories: 101,
            },
            {
                source_line: 11,
                description: "bulk two",
                meal_type: "dinner",
                logged_at: "2026-08-05T19:00:00.000Z",
                calories: 202,
            },
        ];
        await callTools(async (call) => {
            const imported = await call("bulk_import_meals", {
                meals: rows,
                expected_row_count: 2,
                expected_total_kcal: 303,
                dry_run: false,
            });
            expect(imported.structuredContent?.summary).toMatchObject({
                total: 2,
                created: 2,
                deduplicated: 0,
            });
            const retry = await call("bulk_import_meals", {
                meals: rows,
                expected_row_count: 2,
                expected_total_kcal: 303,
                dry_run: false,
            });
            expect(retry.structuredContent?.summary).toMatchObject({
                total: 2,
                created: 0,
                deduplicated: 2,
            });
            const rejected = await call("bulk_import_meals", {
                meals: rows,
                expected_row_count: 2,
                expected_total_kcal: 400,
                dry_run: false,
            });
            expect(rejected.structuredContent?.status).toBe("failed");
            expect(rejected.structuredContent?.summary).toMatchObject({
                created: 0,
            });
        });
        const count = await pool.query(
            "SELECT count(*)::int AS count FROM meal_events WHERE user_id = 'u1' AND status = 'active'",
        );
        expect(count.rows[0]!.count).toBe(2);
    });

    test("pending event-scope nutrition retains nulls end to end and never fabricates zeros", async () => {
        const pendingId = await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "pending-nutrition",
            consumedAt: "2026-08-06T12:00:00.000Z",
            currentVersion: 1,
            description: "pending oats",
            calories: null,
            protein_g: null,
            carbs_g: null,
            fat_g: null,
            canonicalStatus: "pending",
            consensusStatus: "insufficient_data",
        });
        await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "ready-nutrition",
            consumedAt: "2026-08-05T12:00:00.000Z",
            currentVersion: 1,
            description: "ready oats",
            calories: 250,
            protein_g: 20,
        });

        // The stored event-scope canonical row stays pending with NULL nutrients.
        const stored = await pool.query(
            `SELECT status, calories, protein_g FROM meal_event_canonical_results
             WHERE event_id = $1 AND ordinal IS NULL`,
            [pendingId],
        );
        expect(stored.rows[0]).toMatchObject({
            status: "pending",
            calories: null,
            protein_g: null,
        });

        await callTools(async (call) => {
            // Reads retain nulls: no fabricated "Calories: 0" line.
            const byDate = await call("get_meals_by_date", {
                date: "2026-08-06",
            });
            expect(byDate.isError).not.toBe(true);
            expect(byDate.content[0]!.text).toContain("pending oats");
            expect(byDate.content[0]!.text).not.toContain("Calories:");
            expect(byDate.content[0]!.text).not.toContain("Protein:");

            // Approved aggregation contract: a pending event still counts as a
            // logged meal but adds nothing to the nutrient sums, while the
            // ready event on the other day keeps its values.
            const summary = await call("get_nutrition_summary", {
                start_date: "2026-08-05",
                end_date: "2026-08-06",
            });
            expect(summary.isError).not.toBe(true);
            const days = summary.structuredContent?.days as {
                date: string;
                meal_count: number;
                calories: number;
                protein_g: number;
            }[];
            expect(days.find((d) => d.date === "2026-08-05")).toMatchObject({
                meal_count: 1,
                calories: 250,
                protein_g: 20,
            });
            expect(days.find((d) => d.date === "2026-08-06")).toMatchObject({
                meal_count: 1,
                calories: 0,
                protein_g: 0,
            });
            expect(summary.content[0]!.text).not.toContain("NaN");

            // Export keeps empty fields for the pending event, never zeros.
            const exported = await call("export_meals");
            expect(exported.isError).not.toBe(true);
            expect(exported.content[0]!.text).toContain("2 meal");
            const csv = await Bun.file("./exports/u1/meals.csv").text();
            const pendingLine = csv
                .split("\n")
                .find((line) => line.includes("pending oats"))!;
            // id, logged_at, timezone, meal_type, description, then the eight
            // nutrient/notes fields — all empty for a pending event.
            expect(pendingLine.split(",").slice(5)).toEqual([
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
            ]);
        });
    });

    test("timezone local midnight assigns events to the correct local day on both sides", async () => {
        await pool.query(
            "INSERT INTO profiles (user_id, timezone) VALUES ('u1', 'America/New_York')",
        );
        // New York is UTC-4 in August: 04:00:00Z is exactly local midnight.
        await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "tz-before-midnight",
            consumedAt: "2026-08-05T03:59:59.000Z", // 2026-08-04 23:59:59 local
            currentVersion: 1,
            description: "before midnight snack",
            calories: 111,
        });
        await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "tz-after-midnight",
            consumedAt: "2026-08-05T04:00:01.000Z", // 2026-08-05 00:00:01 local
            currentVersion: 1,
            description: "after midnight snack",
            calories: 222,
        });
        await callTools(async (call) => {
            const before = await call("get_meals_by_date", {
                date: "2026-08-04",
            });
            expect(before.isError).not.toBe(true);
            expect(before.content[0]!.text).toContain("before midnight snack");
            expect(before.content[0]!.text).not.toContain(
                "after midnight snack",
            );

            const after = await call("get_meals_by_date", {
                date: "2026-08-05",
            });
            expect(after.isError).not.toBe(true);
            expect(after.content[0]!.text).toContain("after midnight snack");
            expect(after.content[0]!.text).not.toContain(
                "before midnight snack",
            );

            const summary = await call("get_nutrition_summary", {
                start_date: "2026-08-04",
                end_date: "2026-08-05",
            });
            expect(summary.isError).not.toBe(true);
            const days = summary.structuredContent?.days as {
                date: string;
                meal_count: number;
                calories: number;
            }[];
            expect(days.find((d) => d.date === "2026-08-04")).toMatchObject({
                meal_count: 1,
                calories: 111,
            });
            expect(days.find((d) => d.date === "2026-08-05")).toMatchObject({
                meal_count: 1,
                calories: 222,
            });
        });
    });

    test("export carries the active correction before deletion excludes the event", async () => {
        let mealId = "";
        await callTools(async (call) => {
            const logged = await call("log_meal", {
                description: "correction export meal",
                meal_type: "lunch",
                calories: 400,
                protein_g: 30,
                carbs_g: 50,
                fat_g: 12,
                logged_at: "2026-08-05T12:00:00.000Z",
                idempotency_key: "export-correction",
            });
            expect(logged.isError).not.toBe(true);
            const row = await pool.query(
                "SELECT id FROM meal_events WHERE user_id = $1",
                ["u1"],
            );
            mealId = row.rows[0]!.id as string;

            const corrected = await call("update_meal", {
                id: mealId,
                meal_type: "dinner",
                logged_at: "2026-08-05T18:30:00.000Z",
                calories: 555,
                protein_g: 35,
                notes: "corrected note",
            });
            expect(corrected.isError).not.toBe(true);

            // Export BEFORE deletion: exactly one row with the corrected
            // current-version totals and root fields.
            const exported = await call("export_meals");
            expect(exported.isError).not.toBe(true);
            expect(exported.content[0]!.text).toContain("1 meal");
            const csv = await Bun.file("./exports/u1/meals.csv").text();
            const lines = csv.split("\n");
            expect(lines.length).toBe(2); // header + one data row
            const fields = lines[1]!.split(",");
            expect(fields[1]).toBe("2026-08-05 18:30:00");
            expect(fields[3]).toBe("dinner");
            expect(fields[4]).toBe("correction export meal");
            expect(fields[5]).toBe("555");
            expect(fields[6]).toBe("35");
            expect(fields[12]).toBe("corrected note");

            // Only after the export does deletion exclude the event.
            const deleted = await call("delete_meal", { id: mealId });
            expect(deleted.isError).not.toBe(true);
            const afterDelete = await call("export_meals");
            expect(afterDelete.isError).not.toBe(true);
            expect(afterDelete.content[0]!.text).toContain("No meals");
        });
        const root = await pool.query(
            "SELECT meal_type, status, current_version FROM meal_events WHERE id = $1",
            [mealId],
        );
        expect(root.rows[0]).toMatchObject({
            meal_type: "dinner",
            status: "deleted",
            current_version: 2,
        });
    });

    test("account cleanup removes every event child and preserves unrelated user data", async () => {
        const u1 = await seedProjectionEvent(pool, {
            userId: "u1",
            idempotencyKey: "cleanup-all-u1",
            consumedAt: "2026-08-05T12:00:00.000Z",
            description: "cleanup root",
            calories: 100,
        });
        const u2 = await seedProjectionEvent(pool, {
            userId: "u2",
            idempotencyKey: "cleanup-all-u2",
            consumedAt: "2026-08-05T12:00:00.000Z",
            description: "preserve root",
            calories: 200,
        });
        const childRows: Record<string, string>[] = [
            {
                table: "meal_event_inputs",
                columns:
                    "event_id, version, source_kind, content, content_hash, precedence",
                values: `'${u1}', 1, 'user_text', 'fixture', 'cleanup-hash', 10`,
            },
            {
                table: "meal_event_media",
                columns:
                    "event_id, version, kind, storage_key, mime_type, byte_size, sha256",
                values: `'${u1}', 1, 'photo', 'cleanup.jpg', 'image/jpeg', 1, 'cleanup-sha'`,
            },
            {
                table: "meal_event_nutrition_results",
                columns:
                    "event_id, version, provider, source_id, status, request_fingerprint, algorithm_version",
                values: `'${u1}', 1, 'own', 'cleanup-source', 'unavailable', 'cleanup-fp', 'fixture'`,
            },
            {
                table: "meal_event_sync_journal",
                columns:
                    "event_id, version, system, operation, request_fingerprint, authorization_source",
                values: `'${u1}', 1, 'cleanup', 'delete', 'cleanup-journal', 'user'`,
            },
        ];
        for (const row of childRows) {
            await pool.query(
                `INSERT INTO ${row.table} (${row.columns}) VALUES (${row.values})`,
            );
        }
        await pool.query(
            "INSERT INTO tool_analytics (user_id, tool_name, success, duration_ms) VALUES ('u1', 'fixture', true, 1), ('u2', 'fixture', true, 1)",
        );
        await pool.query(
            "INSERT INTO profiles (user_id, timezone) VALUES ('u1', 'UTC'), ('u2', 'UTC')",
        );
        await pool.query(
            "INSERT INTO nutrition_goals (user_id, daily_calories) VALUES ('u1', 1), ('u2', 2)",
        );
        await pool.query(
            "INSERT INTO water_log (user_id, amount_ml) VALUES ('u1', 1), ('u2', 2)",
        );
        await pool.query(
            "INSERT INTO weight_log (user_id, weight_g) VALUES ('u1', 1), ('u2', 2)",
        );
        const { deleteAllUserData } = await import("./db.js");
        await deleteAllUserData("u1");
        const counts = await pool.query(
            `SELECT
                (SELECT count(*) FROM meal_events WHERE user_id = 'u1') AS roots,
                (SELECT count(*) FROM meal_event_items WHERE event_id = $1) AS items,
                (SELECT count(*) FROM meal_event_inputs WHERE event_id = $1) AS inputs,
                (SELECT count(*) FROM meal_event_media WHERE event_id = $1) AS media,
                (SELECT count(*) FROM meal_event_nutrition_results WHERE event_id = $1) AS nutrition,
                (SELECT count(*) FROM meal_event_canonical_results WHERE event_id = $1) AS canonical,
                (SELECT count(*) FROM meal_event_sync_journal WHERE event_id = $1) AS journal,
                (SELECT count(*) FROM meal_event_versions WHERE event_id = $1) AS versions`,
            [u1],
        );
        expect(Object.values(counts.rows[0]!).map(Number)).toEqual([
            0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        const preserved = await pool.query(
            `SELECT
                (SELECT count(*) FROM meal_events WHERE user_id = 'u2') AS roots,
                (SELECT count(*) FROM profiles WHERE user_id = 'u2') AS profile,
                (SELECT count(*) FROM nutrition_goals WHERE user_id = 'u2') AS goals,
                (SELECT count(*) FROM water_log WHERE user_id = 'u2') AS water,
                (SELECT count(*) FROM weight_log WHERE user_id = 'u2') AS weight,
                (SELECT count(*) FROM tool_analytics WHERE user_id = 'u2') AS analytics`,
        );
        expect(Object.values(preserved.rows[0]!).map(Number)).toEqual([
            1, 1, 1, 1, 1, 1,
        ]);
    });
});
