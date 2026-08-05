// Local MCP SDK smoke: drives the real server tools over an in-memory MCP
// transport against the disposable database in DATABASE_URL (which must equal
// DATABASE_URL_TEST so nothing here can touch a non-test database).
//
// Covers the legacy surface end to end: log, reads, bulk import, update,
// delete, export. Exits non-zero on the first failed step.
//
//   DATABASE_URL=postgres://localhost/nutrition_mcp_test \
//   DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test \
//   bun run scripts/mcp-smoke.ts
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/mcp.js";
import { closePool } from "../src/db.js";
import { flushAnalytics } from "../src/analytics.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || process.env.DATABASE_URL_TEST !== databaseUrl) {
    console.error(
        "MCP smoke refused: DATABASE_URL and DATABASE_URL_TEST must both be set " +
            "to the same disposable PostgreSQL database.",
    );
    process.exit(2);
}

const USER = "smoke-user";
const exportsDir = join(
    fileURLToPath(new URL("..", import.meta.url)),
    "exports",
);

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

function check(step: string, ok: boolean, detail = ""): void {
    if (!ok) {
        console.error(`SMOKE FAIL [${step}] ${detail}`);
        process.exit(1);
    }
    console.log(`smoke ok: ${step}`);
}

const pool = new Pool({ connectionString: databaseUrl });

// Reset to a fresh schema from the real migrations.
const client0 = await pool.connect();
try {
    await client0.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    for (const migration of [
        "001_initial_schema.sql",
        "002_food_tracking.sql",
        "003_meal_captures.sql",
        "004_calculation_bundles.sql",
        "005_calculation_corrections.sql",
    ]) {
        await client0.query(
            await Bun.file(`db/migrations/${migration}`).text(),
        );
    }
} finally {
    client0.release();
}

const server = new McpServer(
    { name: "nutrition-mcp-smoke", version: "0.0.0" },
    { capabilities: { tools: {} } },
);
registerTools(server, USER, false, null);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke-client", version: "0.0.0" });
await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
]);

const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;

try {
    // log
    const logged = await call("log_meal", {
        description: "smoke oatmeal",
        meal_type: "breakfast",
        calories: 300,
        protein_g: 12,
        carbs_g: 54,
        fat_g: 6,
        logged_at: "2026-08-05T08:00:00.000Z",
        idempotency_key: "smoke-log",
    });
    check(
        "log_meal",
        !logged.isError && logged.content[0]!.text!.includes("smoke oatmeal"),
        JSON.stringify(logged.content),
    );

    // bulk import
    const bulk = await call("bulk_import_meals", {
        meals: [
            {
                source_line: 1,
                description: "smoke bulk rice",
                meal_type: "lunch",
                logged_at: "2026-08-05T13:00:00.000Z",
                calories: 450,
            },
        ],
        expected_row_count: 1,
        expected_total_kcal: 450,
        dry_run: false,
    });
    check(
        "bulk_import_meals",
        !bulk.isError &&
            (bulk.structuredContent?.summary as { created?: number })
                ?.created === 1,
        JSON.stringify(bulk.structuredContent),
    );

    // update
    const { rows } = await pool.query(
        "SELECT id FROM meal_events WHERE user_id = $1 AND idempotency_key = 'smoke-log'",
        [USER],
    );
    const mealId = rows[0]!.id as string;
    const updated = await call("update_meal", {
        id: mealId,
        calories: 350,
        notes: "smoke correction",
    });
    check(
        "update_meal",
        !updated.isError && updated.content[0]!.text!.includes("350"),
        JSON.stringify(updated.content),
    );

    // reads
    const byDate = await call("get_meals_by_date", { date: "2026-08-05" });
    check(
        "get_meals_by_date",
        !byDate.isError &&
            byDate.content[0]!.text!.includes("smoke oatmeal") &&
            byDate.content[0]!.text!.includes("smoke bulk rice") &&
            byDate.content[0]!.text!.includes("Calories: 350"),
        byDate.content[0]!.text ?? "",
    );
    const summary = await call("get_nutrition_summary", {
        start_date: "2026-08-05",
        end_date: "2026-08-05",
    });
    check(
        "get_nutrition_summary",
        !summary.isError && summary.structuredContent?.logged_days === 1,
        JSON.stringify(summary.structuredContent),
    );
    const search = await call("search_meals", {
        queries: ["smoke"],
        days: 3650,
        limit: 10,
    });
    check(
        "search_meals",
        !search.isError && search.content[0]!.text!.includes("smoke oatmeal"),
        search.content[0]!.text ?? "",
    );

    // export (before delete, so the file must exist)
    const exported = await call("export_meals");
    check(
        "export_meals",
        !exported.isError && exported.content[0]!.text!.includes("2 meal"),
        exported.content[0]!.text ?? "",
    );
    const csv = await Bun.file(`exports/${USER}/meals.csv`).text();
    check(
        "export csv content",
        csv.includes("smoke oatmeal") && csv.includes(",350,"),
        csv,
    );

    // delete
    const deleted = await call("delete_meal", { id: mealId });
    check("delete_meal", !deleted.isError, JSON.stringify(deleted.content));
    const afterDelete = await call("get_meals_by_date", {
        date: "2026-08-05",
    });
    check(
        "read excludes deleted",
        !afterDelete.content[0]!.text!.includes("smoke oatmeal") &&
            afterDelete.content[0]!.text!.includes("smoke bulk rice"),
        afterDelete.content[0]!.text ?? "",
    );

    console.log(
        "MCP smoke: all steps passed (log, bulk, update, reads, export, delete).",
    );
} finally {
    await flushAnalytics();
    await client.close();
    await server.close();
    await closePool();
    await pool.end();
    rmSync(exportsDir, { recursive: true, force: true });
}
