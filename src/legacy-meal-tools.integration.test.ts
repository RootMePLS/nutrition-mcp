import {
    afterAll,
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

describeDb("legacy meal MCP tools use the event projection", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(() => pool.end());

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

    test("account cleanup removes all event children for one user only", async () => {
        await callTools(async (call) => {
            const result = await call("log_meal", {
                description: "cleanup me",
                meal_type: "snack",
                idempotency_key: "cleanup-u1",
            });
            expect(result.isError).not.toBe(true);
        });
        await callTools(async (call) => {
            const result = await call("log_meal", {
                description: "keep me",
                meal_type: "snack",
                idempotency_key: "cleanup-u2",
            });
            expect(result.isError).not.toBe(true);
        }, "u2");
        const { deleteAllUserData } = await import("./db.js");
        await deleteAllUserData("u1");
        const remaining = await pool.query(
            "SELECT user_id FROM meal_events ORDER BY user_id",
        );
        expect(remaining.rows.map((r) => r.user_id)).toEqual(["u2"]);
        const children = await pool.query(
            `SELECT count(*)::int AS count FROM meal_event_items
             WHERE event_id NOT IN (SELECT id FROM meal_events)`,
        );
        expect(children.rows[0]!.count).toBe(0);
    });
});
