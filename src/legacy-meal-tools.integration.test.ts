import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    setSystemTime,
    test,
} from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool } from "pg";
import { registerTools, TOTALS_ITEM, TRENDS_DAY_ITEM } from "./mcp.js";
import {
    LOG_WATER_OUTPUT_SCHEMA,
    WATER_DAY_OUTPUT_SCHEMA,
    DELETE_WATER_OUTPUT_SCHEMA,
    LOG_WEIGHT_OUTPUT_SCHEMA,
    WEIGHT_DAY_OUTPUT_SCHEMA,
    WEIGHT_RANGE_OUTPUT_SCHEMA,
    UPDATE_WEIGHT_OUTPUT_SCHEMA,
    DELETE_WEIGHT_OUTPUT_SCHEMA,
    WEIGHT_TRENDS_OUTPUT_SCHEMA,
    WIDGET_DISPLAY_OUTPUT_SCHEMA,
    START_IMPORT_OUTPUT_SCHEMA,
} from "./mcp.js";
import { z } from "zod";
import { flushAnalytics } from "./analytics.js";
import { MEAL_PROGRESS_OUTPUT_SCHEMA } from "./mcp.js";
import { BULK_IMPORT_OUTPUT_SCHEMA } from "./import.js";
import {
    CALCULATION_BUNDLE_OUTPUT_SCHEMA,
    CALCULATION_CORRECTION_OUTPUT_SCHEMA,
    CALCULATION_PROVENANCE_OUTPUT_SCHEMA,
} from "./calculation-bundles.js";
import {
    stableBundleFingerprint,
    type CalculationBundleInput,
} from "./nutrition-bundle-types.js";

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;
const RUN_DB_REGRESSION =
    process.env.RUN_LEGACY_MEAL_DB_TESTS === "1" &&
    Boolean(DATABASE_URL_TEST) &&
    process.env.DATABASE_URL === DATABASE_URL_TEST;
const describeDb = RUN_DB_REGRESSION ? describe.serial : describe.skip;
let activePool: Pool | null = null;

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

// The declared public output schemas, reused to PARSE every structured
// payload the presence assertions touch — toMatchObject alone cannot prove
// the payload still satisfies the contract a real MCP client validates
// against.
const SUMMARY_DAYS = z.array(
    TOTALS_ITEM.extend({ date: z.string(), meal_count: z.number() }),
);
const TREND_DAYS = z.array(TRENDS_DAY_ITEM);

async function callTools(
    run: (
        call: (
            name: string,
            args?: Record<string, unknown>,
        ) => Promise<ToolResult>,
        client: Client,
    ) => Promise<void>,
    userId = "u1",
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-legacy-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, userId, false, null, {
        mealEventsPool: activePool ?? undefined,
    });
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
            client,
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
        activePool = pool;
    });

    afterAll(async () => {
        activePool = null;
        await pool.end();
    });

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

    test.serial(
        "log and all eight legacy reads work through the real MCP transport",
        async () => {
            // Computed, not hardcoded: get_meals_today resolves "today" in
            // UTC for a profile-less user, so a fixed calendar date makes
            // this test fail the day after it was written. Freeze the clock
            // at noon UTC of the real current day so the sampled `day` and
            // the server's live "today" cannot diverge if UTC midnight
            // passes mid-test.
            const frozenNow = new Date(
                `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`,
            );
            setSystemTime(frozenNow);
            const day = frozenNow.toISOString().slice(0, 10);
            try {
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
                        logged_at: `${day}T08:00:00.000Z`,
                        idempotency_key: "legacy-mcp-read-regression",
                    });
                    expect(logged.isError).not.toBe(true);

                    const byDate = await call("get_meals_by_date", {
                        date: day,
                    });
                    expect(byDate.isError).not.toBe(true);
                    expect(byDate.content[0]!.text).toContain("oatmeal");
                    expect(byDate.content[0]!.text).toContain("Calories: 500");

                    const today = await call("get_meals_today");
                    expect(today.isError).not.toBe(true);
                    expect(today.content[0]!.text).toContain("oatmeal");

                    const range = await call("get_meals_by_date_range", {
                        start_date: day,
                        end_date: day,
                    });
                    expect(range.isError).not.toBe(true);
                    expect(range.content[0]!.text).toContain(day);

                    const summary = await call("get_nutrition_summary", {
                        start_date: day,
                        end_date: day,
                    });
                    expect(summary.isError).not.toBe(true);
                    expect(summary.structuredContent?.logged_days).toBe(1);
                    expect(
                        (summary.structuredContent?.meals as unknown[]).length,
                    ).toBe(1);

                    const progress = await call("get_goal_progress", {
                        date: day,
                    });
                    expect(progress.isError).not.toBe(true);
                    expect(progress.structuredContent?.meal_count).toBe(1);

                    const trends = await call("get_trends", {
                        days: 7,
                        end_date: day,
                    });
                    expect(trends.isError).not.toBe(true);
                    expect(
                        (trends.structuredContent?.days as unknown[]).length,
                    ).toBe(30);

                    const patterns = await call("get_meal_patterns", {
                        days: 7,
                        end_date: day,
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
            } finally {
                setSystemTime();
            }
        },
    );

    test.serial(
        "bulk import, update, delete and export use current append-only projections",
        async () => {
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
        },
    );

    test.serial(
        "correction and cleanup are user scoped and preserve another user's rows",
        async () => {
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
        },
    );

    test.serial(
        "projection reads only current event scope, excludes deleted rows, preserves nulls, and respects timezone boundaries",
        async () => {
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
                expect(onBoundary.content[0]!.text).toContain(
                    "current oatmeal",
                );
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
                expect(search.content[0]!.text).not.toContain(
                    "deleted oatmeal",
                );

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
                expect(foreignDate.content[0]!.text).toContain(
                    "private oatmeal",
                );
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
                expect(foreignSearch.content[0]!.text).toContain(
                    "private oatmeal",
                );
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
        },
    );

    test.serial(
        "bulk import covers multi-row control totals and duplicate retry idempotency",
        async () => {
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
        },
    );

    test.serial(
        "pending event-scope nutrition retains nulls end to end and never fabricates zeros",
        async () => {
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

                // Presence contract (campaign decision D4): a pending event
                // still counts as a logged meal (meals_total), but its core
                // macros are NULL — never a fabricated 0 — and the per-macro
                // meals_calculated counts disclose that each sum covers
                // nothing on the pending day.
                const summary = await call("get_nutrition_summary", {
                    start_date: "2026-08-05",
                    end_date: "2026-08-06",
                });
                expect(summary.isError).not.toBe(true);
                const days = SUMMARY_DAYS.parse(
                    summary.structuredContent?.days,
                );
                expect(days.find((d) => d.date === "2026-08-05")).toMatchObject(
                    {
                        meal_count: 1,
                        calories: 250,
                        protein_g: 20,
                        meals_total: 1,
                        meals_calculated: {
                            calories: 1,
                            protein_g: 1,
                            carbs_g: 1,
                            fat_g: 1,
                        },
                    },
                );
                expect(days.find((d) => d.date === "2026-08-06")).toMatchObject(
                    {
                        meal_count: 1,
                        calories: null,
                        protein_g: null,
                        meals_total: 1,
                        meals_calculated: {
                            calories: 0,
                            protein_g: 0,
                            carbs_g: 0,
                            fat_g: 0,
                        },
                    },
                );
                // The range average keeps the historical denominator (every
                // logged day) but cannot invent a figure for the pending day:
                // 250 over 2 logged days, with the per-macro counts exposing
                // that only 1 of 2 meals carries each nutrient.
                const averages = TOTALS_ITEM.parse(
                    summary.structuredContent?.averages,
                );
                expect(averages.calories).toBe(125);
                expect(averages.meals_total).toBe(2);
                expect(averages.meals_calculated).toEqual({
                    calories: 1,
                    protein_g: 1,
                    carbs_g: 1,
                    fat_g: 1,
                });
                expect(summary.content[0]!.text).not.toContain("NaN");
                expect(summary.content[0]!.text).toContain("no data yet");

                // Goal progress over the pending day: null totals, "no data
                // yet" in the text — never "Calories: 0", "0%" of goal, NaN.
                const progress = await call("get_goal_progress", {
                    date: "2026-08-06",
                });
                expect(progress.isError).not.toBe(true);
                const progressTotals = TOTALS_ITEM.parse(
                    progress.structuredContent?.totals,
                );
                expect(progressTotals).toMatchObject({
                    calories: null,
                    protein_g: null,
                    carbs_g: null,
                    fat_g: null,
                    meals_total: 1,
                    meals_calculated: {
                        calories: 0,
                        protein_g: 0,
                        carbs_g: 0,
                        fat_g: 0,
                    },
                });
                expect(progress.content[0]!.text).toContain("no data yet");
                expect(progress.content[0]!.text).not.toContain("Calories: 0");
                expect(progress.content[0]!.text).not.toContain("NaN");

                // Trends per-day series: the pending day is null-with-counts,
                // the ready day keeps its values.
                const trends = await call("get_trends", {
                    days: 2,
                    end_date: "2026-08-06",
                });
                expect(trends.isError).not.toBe(true);
                const trendDays = TREND_DAYS.parse(
                    trends.structuredContent?.days,
                );
                expect(
                    trendDays.find((d) => d.date === "2026-08-06"),
                ).toMatchObject({
                    calories: null,
                    protein_g: null,
                    meals_total: 1,
                    meals_calculated: {
                        calories: 0,
                        protein_g: 0,
                        carbs_g: 0,
                        fat_g: 0,
                    },
                });
                expect(
                    trendDays.find((d) => d.date === "2026-08-05"),
                ).toMatchObject({
                    calories: 250,
                    protein_g: 20,
                    meals_total: 1,
                    meals_calculated: {
                        calories: 1,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });

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
        },
    );

    test.serial(
        "mixed and explicit-zero days keep partial sums and real zeros distinct",
        async () => {
            // A day whose selection is only partially calculated: the sum
            // covers the calculated meal alone, and the counts say so.
            await seedProjectionEvent(pool, {
                userId: "u1",
                idempotencyKey: "mixed-pending",
                consumedAt: "2026-08-07T12:00:00.000Z",
                currentVersion: 1,
                description: "pending soup",
                calories: null,
                protein_g: null,
                carbs_g: null,
                fat_g: null,
                canonicalStatus: "pending",
                consensusStatus: "insufficient_data",
            });
            await seedProjectionEvent(pool, {
                userId: "u1",
                idempotencyKey: "mixed-ready",
                consumedAt: "2026-08-07T13:00:00.000Z",
                currentVersion: 1,
                description: "ready rice",
                calories: 300,
                protein_g: 12,
            });
            // A stored explicit zero is data, not absence: it must survive
            // every public aggregate as a real 0.
            await seedProjectionEvent(pool, {
                userId: "u1",
                idempotencyKey: "explicit-zero",
                consumedAt: "2026-08-08T12:00:00.000Z",
                currentVersion: 1,
                description: "zero snack",
                calories: 0,
                protein_g: 0,
                carbs_g: 0,
                fat_g: 0,
            });

            await callTools(async (call) => {
                const summary = await call("get_nutrition_summary", {
                    start_date: "2026-08-07",
                    end_date: "2026-08-08",
                });
                expect(summary.isError).not.toBe(true);
                const days = SUMMARY_DAYS.parse(
                    summary.structuredContent?.days,
                );
                // Mixed day: partial sum, honest per-macro counts.
                expect(days.find((d) => d.date === "2026-08-07")).toMatchObject(
                    {
                        meal_count: 2,
                        calories: 300,
                        protein_g: 12,
                        meals_total: 2,
                        meals_calculated: {
                            calories: 1,
                            protein_g: 1,
                            carbs_g: 1,
                            fat_g: 1,
                        },
                    },
                );
                // Explicit-zero day: real zeros, fully calculated.
                expect(days.find((d) => d.date === "2026-08-08")).toMatchObject(
                    {
                        meal_count: 1,
                        calories: 0,
                        protein_g: 0,
                        carbs_g: 0,
                        fat_g: 0,
                        meals_total: 1,
                        meals_calculated: {
                            calories: 1,
                            protein_g: 1,
                            carbs_g: 1,
                            fat_g: 1,
                        },
                    },
                );

                const mixedProgress = await call("get_goal_progress", {
                    date: "2026-08-07",
                });
                expect(mixedProgress.isError).not.toBe(true);
                expect(
                    TOTALS_ITEM.parse(mixedProgress.structuredContent?.totals),
                ).toMatchObject({
                    calories: 300,
                    meals_total: 2,
                    meals_calculated: {
                        calories: 1,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });
                expect(mixedProgress.content[0]!.text).toContain(
                    "Calories: 300",
                );

                const zeroProgress = await call("get_goal_progress", {
                    date: "2026-08-08",
                });
                expect(zeroProgress.isError).not.toBe(true);
                expect(
                    TOTALS_ITEM.parse(zeroProgress.structuredContent?.totals),
                ).toMatchObject({
                    calories: 0,
                    protein_g: 0,
                    meals_total: 1,
                    meals_calculated: {
                        calories: 1,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });
                expect(zeroProgress.content[0]!.text).toContain(
                    "Calories: 0 kcal",
                );
                expect(zeroProgress.content[0]!.text).not.toContain(
                    "no data yet",
                );

                const trends = await call("get_trends", {
                    days: 2,
                    end_date: "2026-08-08",
                });
                expect(trends.isError).not.toBe(true);
                const trendDays = TREND_DAYS.parse(
                    trends.structuredContent?.days,
                );
                expect(
                    trendDays.find((d) => d.date === "2026-08-07"),
                ).toMatchObject({
                    calories: 300,
                    meals_total: 2,
                    meals_calculated: {
                        calories: 1,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });
                expect(
                    trendDays.find((d) => d.date === "2026-08-08"),
                ).toMatchObject({
                    calories: 0,
                    meals_total: 1,
                    meals_calculated: {
                        calories: 1,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });

                // CSV export: the explicit-zero meal keeps its 0s, the pending
                // meal keeps empty cells — never one dressed as the other.
                const exported = await call("export_meals");
                expect(exported.isError).not.toBe(true);
                const csv = await Bun.file("./exports/u1/meals.csv").text();
                const zeroLine = csv
                    .split("\n")
                    .find((line) => line.includes("zero snack"))!;
                expect(zeroLine.split(",").slice(5)).toEqual([
                    "0",
                    "0",
                    "0",
                    "0",
                    "",
                    "",
                    "",
                    "",
                ]);
                const pendingLine = csv
                    .split("\n")
                    .find((line) => line.includes("pending soup"))!;
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
        },
    );

    test.serial(
        "distinct per-nutrient presence, unlogged days and empty ranges disclose per-macro coverage",
        async () => {
            // A calorie-only meal beside a fully calculated one on the same
            // day: calories are covered 2/2 but protein/carbs/fat only 1/2. A
            // single any-macro count would read 2/2 and lie about protein.
            await seedProjectionEvent(pool, {
                userId: "u1",
                idempotencyKey: "distinct-calorie-only",
                consumedAt: "2026-08-09T12:00:00.000Z",
                currentVersion: 1,
                description: "calorie-only bar",
                calories: 400,
                protein_g: null,
                carbs_g: null,
                fat_g: null,
            });
            await seedProjectionEvent(pool, {
                userId: "u1",
                idempotencyKey: "distinct-full",
                consumedAt: "2026-08-09T13:00:00.000Z",
                currentVersion: 1,
                description: "full bowl",
                calories: 200,
                protein_g: 10,
                carbs_g: 20,
                fat_g: 5,
            });

            await callTools(async (call) => {
                // Summary: per-macro counts say calories 2/2, the rest 1/2.
                const summary = await call("get_nutrition_summary", {
                    start_date: "2026-08-09",
                    end_date: "2026-08-09",
                });
                expect(summary.isError).not.toBe(true);
                const days = SUMMARY_DAYS.parse(
                    summary.structuredContent?.days,
                );
                expect(days.find((d) => d.date === "2026-08-09")).toMatchObject(
                    {
                        meal_count: 2,
                        calories: 600,
                        protein_g: 10,
                        meals_total: 2,
                        meals_calculated: {
                            calories: 2,
                            protein_g: 1,
                            carbs_g: 1,
                            fat_g: 1,
                        },
                    },
                );
                const averages = TOTALS_ITEM.parse(
                    summary.structuredContent?.averages,
                );
                expect(averages.calories).toBe(600);
                expect(averages.protein_g).toBe(10);
                expect(averages.meals_total).toBe(2);
                expect(averages.meals_calculated).toEqual({
                    calories: 2,
                    protein_g: 1,
                    carbs_g: 1,
                    fat_g: 1,
                });

                // Goal progress over the distinct-presence day.
                const progress = await call("get_goal_progress", {
                    date: "2026-08-09",
                });
                expect(progress.isError).not.toBe(true);
                expect(
                    TOTALS_ITEM.parse(progress.structuredContent?.totals),
                ).toMatchObject({
                    calories: 600,
                    protein_g: 10,
                    meals_total: 2,
                    meals_calculated: {
                        calories: 2,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });

                // Trends: the logged day shows 2/1/1/1 coverage; the unlogged
                // day before it shows null cores and zero per-macro coverage.
                const trends = await call("get_trends", {
                    days: 2,
                    end_date: "2026-08-09",
                });
                expect(trends.isError).not.toBe(true);
                const trendDays = TREND_DAYS.parse(
                    trends.structuredContent?.days,
                );
                expect(
                    trendDays.find((d) => d.date === "2026-08-09"),
                ).toMatchObject({
                    calories: 600,
                    protein_g: 10,
                    meals_total: 2,
                    meals_calculated: {
                        calories: 2,
                        protein_g: 1,
                        carbs_g: 1,
                        fat_g: 1,
                    },
                });
                expect(
                    trendDays.find((d) => d.date === "2026-08-08"),
                ).toMatchObject({
                    calories: null,
                    protein_g: null,
                    carbs_g: null,
                    fat_g: null,
                    meals_total: 0,
                    meals_calculated: {
                        calories: 0,
                        protein_g: 0,
                        carbs_g: 0,
                        fat_g: 0,
                    },
                });

                // Empty range (D4): core averages are null — never fabricated
                // numeric 0s — with zero meals and zero per-macro coverage.
                const empty = await call("get_nutrition_summary", {
                    start_date: "2026-08-20",
                    end_date: "2026-08-21",
                });
                expect(empty.isError).not.toBe(true);
                const emptyAverages = TOTALS_ITEM.parse(
                    empty.structuredContent?.averages,
                );
                expect(emptyAverages.calories).toBeNull();
                expect(emptyAverages.protein_g).toBeNull();
                expect(emptyAverages.carbs_g).toBeNull();
                expect(emptyAverages.fat_g).toBeNull();
                expect(emptyAverages.meals_total).toBe(0);
                expect(emptyAverages.meals_calculated).toEqual({
                    calories: 0,
                    protein_g: 0,
                    carbs_g: 0,
                    fat_g: 0,
                });
                expect(
                    SUMMARY_DAYS.parse(empty.structuredContent?.days),
                ).toEqual([]);

                // CSV: the calorie-only meal keeps its calories and leaves the
                // uncovered macro cells empty; the full meal keeps every value.
                const exported = await call("export_meals");
                expect(exported.isError).not.toBe(true);
                const csv = await Bun.file("./exports/u1/meals.csv").text();
                const calorieOnlyLine = csv
                    .split("\n")
                    .find((line) => line.includes("calorie-only bar"))!;
                expect(calorieOnlyLine.split(",").slice(5)).toEqual([
                    "400",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ]);
                const fullLine = csv
                    .split("\n")
                    .find((line) => line.includes("full bowl"))!;
                expect(fullLine.split(",").slice(5)).toEqual([
                    "200",
                    "10",
                    "20",
                    "5",
                    "",
                    "",
                    "",
                    "",
                ]);
            });
        },
    );

    test.serial(
        "timezone local midnight assigns events to the correct local day on both sides",
        async () => {
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
                expect(before.content[0]!.text).toContain(
                    "before midnight snack",
                );
                expect(before.content[0]!.text).not.toContain(
                    "after midnight snack",
                );

                const after = await call("get_meals_by_date", {
                    date: "2026-08-05",
                });
                expect(after.isError).not.toBe(true);
                expect(after.content[0]!.text).toContain(
                    "after midnight snack",
                );
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
                expect(days.find((d) => d.date === "2026-08-04")).toMatchObject(
                    {
                        meal_count: 1,
                        calories: 111,
                    },
                );
                expect(days.find((d) => d.date === "2026-08-05")).toMatchObject(
                    {
                        meal_count: 1,
                        calories: 222,
                    },
                );
            });
        },
    );

    test.serial(
        "export carries the active correction before deletion excludes the event",
        async () => {
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
        },
    );

    test.serial(
        "public calculation MCP round-trips strict provenance and authorization",
        async () => {
            const eventId = "00000000-0000-4000-8000-000000000010";
            await pool.query(
                `INSERT INTO meal_events (id, user_id, reported_at, consumed_at, idempotency_key)
             VALUES ($1, 'u1', now(), now(), 'public-calc-event')`,
                [eventId],
            );
            await pool.query(
                `INSERT INTO meal_event_versions (event_id, version, parser_policy_version, created_by)
             VALUES ($1, 1, 'public-test', 'public-test')`,
                [eventId],
            );
            const bundle = publicBundle(eventId, 1, 500, "initial");
            let firstOutput: Record<string, unknown> | undefined;
            await callTools(async (call) => {
                const listed = await call("get_calculation_provenance", {
                    event_id: eventId,
                });
                expect(listed.isError).not.toBe(true);
                expect(
                    CALCULATION_PROVENANCE_OUTPUT_SCHEMA.parse(
                        listed.structuredContent,
                    ),
                ).toMatchObject({
                    version: 1,
                    provenance_status: "missing",
                    canonical: null,
                });
                const committed = await call("commit_calculation_bundle", {
                    bundle,
                });
                expect(committed.isError).not.toBe(true);
                firstOutput = CALCULATION_BUNDLE_OUTPUT_SCHEMA.parse(
                    committed.structuredContent,
                ) as Record<string, unknown>;
                expect(firstOutput).toMatchObject({
                    event_id: eventId,
                    version: 1,
                    deduplicated: false,
                    external_sync: "not_authorized",
                    provenance_status: "unavailable",
                    compatibility: false,
                });
                const provider = (
                    firstOutput.provider_results as Record<string, unknown>[]
                ).find((row) => row.provider === "nutrition-local");
                expect(provider?.provenance).toEqual({
                    sentinel: { nested: ["kept", 7] },
                    source: "caller",
                });
                for (const expected of bundle.results) {
                    const actual = (
                        firstOutput.provider_results as Record<
                            string,
                            unknown
                        >[]
                    ).find((row) => row.provider === expected.provider)!;
                    expect(actual.source_id).toBe(expected.source_id);
                    expect(actual.request_fingerprint).toBe(
                        expected.request_fingerprint,
                    );
                    expect(actual.algorithm_version).toBe(
                        expected.algorithm_version,
                    );
                    expect(actual.basis).toBe(expected.basis);
                    expect(actual.units).toBe(expected.units);
                    expect(actual.raw_payload).toEqual(expected.raw_payload);
                    expect(actual.provenance).toEqual(
                        expected.provenance ?? { compatibility: true },
                    );
                    expect(actual.error_code).toBe(expected.error_code ?? null);
                    expect(actual.error_message).toBe(
                        expected.error_message ?? null,
                    );
                }
                const canonical = firstOutput.canonical as Record<
                    string,
                    unknown
                >;
                const persistedCanonical = (
                    await pool.query(
                        `SELECT source_result_ids, audit_evidence, algorithm_version
                           FROM meal_event_canonical_results
                          WHERE event_id = $1 AND version = 1 AND ordinal IS NULL`,
                        [eventId],
                    )
                ).rows[0]!;
                expect(canonical.source_result_ids).toEqual(
                    persistedCanonical.source_result_ids,
                );
                expect(canonical.audit_evidence).toEqual(
                    persistedCanonical.audit_evidence,
                );
                expect(canonical.algorithm_version).toBe(
                    persistedCanonical.algorithm_version,
                );
                expect(
                    (canonical.nutrients as Record<string, unknown>).calories,
                ).toBe(505);

                const dedupe = await call("commit_calculation_bundle", {
                    bundle,
                });
                expect(
                    CALCULATION_BUNDLE_OUTPUT_SCHEMA.parse(
                        dedupe.structuredContent,
                    ),
                ).toMatchObject({
                    deduplicated: true,
                    fingerprint: bundle.fingerprint,
                });
                const history = await call("get_calculation_provenance", {
                    event_id: eventId,
                    version: 1,
                });
                expect(
                    CALCULATION_PROVENANCE_OUTPUT_SCHEMA.parse(
                        history.structuredContent,
                    ),
                ).toMatchObject({
                    event_id: eventId,
                    version: 1,
                    current_version: 1,
                    is_current: true,
                });
            });

            const corrected = publicBundle(eventId, 2, 600, "corrected");
            const beforeForeign = await calculationCounts(pool, eventId);
            await callTools(async (call) => {
                const foreign = await call("commit_calculation_bundle", {
                    bundle: corrected,
                });
                expect(foreign.isError).toBe(true);
            }, "u2");
            expect(await calculationCounts(pool, eventId)).toEqual(
                beforeForeign,
            );

            const beforeForeignCorrection = await calculationCounts(
                pool,
                eventId,
            );
            await callTools(async (call) => {
                const foreignCorrection = await call(
                    "commit_calculation_correction",
                    {
                        bundle: corrected,
                        correction_idempotency_key: "public-foreign-correction",
                        correction_reason: "foreign attempt",
                        correction_author: "other-user",
                        source_timestamp: "2026-08-05T12:00:00.000Z",
                        confirmed: true,
                        external_write_authorized: true,
                    },
                );
                expect(foreignCorrection.isError).toBe(true);
            }, "u2");
            expect(await calculationCounts(pool, eventId)).toEqual(
                beforeForeignCorrection,
            );

            await callTools(async (call) => {
                const correction = await call("commit_calculation_correction", {
                    bundle: corrected,
                    correction_idempotency_key: "public-correction-1",
                    correction_reason: "portion corrected",
                    correction_author: "hermes",
                    source_timestamp: "2026-08-05T12:00:00.000Z",
                    confirmed: true,
                    external_write_authorized: true,
                });
                expect(correction.isError).not.toBe(true);
                expect(
                    CALCULATION_CORRECTION_OUTPUT_SCHEMA.parse(
                        correction.structuredContent,
                    ),
                ).toMatchObject({
                    version: 2,
                    deduplicated: false,
                    external_sync: "pending",
                    provenance_status: "unavailable",
                    prior_version: 1,
                    correction_reason: "portion corrected",
                    correction_author: "hermes",
                });
                const replay = await call("commit_calculation_correction", {
                    bundle: corrected,
                    correction_idempotency_key: "public-correction-1",
                    correction_reason: "portion corrected",
                    correction_author: "hermes",
                    source_timestamp: "2026-08-05T12:00:00.000Z",
                    confirmed: true,
                    external_write_authorized: true,
                });
                expect(
                    CALCULATION_CORRECTION_OUTPUT_SCHEMA.parse(
                        replay.structuredContent,
                    ),
                ).toMatchObject({
                    version: 2,
                    deduplicated: true,
                    prior_version: 1,
                    correction_reason: "portion corrected",
                    correction_author: "hermes",
                });
                const beforeConflict = await calculationCounts(pool, eventId);
                const conflict = await call("commit_calculation_correction", {
                    bundle: corrected,
                    correction_idempotency_key: "public-correction-1",
                    correction_reason: "altered identity",
                    correction_author: "hermes",
                    source_timestamp: "2026-08-05T12:00:00.000Z",
                    confirmed: true,
                    external_write_authorized: true,
                });
                expect(conflict.isError).toBe(true);
                expect(await calculationCounts(pool, eventId)).toEqual(
                    beforeConflict,
                );
            });
            expect(
                Number(
                    (
                        await pool.query(
                            "SELECT count(*) FROM meal_event_sync_journal WHERE event_id = $1",
                            [eventId],
                        )
                    ).rows[0].count,
                ),
            ).toBe(1);

            await callTools(async (call) => {
                const historical = await call("get_calculation_provenance", {
                    event_id: eventId,
                    version: 1,
                });
                expect(historical.isError).not.toBe(true);
                expect(historical.structuredContent).toMatchObject({
                    current_version: 2,
                    is_current: false,
                    version: 1,
                });
                const current = await call("get_calculation_provenance", {
                    event_id: eventId,
                    version: 2,
                });
                expect(current.isError).not.toBe(true);
                expect(current.structuredContent).toMatchObject({
                    current_version: 2,
                    is_current: true,
                    version: 2,
                });
            });

            await pool.query(
                "UPDATE meal_events SET status = 'deleted' WHERE id = $1",
                [eventId],
            );
            await callTools(async (call) => {
                expect(
                    (
                        await call("get_calculation_provenance", {
                            event_id: eventId,
                        })
                    ).isError,
                ).toBe(true);
                expect(
                    (
                        await call("commit_calculation_bundle", {
                            bundle: corrected,
                        })
                    ).isError,
                ).toBe(true);
                const beforeDeletedCorrection = await calculationCounts(
                    pool,
                    eventId,
                );
                const deletedCorrection = await call(
                    "commit_calculation_correction",
                    {
                        bundle: corrected,
                        correction_idempotency_key: "public-deleted-correction",
                        correction_reason: "deleted attempt",
                        correction_author: "hermes",
                        source_timestamp: "2026-08-05T12:00:00.000Z",
                        confirmed: true,
                        external_write_authorized: true,
                    },
                );
                expect(deletedCorrection.isError).toBe(true);
                expect(await calculationCounts(pool, eventId)).toEqual(
                    beforeDeletedCorrection,
                );
            });
        },
    );

    test.serial(
        "account cleanup removes every event child and preserves unrelated user data",
        async () => {
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
        },
    );

    test.serial(
        "log_meal discloses compatibility provenance, honestly on idempotent retry",
        async () => {
            await callTools(async (call) => {
                const args = {
                    description: "provenance oats",
                    meal_type: "breakfast",
                    calories: 410,
                    logged_at: "2026-08-05T08:00:00.000Z",
                    idempotency_key: "s4-log-provenance",
                };
                const logged = await call("log_meal", args);
                expect(logged.isError).not.toBe(true);
                const parsed = z
                    .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
                    .parse(logged.structuredContent);
                expect(parsed.provenance_status).toBe("compatibility");
                expect(parsed.event_version).toBe(1);
                expect(parsed.has_calculation_bundle).toBe(false);
                expect(parsed.provenance_note.length).toBeGreaterThan(0);

                // An idempotent retry returns the same event and must not
                // invent a different provenance story.
                const retry = await call("log_meal", args);
                expect(retry.isError).not.toBe(true);
                expect(retry.content[0]!.text).toContain("idempotent retry");
                const retryParsed = z
                    .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
                    .parse(retry.structuredContent);
                expect(retryParsed.provenance_status).toBe("compatibility");
                expect(retryParsed.event_version).toBe(1);
                expect(retryParsed.has_calculation_bundle).toBe(false);
            });
        },
    );

    test.serial(
        "update_meal discloses compatibility provenance on the new version",
        async () => {
            let mealId = "";
            await callTools(async (call) => {
                const logged = await call("log_meal", {
                    description: "provenance soup",
                    meal_type: "lunch",
                    calories: 300,
                    logged_at: "2026-08-05T12:00:00.000Z",
                    idempotency_key: "s4-update-provenance",
                });
                expect(logged.isError).not.toBe(true);
                const rows = await pool.query(
                    "SELECT id FROM meal_events WHERE user_id = $1",
                    ["u1"],
                );
                mealId = rows.rows[0]!.id as string;

                const updateArgs = {
                    id: mealId,
                    calories: 350,
                };
                const updated = await call("update_meal", updateArgs);
                expect(updated.isError).not.toBe(true);
                const parsed = z
                    .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
                    .parse(updated.structuredContent);
                expect(parsed.action).toBe("updated");
                expect(parsed.provenance_status).toBe("compatibility");
                expect(parsed.event_version).toBe(2);
                expect(parsed.has_calculation_bundle).toBe(false);
                expect(parsed.provenance_note.length).toBeGreaterThan(0);

                // Identical retry deduplicates the correction: no third
                // version, and the disclosed status stays the truth.
                const retry = await call("update_meal", updateArgs);
                expect(retry.isError).not.toBe(true);
                const retryParsed = z
                    .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
                    .parse(retry.structuredContent);
                expect(retryParsed.provenance_status).toBe("compatibility");
                expect(retryParsed.event_version).toBe(2);
                expect(retryParsed.has_calculation_bundle).toBe(false);
            });
            const versions = await pool.query(
                `SELECT count(*)::int AS count FROM meal_event_versions
                  WHERE event_id = $1`,
                [mealId],
            );
            expect(versions.rows[0]!.count).toBe(2);
        },
    );

    test.serial(
        "a committed calculation bundle completes a legacy write's disclosed provenance",
        async () => {
            let eventId = "";
            const logArgs = {
                description: "provenance risotto",
                meal_type: "dinner",
                calories: 500,
                logged_at: "2026-08-05T19:00:00.000Z",
                idempotency_key: "s4-complete-provenance",
            };
            await callTools(async (call) => {
                const logged = await call("log_meal", logArgs);
                expect(logged.isError).not.toBe(true);
                const before = z
                    .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
                    .parse(logged.structuredContent);
                expect(before.provenance_status).toBe("compatibility");
                expect(before.has_calculation_bundle).toBe(false);
            });
            const rows = await pool.query(
                "SELECT id FROM meal_events WHERE user_id = $1",
                ["u1"],
            );
            eventId = rows.rows[0]!.id as string;

            // Complete the event through the public calculation path: the
            // correction appends version 2 with a full-evidence bundle.
            await callTools(async (call) => {
                const corrected = await call("commit_calculation_correction", {
                    bundle: completeBundle(eventId, 2),
                    correction_idempotency_key: "s4-complete-correction",
                    correction_reason: "full provider evidence arrived",
                    correction_author: "hermes",
                    source_timestamp: "2026-08-05T20:00:00.000Z",
                    confirmed: true,
                    external_write_authorized: false,
                });
                expect(corrected.isError).not.toBe(true);

                // Cross-check through the public provenance readback: the
                // bundle evidence really is complete.
                const provenance = await call("get_calculation_provenance", {
                    event_id: eventId,
                });
                expect(provenance.isError).not.toBe(true);
                expect(
                    CALCULATION_PROVENANCE_OUTPUT_SCHEMA.parse(
                        provenance.structuredContent,
                    ),
                ).toMatchObject({
                    version: 2,
                    current_version: 2,
                    provenance_status: "ready",
                    compatibility: false,
                });

                // The legacy write path now reads the same truth back: an
                // idempotent retry must NOT keep claiming "compatibility".
                const retry = await call("log_meal", logArgs);
                expect(retry.isError).not.toBe(true);
                expect(retry.content[0]!.text).toContain("idempotent retry");
                const parsed = z
                    .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
                    .parse(retry.structuredContent);
                expect(parsed.provenance_status).toBe("complete");
                expect(parsed.event_version).toBe(2);
                expect(parsed.has_calculation_bundle).toBe(true);
            });
        },
    );

    test.serial(
        "bulk_import_meals reports per-row provenance and nulls for unwritten rows",
        async () => {
            const rows = [
                {
                    source_line: 1,
                    description: "bulk provenance oats",
                    meal_type: "breakfast",
                    logged_at: "2026-08-05T07:00:00.000Z",
                    calories: 300,
                },
                {
                    source_line: 2,
                    description: "bulk provenance salad",
                    meal_type: "lunch",
                    logged_at: "2026-08-05T13:00:00.000Z",
                    calories: 450,
                },
            ];
            await callTools(async (call) => {
                // Dry run writes nothing, so there is no provenance to
                // disclose: every per-row provenance field is null.
                const dryRun = await call("bulk_import_meals", {
                    meals: rows,
                    expected_row_count: 2,
                    expected_total_kcal: 750,
                    dry_run: true,
                });
                expect(dryRun.isError).not.toBe(true);
                const dryParsed = z
                    .object(BULK_IMPORT_OUTPUT_SCHEMA)
                    .parse(dryRun.structuredContent);
                for (const row of dryParsed.results) {
                    expect(row.status).toBe("would_create");
                    expect(row.provenance_status).toBeNull();
                    expect(row.event_version).toBeNull();
                    expect(row.has_calculation_bundle).toBeNull();
                    expect(row.provenance_note).toBeNull();
                }

                const imported = await call("bulk_import_meals", {
                    meals: rows,
                    expected_row_count: 2,
                    expected_total_kcal: 750,
                    dry_run: false,
                });
                expect(imported.isError).not.toBe(true);
                const parsed = z
                    .object(BULK_IMPORT_OUTPUT_SCHEMA)
                    .parse(imported.structuredContent);
                for (const row of parsed.results) {
                    expect(row.status).toBe("created");
                    expect(row.provenance_status).toBe("compatibility");
                    expect(row.event_version).toBe(1);
                    expect(row.has_calculation_bundle).toBe(false);
                    expect(row.provenance_note!.length).toBeGreaterThan(0);
                }

                // Re-import deduplicates; the returned rows still point at the
                // real events, so the disclosed status must stay truthful.
                const retry = await call("bulk_import_meals", {
                    meals: rows,
                    expected_row_count: 2,
                    expected_total_kcal: 750,
                    dry_run: false,
                });
                expect(retry.isError).not.toBe(true);
                const retryParsed = z
                    .object(BULK_IMPORT_OUTPUT_SCHEMA)
                    .parse(retry.structuredContent);
                for (const row of retryParsed.results) {
                    expect(row.status).toBe("deduplicated");
                    expect(row.provenance_status).toBe("compatibility");
                    expect(row.event_version).toBe(1);
                    expect(row.has_calculation_bundle).toBe(false);
                }

                // A row that failed validation was never written: null
                // provenance, never a fabricated status.
                const withBadRow = await call("bulk_import_meals", {
                    meals: [
                        ...rows,
                        {
                            source_line: 3,
                            description: "bad row",
                            logged_at: "2026-08-05T15:00:00.000Z",
                            calories: -5,
                        },
                    ],
                    expected_row_count: 3,
                    dry_run: false,
                });
                expect(withBadRow.isError).not.toBe(true);
                const badParsed = z
                    .object(BULK_IMPORT_OUTPUT_SCHEMA)
                    .parse(withBadRow.structuredContent);
                const failedRow = badParsed.results.find(
                    (r) => r.status === "failed",
                )!;
                expect(failedRow.provenance_status).toBeNull();
                expect(failedRow.event_version).toBeNull();
                expect(failedRow.has_calculation_bundle).toBeNull();
                expect(failedRow.provenance_note).toBeNull();
            });
        },
    );
});

// ---------------------------------------------------------------------------
// S6 structured-output contract sweep. Every tool in the planned sweep must
// (a) advertise a declared outputSchema over listTools and (b) return runtime
// structuredContent on EVERY successful path, parseable by the exact exported
// declared schema.
// ---------------------------------------------------------------------------

const S6_SWEEP_OUTPUT_SCHEMAS = {
    log_water: LOG_WATER_OUTPUT_SCHEMA,
    get_water_by_date: WATER_DAY_OUTPUT_SCHEMA,
    delete_water: DELETE_WATER_OUTPUT_SCHEMA,
    log_weight: LOG_WEIGHT_OUTPUT_SCHEMA,
    get_weight_today: WEIGHT_DAY_OUTPUT_SCHEMA,
    get_weight_by_date: WEIGHT_DAY_OUTPUT_SCHEMA,
    get_weight_by_date_range: WEIGHT_RANGE_OUTPUT_SCHEMA,
    update_weight: UPDATE_WEIGHT_OUTPUT_SCHEMA,
    delete_weight: DELETE_WEIGHT_OUTPUT_SCHEMA,
    get_weight_trends: WEIGHT_TRENDS_OUTPUT_SCHEMA,
    start_meal_import: START_IMPORT_OUTPUT_SCHEMA,
    set_widget_display: WIDGET_DISPLAY_OUTPUT_SCHEMA,
    get_widget_display: WIDGET_DISPLAY_OUTPUT_SCHEMA,
};

type S6SweepTool = keyof typeof S6_SWEEP_OUTPUT_SCHEMAS;

function parseS6Structured(
    tool: S6SweepTool,
    result: ToolResult,
): Record<string, unknown> {
    expect(result.isError, `${tool} returned an MCP error`).not.toBe(true);
    expect(
        result.structuredContent,
        `${tool} returned no structuredContent`,
    ).toBeDefined();
    const shape = S6_SWEEP_OUTPUT_SCHEMAS[tool];
    expect(shape, `${tool} exports no declared output schema`).toBeDefined();
    return z.object(shape).strict().parse(result.structuredContent);
}

describeDb("S6 sweep tools declare and return structured outputs", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
        activePool = pool;
    });

    afterAll(async () => {
        activePool = null;
        await pool.end();
    });

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

    test("inventory: every sweep tool advertises a declared outputSchema", async () => {
        expect(Object.keys(S6_SWEEP_OUTPUT_SCHEMAS)).toHaveLength(13);
        await callTools(async (_call, client) => {
            const { tools } = await client.listTools();
            const byName = new Map(tools.map((t) => [t.name, t]));
            for (const name of Object.keys(S6_SWEEP_OUTPUT_SCHEMAS)) {
                const tool = byName.get(name);
                expect(tool, `${name} is not registered`).toBeDefined();
                expect(
                    tool!.outputSchema,
                    `${name} advertises no outputSchema`,
                ).toBeDefined();
            }
        });
    });

    test("water tools return parseable structuredContent on every success path", async () => {
        await callTools(async (call) => {
            const logged = await call("log_water", {
                amount_ml: 250,
                logged_at: "2026-08-05T08:00:00.000Z",
                notes: "tea",
            });
            const loggedParsed = parseS6Structured("log_water", logged);
            expect(loggedParsed.deduplicated).toBe(false);
            const entry = loggedParsed.entry as Record<string, unknown>;
            expect(entry.amount_ml).toBe(250);
            expect(entry.notes).toBe("tea");
            const entryId = entry.id as string;

            const replayed = await call("log_water", {
                amount_ml: 250,
                logged_at: "2026-08-05T08:00:00.000Z",
                notes: "tea",
            });
            expect(parseS6Structured("log_water", replayed).deduplicated).toBe(
                true,
            );

            const day = await call("get_water_by_date", {
                date: "2026-08-05",
            });
            const dayParsed = parseS6Structured("get_water_by_date", day);
            expect(dayParsed.date).toBe("2026-08-05");
            expect(dayParsed.total_ml).toBe(250);
            expect(dayParsed.entries).toHaveLength(1);

            // The empty-day success path must carry structured content too.
            const empty = await call("get_water_by_date", {
                date: "2026-08-04",
            });
            const emptyParsed = parseS6Structured("get_water_by_date", empty);
            expect(emptyParsed.total_ml).toBe(0);
            expect(emptyParsed.entries).toEqual([]);

            const deleted = await call("delete_water", { id: entryId });
            expect(parseS6Structured("delete_water", deleted).deleted).toBe(
                true,
            );
            const missing = await call("delete_water", { id: entryId });
            expect(parseS6Structured("delete_water", missing).deleted).toBe(
                false,
            );
        });
    });

    test("weight log and date reads return parseable structuredContent", async () => {
        await callTools(async (call) => {
            const first = await call("log_weight", {
                weight: 80,
                unit: "kg",
                logged_at: "2026-08-05T07:00:00.000Z",
                notes: "fasted",
            });
            const firstParsed = parseS6Structured("log_weight", first);
            expect(firstParsed.deduplicated).toBe(false);
            expect(firstParsed.unit).toBe("kg");
            const firstEntry = firstParsed.entry as Record<string, unknown>;
            expect(firstEntry.weight_g).toBe(80000);
            expect(firstEntry.notes).toBe("fasted");

            await call("log_weight", {
                weight: 82,
                unit: "kg",
                logged_at: "2026-08-05T19:00:00.000Z",
            });
            await call("log_weight", {
                weight: 180,
                unit: "lb",
                logged_at: "2026-08-04T07:30:00.000Z",
            });

            const byDate = await call("get_weight_by_date", {
                date: "2026-08-05",
            });
            const byDateParsed = parseS6Structured(
                "get_weight_by_date",
                byDate,
            );
            expect(byDateParsed.date).toBe("2026-08-05");
            expect(byDateParsed.unit).toBe("kg");
            expect(byDateParsed.entries).toHaveLength(2);

            // The empty-day success path must carry structured content too.
            const empty = await call("get_weight_by_date", {
                date: "2026-08-03",
            });
            const emptyParsed = parseS6Structured("get_weight_by_date", empty);
            expect(emptyParsed.entries).toEqual([]);

            const range = await call("get_weight_by_date_range", {
                start_date: "2026-08-04",
                end_date: "2026-08-05",
            });
            const rangeParsed = parseS6Structured(
                "get_weight_by_date_range",
                range,
            );
            expect(rangeParsed.start_date).toBe("2026-08-04");
            expect(rangeParsed.end_date).toBe("2026-08-05");
            const days = rangeParsed.days as Record<string, unknown>[];
            expect(days).toHaveLength(2);
            const aug5 = days.find((d) => d.date === "2026-08-05")!;
            expect(aug5.average_weight_g).toBe(81000);
            expect(aug5.entries).toHaveLength(2);

            // The empty-range success path must carry structured content too.
            const emptyRange = await call("get_weight_by_date_range", {
                start_date: "2026-08-01",
                end_date: "2026-08-02",
            });
            expect(
                parseS6Structured("get_weight_by_date_range", emptyRange).days,
            ).toEqual([]);
        });
    });

    test("weight today/update/delete return parseable structuredContent", async () => {
        await callTools(async (call) => {
            const logged = await call("log_weight", {
                weight: 80,
                unit: "kg",
                logged_at: new Date().toISOString(),
            });
            const entry = parseS6Structured("log_weight", logged)
                .entry as Record<string, unknown>;
            const entryId = entry.id as string;

            const today = await call("get_weight_today");
            const todayParsed = parseS6Structured("get_weight_today", today);
            expect(todayParsed.unit).toBe("kg");
            expect(todayParsed.entries).toHaveLength(1);

            const updated = await call("update_weight", {
                id: entryId,
                weight: 81,
                unit: "kg",
            });
            const updatedParsed = parseS6Structured("update_weight", updated);
            expect(updatedParsed.unit).toBe("kg");
            expect(
                (updatedParsed.entry as Record<string, unknown>).weight_g,
            ).toBe(81000);

            const deleted = await call("delete_weight", { id: entryId });
            expect(parseS6Structured("delete_weight", deleted).deleted).toBe(
                true,
            );
            const missing = await call("delete_weight", { id: entryId });
            expect(parseS6Structured("delete_weight", missing).deleted).toBe(
                false,
            );
        });
    });

    test("get_weight_trends returns parseable structuredContent", async () => {
        await callTools(async (call) => {
            await call("log_weight", {
                weight: 80,
                unit: "kg",
                logged_at: new Date().toISOString(),
            });
            const trends = await call("get_weight_trends", { days: 30 });
            const parsed = parseS6Structured("get_weight_trends", trends);
            expect(parsed.unit).toBe("kg");
            expect(parsed.target).toBeNull();
            expect(parsed.default_range).toBe(30);
            expect(
                (parsed.days as Record<string, unknown>[]).length,
            ).toBeGreaterThan(0);
        });
    });

    test("widget display tools return parseable structuredContent", async () => {
        await callTools(async (call) => {
            const disabled = await call("set_widget_display", {
                enabled: false,
            });
            expect(
                parseS6Structured("set_widget_display", disabled)
                    .widgets_enabled,
            ).toBe(false);

            const readBack = await call("get_widget_display");
            expect(
                parseS6Structured("get_widget_display", readBack)
                    .widgets_enabled,
            ).toBe(false);

            const enabled = await call("set_widget_display", {
                enabled: true,
            });
            expect(
                parseS6Structured("set_widget_display", enabled)
                    .widgets_enabled,
            ).toBe(true);
        });
    });

    test("start_meal_import returns parseable structuredContent", async () => {
        await callTools(async (call) => {
            const result = await call("start_meal_import");
            const parsed = parseS6Structured("start_meal_import", result);
            expect(parsed.import_tool_name).toBe("bulk_import_meals");
            expect(parsed.widgets_enabled).toBe(false);
            expect(parsed.tz_configured).toBe(false);
        });
    });
});

function publicBundle(
    eventId: string,
    version: number,
    calories: number,
    label: string,
): CalculationBundleInput {
    const input = {
        event_id: eventId,
        version,
        capture_id: `public-${label}`,
        resolved_input: { items: [], inputs: [] },
        results: [
            {
                provider: "nutrition-local" as const,
                status: "succeeded" as const,
                scope: { ordinal: null },
                source_id: "sentinel-source",
                request_fingerprint: `sentinel-request-${label}`,
                algorithm_version: "v1",
                basis: "per_meal" as const,
                units: "g_and_kcal" as const,
                nutrients: { calories },
                raw_payload: { sentinel: { nested: ["raw", 9] } },
                provenance: {
                    sentinel: { nested: ["kept", 7] },
                    source: "caller",
                },
            },
            {
                provider: "own" as const,
                status: "succeeded" as const,
                scope: { ordinal: null },
                source_id: "own-source",
                request_fingerprint: `own-request-${label}`,
                algorithm_version: "v1",
                basis: "per_meal" as const,
                units: "g_and_kcal" as const,
                nutrients: { calories: calories + 10 },
                raw_payload: { provider: "own", calories: calories + 10 },
            },
            {
                provider: "myfitnesspal" as const,
                status: "unavailable" as const,
                scope: { ordinal: null },
                source_id: "mfp-source",
                request_fingerprint: `mfp-request-${label}`,
                algorithm_version: "v1",
                basis: "per_meal" as const,
                units: "g_and_kcal" as const,
                nutrients: {},
                raw_payload: { reason: "not configured" },
                error_code: "provider_unavailable",
                error_message: "not configured",
            },
        ],
        canonical_proposal: { calories: 9999 },
    } satisfies Omit<CalculationBundleInput, "fingerprint">;
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

// A bundle whose three providers all succeeded with complete evidence
// (source_id, request_fingerprint, algorithm_version, raw_payload, provenance,
// basis, units), so the public provenance readback reaches "ready".
function completeBundle(
    eventId: string,
    version: number,
): CalculationBundleInput {
    const providerResult = (
        provider: "nutrition-local" | "own" | "myfitnesspal",
    ) => ({
        provider,
        status: "succeeded" as const,
        scope: { ordinal: null },
        source_id: `${provider}-source`,
        request_fingerprint: `${provider}-request-complete`,
        algorithm_version: "v1",
        basis: "per_meal" as const,
        units: "g_and_kcal" as const,
        nutrients: { calories: 500 },
        raw_payload: { provider, calories: 500 },
        provenance: { source: provider },
    });
    const input = {
        event_id: eventId,
        version,
        capture_id: "complete-bundle",
        resolved_input: { items: [], inputs: [] },
        results: [
            providerResult("nutrition-local"),
            providerResult("own"),
            providerResult("myfitnesspal"),
        ],
        canonical_proposal: { calories: 9999 },
    } satisfies Omit<CalculationBundleInput, "fingerprint">;
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

async function calculationCounts(pool: Pool, eventId: string) {
    const result = await pool.query(
        `SELECT
            (SELECT count(*) FROM meal_event_versions WHERE event_id = $1) AS versions,
            (SELECT count(*) FROM meal_event_nutrition_results WHERE event_id = $1) AS providers,
            (SELECT count(*) FROM meal_event_canonical_results WHERE event_id = $1) AS canonical,
            (SELECT current_version FROM meal_events WHERE id = $1) AS current_version`,
        [eventId],
    );
    return result.rows[0];
}
