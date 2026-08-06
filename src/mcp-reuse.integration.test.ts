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
import { flushAnalytics } from "./analytics.js";
import { SEARCH_MEALS_OUTPUT_SCHEMA } from "./mcp.js";
import {
    commitBundle,
    domainTableCounts,
    readyBundle,
    seedMealEvent,
    withReuseTools,
} from "./meal-reuse.fixtures.js";

// ---------------------------------------------------------------------------
// Slice 3 public MCP contract: the evolved read-only search_meals tool through
// a real McpServer + Client + InMemoryTransport against real PostgreSQL.
// Requires DATABASE_URL_TEST; analytics + legacy text-path reads use the
// global pool, so DATABASE_URL must point at the same disposable database
// (the DB gate enforces this).
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/mcp-reuse.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
    );
}

const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

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

const NOW = "2026-08-06T12:00:00.000Z";

function daysAgo(days: number): string {
    return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

describeDb(
    "search_meals reuse discovery transport (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;

        beforeAll(() => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST });
        });

        afterAll(async () => {
            await pool.end();
        });

        beforeEach(async () => {
            await resetSchema(pool);
        });

        afterEach(async () => {
            await flushAnalytics();
        });

        test("listTools advertises the typed outputSchema with a lexical-only description", async () => {
            await withReuseTools(pool, "u1", async ({ listTools }) => {
                const tools = await listTools();
                const searchMeals = tools.find(
                    (t) => t.name === "search_meals",
                );
                expect(searchMeals).toBeDefined();
                const outputSchema = searchMeals!.outputSchema as {
                    properties?: Record<string, unknown>;
                };
                expect(outputSchema).toBeDefined();
                for (const key of [
                    "match_mode",
                    "window_days",
                    "generated_at",
                    "total_matches_90d",
                    "variations",
                ]) {
                    expect(outputSchema.properties).toHaveProperty(key);
                }
                const description = searchMeals!.description ?? "";
                expect(description.toLowerCase()).toContain("lexical");
                const fullText = JSON.stringify(tools).toLowerCase();
                expect(fullText).not.toContain("semantic");
                expect(fullText).not.toContain("vector");
                expect(fullText).not.toContain("embedding");
            });
        });

        test("listTools does not advertise reuse_meal_calculation (Slice 4 guard)", async () => {
            await withReuseTools(pool, "u1", async ({ listTools }) => {
                const names = (await listTools()).map((t) => t.name);
                expect(names).not.toContain("reuse_meal_calculation");
            });
        });

        test("structured round-trip parses against the advertised schema", async () => {
            const readyId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "rt-ready",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "oatmeal with raisins" }],
            });
            await commitBundle(pool, "u1", readyBundle(readyId, 1));
            await seedMealEvent(pool, "u1", {
                idempotencyKey: "rt-pending",
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: "oatmeal plain" }],
            });

            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call("search_meals", {
                    queries: ["oatmeal"],
                });
                expect(result.isError).not.toBe(true);
                const structured = SEARCH_MEALS_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(structured.match_mode).toBe("lexical");
                expect(structured.window_days).toBe(90);
                expect(structured.total_matches_90d).toBe(2);
                expect(
                    structured.variations.map((v) => v.variation_key),
                ).toEqual(["oatmeal with raisins", "oatmeal plain"]);
                for (const variation of structured.variations) {
                    expect(variation.candidates.length).toBeLessThanOrEqual(2);
                }
                const ready = structured.variations.find(
                    (v) => v.variation_key === "oatmeal with raisins",
                )!.candidates[0]!;
                expect(ready.source_event_id).toBe(readyId);
                expect(ready.source_version).toBe(1);
                expect(ready.is_current).toBe(true);
                expect(ready.provenance_status).toBe("ready");
                expect(ready.canonical!.calories).toBe(500);
                const pending = structured.variations.find(
                    (v) => v.variation_key === "oatmeal plain",
                )!.candidates[0]!;
                expect(pending.provenance_status).toBe("pending");
                expect(pending.canonical!.calories).toBeNull();
                expect(pending.canonical!.calories).not.toBe(0);
            });
        });

        test("human text sections are preserved alongside structuredContent", async () => {
            await seedMealEvent(pool, "u1", {
                idempotencyKey: "text-1",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "oatmeal porridge" }],
            });
            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call("search_meals", {
                    queries: ["oatmeal"],
                });
                expect(result.isError).not.toBe(true);
                const text = result.content[0]?.text ?? "";
                expect(text).toContain("Variations (by frequency):");
                expect(text).toContain("Most recent matching entries:");
                expect(text).toContain("[id: ");
                expect(result.structuredContent).toBeDefined();
            });
        });

        test("empty path returns structured empty result plus no-match prose", async () => {
            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call("search_meals", {
                    queries: ["nothing-matches-this"],
                });
                expect(result.isError).not.toBe(true);
                const text = result.content[0]?.text ?? "";
                expect(text.startsWith("No past meals matching")).toBe(true);
                const structured = SEARCH_MEALS_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(structured.variations).toEqual([]);
                expect(structured.total_matches_90d).toBe(0);
            });
        });

        test("structured 90d window is independent of the text-path days input", async () => {
            await seedMealEvent(pool, "u1", {
                idempotencyKey: "win-old",
                consumedAt: daysAgo(100),
                items: [{ ordinal: 0, raw_item_text: "ancient oatmeal" }],
            });
            const recentId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "win-recent",
                consumedAt: daysAgo(10),
                items: [{ ordinal: 0, raw_item_text: "recent oatmeal" }],
            });

            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call("search_meals", {
                    queries: ["oatmeal"],
                    days: 3650,
                });
                expect(result.isError).not.toBe(true);
                const structured = SEARCH_MEALS_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(structured.total_matches_90d).toBe(1);
                const ids = structured.variations.flatMap((v) =>
                    v.candidates.map((c) => c.source_event_id),
                );
                expect(ids).toEqual([recentId]);
                // The text path still honors days=3650 and sees both events.
                const text = result.content[0]?.text ?? "";
                expect(text).toContain("ancient oatmeal");
                expect(text).toContain("recent oatmeal");
            });
        });

        test("cross-user: u2 transport sees nothing of u1, no leakage in serialized response", async () => {
            await seedMealEvent(pool, "u1", {
                idempotencyKey: "xu-u1",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "u1 confidential oats" }],
            });
            await withReuseTools(pool, "u2", async ({ call }) => {
                const result = await call("search_meals", {
                    queries: ["oats"],
                });
                expect(result.isError).not.toBe(true);
                const structured = SEARCH_MEALS_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(structured.total_matches_90d).toBe(0);
                expect(structured.variations).toEqual([]);
                expect(JSON.stringify(result)).not.toContain("confidential");
            });
        });

        test("read-only: domain table counts unchanged across transport calls", async () => {
            const id = await seedMealEvent(pool, "u1", {
                idempotencyKey: "ro-1",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "readonly oatmeal" }],
            });
            await commitBundle(pool, "u1", readyBundle(id, 1));

            await withReuseTools(pool, "u1", async ({ call }) => {
                const before = await domainTableCounts(pool);
                await call("search_meals", { queries: ["oatmeal"] });
                await call("search_meals", { queries: ["no-match-xyz"] });
                await call("search_meals", {
                    queries: ["oatmeal"],
                    days: 30,
                    limit: 5,
                });
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });
    },
);
