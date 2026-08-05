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
    Boolean(DATABASE_URL_TEST) &&
    process.env.DATABASE_URL === DATABASE_URL_TEST;
const describeDb = RUN_DB_REGRESSION ? describe : describe.skip;

if (!RUN_DB_REGRESSION) {
    console.log(
        "src/legacy-meal-tools.integration.test.ts: SKIPPED — set DATABASE_URL and DATABASE_URL_TEST to the same disposable database URL",
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
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-legacy-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, "u1", false, null);
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
});
