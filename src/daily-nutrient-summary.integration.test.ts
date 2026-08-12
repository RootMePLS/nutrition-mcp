import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { flushAnalytics } from "./analytics.js";
import { createMealEvent } from "./meal-events.js";
import { getMealDayRows, summarizeDay } from "./daily-nutrient-summary.js";
import { registerTools } from "./mcp.js";
import type { CreateMealEventCommand } from "./meal-types.js";

// ---------------------------------------------------------------------------
// Slice-1 nutrient dashboard: the day read query and the
// get_daily_nutrient_summary MCP tool against real PostgreSQL and the real
// MCP transport. Skipped loudly without DATABASE_URL_TEST; every test resets
// the public schema and replays the full migration chain 001-011.
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;
const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/daily-nutrient-summary.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
    );
}

const MIGRATIONS = [
    "db/migrations/001_initial_schema.sql",
    "db/migrations/002_food_tracking.sql",
    "db/migrations/003_meal_captures.sql",
    "db/migrations/004_calculation_bundles.sql",
    "db/migrations/005_calculation_corrections.sql",
    "db/migrations/006_meal_reuse_and_supplements.sql",
    "db/migrations/007_ownership_lineage_integrity.sql",
    "db/migrations/008_supplement_create_idempotency.sql",
    "db/migrations/009_supplement_create_idem_reconciliation.sql",
    "db/migrations/010_supplement_regimen_idempotency.sql",
    "db/migrations/011_nutrient_expansion.sql",
];

async function resetSchema(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        for (const path of MIGRATIONS) {
            await client.query(await Bun.file(path).text());
        }
    } finally {
        client.release();
    }
}

const USER = "u1";

function mealCommand(
    overrides: Partial<CreateMealEventCommand> & {
        idempotency_key: string;
        consumed_at: string;
    },
): CreateMealEventCommand {
    return {
        user_id: USER,
        reported_at: overrides.consumed_at,
        items: [{ ordinal: 0, raw_item_text: "oats" }],
        inputs: [{ source_kind: "user_text", content: "oats" }],
        media: [],
        provider_results: [
            {
                provider: "nutrition-local",
                status: "succeeded",
                request_fingerprint: `${overrides.idempotency_key}-fp`,
                algorithm_version: "v1",
                source_id: `${overrides.idempotency_key}-src`,
                nutrients: { calories: 500 },
                raw_payload: { calories: 500 },
            },
        ],
        parser_policy_version: "p1",
        created_by: "test",
        ...overrides,
    };
}

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

async function callDailySummary(
    pool: Pool,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const server = new McpServer(
        { name: "nutrition-mcp-test", version: "0.0.0" },
        { capabilities: { tools: {} } },
    );
    registerTools(server, USER, false, null, { mealEventsPool: pool });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        return (await client.callTool({
            name: "get_daily_nutrient_summary",
            arguments: args,
        })) as ToolResult;
    } finally {
        await client.close();
        await server.close();
    }
}

// The §5 contract, pinned strictly: the tool must return exactly this shape.
const SUMMARY_CONTRACT_SCHEMA = z
    .object({
        date: z.string(),
        timezone: z.string(),
        meal_count: z.number(),
        nutrients: z.array(
            z
                .object({
                    key: z.string(),
                    unit: z.enum(["kcal", "g", "mg", "mcg_rae"]),
                    total: z.number().nullable(),
                    goal: z.number().nullable(),
                    remaining: z.number().nullable(),
                    percent_of_goal: z.number().nullable(),
                    completeness_status: z.enum([
                        "high",
                        "partial",
                        "low",
                        "none",
                    ]),
                    data_coverage_percent: z.number(),
                    contributing_meal_count: z.number(),
                    missing_meal_count: z.number(),
                })
                .strict(),
        ),
        micronutrient_completeness_percent: z.number(),
        notes: z.array(z.string()),
    })
    .strict();

async function seedTwoMealDay(pool: Pool): Promise<void> {
    // Meal 1: macros + sodium via two agreeing providers.
    await createMealEvent(
        pool,
        mealCommand({
            idempotency_key: "day-summary-1",
            consumed_at: "2026-08-10T08:00:00Z",
            meal_type: "breakfast",
            provider_results: [
                {
                    provider: "nutrition-local",
                    status: "succeeded",
                    request_fingerprint: "fp1",
                    algorithm_version: "v1",
                    source_id: "s1",
                    nutrients: { calories: 500, protein_g: 20, sodium_mg: 300 },
                    raw_payload: { calories: 500 },
                },
                {
                    provider: "own",
                    status: "succeeded",
                    request_fingerprint: "fp2",
                    algorithm_version: "v1",
                    source_id: "s2",
                    nutrients: { calories: 510, protein_g: 21, sodium_mg: 310 },
                    raw_payload: { calories: 510 },
                },
            ],
        }),
    );
    // Meal 2: macro-only.
    await createMealEvent(
        pool,
        mealCommand({
            idempotency_key: "day-summary-2",
            consumed_at: "2026-08-10T13:00:00Z",
            meal_type: "lunch",
            provider_results: [
                {
                    provider: "own",
                    status: "succeeded",
                    request_fingerprint: "fp3",
                    algorithm_version: "v1",
                    source_id: "s3",
                    nutrients: { calories: 700, protein_g: 35 },
                    raw_payload: { calories: 700 },
                },
            ],
        }),
    );
}

describeDb("daily nutrient summary (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 4 });
    });

    afterAll(async () => {
        await pool.end();
    });

    // Drain fire-and-forget analytics writes before the next test drops the
    // schema, so no write lands on a missing tool_analytics table.
    afterEach(async () => {
        await flushAnalytics();
    });

    beforeEach(async () => {
        await resetSchema(pool);
    });

    test("day rows aggregate canonical micronutrients with honest completeness", async () => {
        await seedTwoMealDay(pool);

        const rows = await getMealDayRows(pool, USER, "2026-08-10", "UTC");
        expect(rows).toHaveLength(2);
        const summary = summarizeDay(rows, null);
        const sodium = summary.nutrients.find((n) => n.key === "sodium_mg")!;
        expect(sodium.total).toBeCloseTo(305); // consensus mean of 300/310
        expect(sodium.contributing_meal_count).toBe(1);
        expect(sodium.missing_meal_count).toBe(1);
        expect(sodium.completeness_status).toBe("low"); // 505/1205 kcal ≈ 42%
        const calcium = summary.nutrients.find((n) => n.key === "calcium_mg")!;
        expect(calcium.total).toBeNull(); // never zero-filled
        expect(calcium.completeness_status).toBe("none");
    });

    test("events outside the local day window are excluded", async () => {
        await createMealEvent(
            pool,
            mealCommand({
                idempotency_key: "window-in",
                consumed_at: "2026-08-10T23:30:00Z",
            }),
        );
        await createMealEvent(
            pool,
            mealCommand({
                idempotency_key: "window-out",
                consumed_at: "2026-08-11T00:30:00Z",
                provider_results: [
                    {
                        provider: "own",
                        status: "succeeded",
                        request_fingerprint: "fp-out",
                        algorithm_version: "v1",
                        source_id: "s-out",
                        nutrients: { calories: 900, sodium_mg: 999 },
                        raw_payload: { calories: 900 },
                    },
                ],
            }),
        );

        const rows = await getMealDayRows(pool, USER, "2026-08-10", "UTC");
        expect(rows).toHaveLength(1);
        const summary = summarizeDay(rows, null);
        expect(
            summary.nutrients.find((n) => n.key === "sodium_mg")!.total,
        ).toBeNull(); // the 999 mg event is not in the window
    });

    test("deleted events are excluded", async () => {
        await createMealEvent(
            pool,
            mealCommand({
                idempotency_key: "deleted-meal",
                consumed_at: "2026-08-10T09:00:00Z",
                provider_results: [
                    {
                        provider: "own",
                        status: "succeeded",
                        request_fingerprint: "fp-del",
                        algorithm_version: "v1",
                        source_id: "s-del",
                        nutrients: { calories: 600, sodium_mg: 450 },
                        raw_payload: { calories: 600 },
                    },
                ],
            }),
        );
        const kept = await createMealEvent(
            pool,
            mealCommand({
                idempotency_key: "kept-meal",
                consumed_at: "2026-08-10T12:00:00Z",
            }),
        );
        await pool.query(
            "UPDATE meal_events SET status = 'deleted' WHERE idempotency_key = 'deleted-meal'",
        );

        const rows = await getMealDayRows(pool, USER, "2026-08-10", "UTC");
        expect(rows).toHaveLength(1);
        const summary = summarizeDay(rows, null);
        expect(summary.meal_count).toBe(1);
        expect(
            summary.nutrients.find((n) => n.key === "sodium_mg")!.total,
        ).toBeNull();
        expect(kept.event_id).toBeTruthy();
    });

    test("a day with zero meals returns no rows and a null-only summary", async () => {
        const rows = await getMealDayRows(pool, USER, "2026-08-10", "UTC");
        expect(rows).toEqual([]);
        const summary = summarizeDay(rows, null);
        expect(summary.meal_count).toBe(0);
        for (const n of summary.nutrients) {
            expect(n.total).toBeNull();
            expect(n.completeness_status).toBe("none");
        }
    });

    test("get_daily_nutrient_summary returns the §5 payload through the transport", async () => {
        await seedTwoMealDay(pool);

        const r = await callDailySummary(pool, { date: "2026-08-10" });
        expect(r.isError).not.toBe(true);
        expect(r.structuredContent).toBeDefined();
        const payload = SUMMARY_CONTRACT_SCHEMA.parse(r.structuredContent);
        expect(payload.date).toBe("2026-08-10");
        expect(payload.meal_count).toBe(2);
        expect(payload.nutrients).toHaveLength(18);
        const sodium = payload.nutrients.find((n) => n.key === "sodium_mg")!;
        expect(sodium.total).toBeCloseTo(305);
        expect(sodium.unit).toBe("mg");
        expect(sodium.completeness_status).toBe("low");
        // Slice 1: micronutrient goals are not stored — null, with the
        // goal/remaining/percent shape carried for Phase 3.
        expect(sodium.goal).toBeNull();
        expect(sodium.remaining).toBeNull();
        expect(sodium.percent_of_goal).toBeNull();
        // The text content is the same payload as JSON, never a summary blob.
        expect(r.content[0]!.text).toContain('"sodium_mg"');
    });

    test("tool defaults to the caller's today and handles an empty day", async () => {
        const r = await callDailySummary(pool, {});
        expect(r.isError).not.toBe(true);
        const payload = SUMMARY_CONTRACT_SCHEMA.parse(r.structuredContent);
        expect(payload.meal_count).toBe(0);
        for (const n of payload.nutrients) {
            expect(n.total).toBeNull();
            expect(n.completeness_status).toBe("none");
            expect(n.data_coverage_percent).toBe(0);
        }
    });

    test("an invalid date is rejected loudly, never silently defaulted", async () => {
        let rejected: boolean;
        try {
            const r = await callDailySummary(pool, { date: "not-a-date" });
            rejected = r.isError === true;
        } catch {
            rejected = true; // protocol-level validation error
        }
        expect(rejected).toBe(true);
    });
});
