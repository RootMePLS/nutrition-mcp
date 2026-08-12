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
    correctMeal,
    deleteMealEvent,
    domainTableCounts,
    readyBundle,
    seedMealEvent,
    unavailableBundle,
    withReuseTools,
    type ToolResult,
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

        test("listTools advertises reuse_meal_calculation with mutation annotations and typed outputSchema", async () => {
            await withReuseTools(pool, "u1", async ({ listTools }) => {
                const tools = await listTools();
                const tool = tools.find(
                    (t) => t.name === "reuse_meal_calculation",
                );
                expect(tool).toBeDefined();
                const annotations = (
                    tool as unknown as {
                        annotations?: Record<string, unknown>;
                    }
                ).annotations;
                expect(annotations?.readOnlyHint).toBe(false);
                expect(annotations?.idempotentHint).toBe(true);
                expect(annotations?.destructiveHint).toBe(false);
                const outputSchema = tool!.outputSchema as {
                    properties?: Record<string, unknown>;
                };
                expect(outputSchema).toBeDefined();
                for (const key of [
                    "event_id",
                    "version",
                    "deduplicated",
                    "provenance_status",
                    "compatibility",
                    "canonical",
                    "components",
                    "source",
                ]) {
                    expect(outputSchema.properties).toHaveProperty(key);
                }
                const description = tool!.description ?? "";
                expect(description.toLowerCase()).toContain("confirmation");
                // Truthful mutation contract: never claims provider calls.
                expect(description).toContain("never calls providers");
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

// ---------------------------------------------------------------------------
// Slice 4 public transport: the reuse_meal_calculation mutation through a
// real McpServer + Client + InMemoryTransport against real PostgreSQL.
// ---------------------------------------------------------------------------

import { REUSE_MEAL_OUTPUT_SCHEMA } from "./mcp.js";

describeDb(
    "reuse_meal_calculation transport (requires DATABASE_URL_TEST)",
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

        test("happy-path structured round-trip + get_calculation_provenance re-read", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "tx-src",
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: "transport oats" }],
            });
            const bundle = readyBundle(sourceId, 1);
            await commitBundle(pool, "u1", bundle);

            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call("reuse_meal_calculation", {
                    source_event_id: sourceId,
                    source_version: 1,
                    reported_at: "2026-08-06T13:00:00.000Z",
                    consumed_at: "2026-08-06T12:30:00.000Z",
                    idempotency_key: "tx-key-1",
                    confirmation: "добавь",
                });
                expect(result.isError).not.toBe(true);
                const payload = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(payload.event_id).not.toBe(sourceId);
                expect(payload.version).toBe(1);
                expect(payload.deduplicated).toBe(false);
                expect(payload.reported_at).toBe("2026-08-06T13:00:00.000Z");
                expect(payload.consumed_at).toBe("2026-08-06T12:30:00.000Z");
                expect(payload.meal_type).toBe("breakfast");
                expect(payload.provenance_status).toBe("ready");
                expect(payload.compatibility).toBe(false);
                expect(payload.bundle_fingerprint).toBe(bundle.fingerprint!);
                expect(payload.canonical).not.toBeNull();
                expect(payload.canonical!.calories).toBe(500);
                expect(payload.canonical!.protein_g).toBe(20);
                expect(payload.canonical!.carbs_g).toBe(60);
                expect(payload.canonical!.fat_g).toBe(15);
                expect(payload.components).toHaveLength(1);
                expect(payload.components[0]!.raw_item_text).toBe(
                    "transport oats",
                );
                expect(payload.source.source_event_id).toBe(sourceId);
                expect(payload.source.source_version).toBe(1);
                expect(payload.source.source_was_current).toBe(true);
                expect(payload.source.source_bundle_fingerprint).toBe(
                    bundle.fingerprint!,
                );
                expect(payload.source.confirmation_received).toBe(true);

                // The target is independently re-readable through the public
                // provenance path with the copied canonical values.
                const provenance = await call("get_calculation_provenance", {
                    event_id: payload.event_id,
                    version: 1,
                });
                expect(provenance.isError).not.toBe(true);
                const reRead = provenance.structuredContent as {
                    provenance_status: string;
                    compatibility: boolean;
                    bundle_fingerprint: string | null;
                    canonical: {
                        nutrients: Record<string, number | null>;
                    } | null;
                };
                expect(reRead.provenance_status).toBe("ready");
                expect(reRead.compatibility).toBe(false);
                expect(reRead.bundle_fingerprint).toBe(bundle.fingerprint!);
                expect(reRead.canonical!.nutrients.calories).toBe(500);
                expect(reRead.canonical!.nutrients.protein_g).toBe(20);
            });
        });
    },
);

// ---------------------------------------------------------------------------
// Slice 4 transport adversarial gates: payload hardening, no-leak scope
// failures, stable public errors, retry/conflict/concurrency, and historical
// version reuse — all through the public MCP client with row-count proofs.
// ---------------------------------------------------------------------------

describeDb(
    "reuse_meal_calculation transport adversarial (requires DATABASE_URL_TEST)",
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

        function validArgs(
            sourceId: string,
            overrides: Record<string, unknown> = {},
        ): Record<string, unknown> {
            return {
                source_event_id: sourceId,
                source_version: 1,
                reported_at: "2026-08-06T13:00:00.000Z",
                consumed_at: "2026-08-06T12:30:00.000Z",
                idempotency_key: "adv-key",
                confirmation: "confirm",
                ...overrides,
            };
        }

        async function seedReady(key: string, text: string): Promise<string> {
            const id = await seedMealEvent(pool, "u1", {
                idempotencyKey: key,
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: text }],
            });
            await commitBundle(pool, "u1", readyBundle(id, 1));
            return id;
        }

        test("missing confirmation and invalid confirmation are validation errors with zero writes", async () => {
            const sourceId = await seedReady("conf-src", "confirmation oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const before = await domainTableCounts(pool);
                const missing = await call(
                    "reuse_meal_calculation",
                    (() => {
                        const args = validArgs(sourceId);
                        delete args.confirmation;
                        return args;
                    })(),
                );
                expect(missing.isError).toBe(true);
                expect(missing.content[0]!.text).toContain("Invalid arguments");
                const invalid = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId, { confirmation: "yes please" }),
                );
                expect(invalid.isError).toBe(true);
                expect(invalid.content[0]!.text).toContain("Invalid arguments");
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });

        test("empty idempotency_key, missing consumed_at, malformed source_event_id are rejected with zero writes", async () => {
            const sourceId = await seedReady("val-src", "validation oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const before = await domainTableCounts(pool);
                const cases = [
                    validArgs(sourceId, { idempotency_key: "" }),
                    (() => {
                        const args = validArgs(sourceId);
                        delete args.consumed_at;
                        return args;
                    })(),
                    validArgs("not-a-uuid"),
                    validArgs(sourceId, {
                        consumed_at: "not-a-timestamp",
                    }),
                ];
                for (const args of cases) {
                    const result = await call("reuse_meal_calculation", args);
                    expect(result.isError).toBe(true);
                    // Runtime zod rejection, not a repository error.
                    expect(result.content[0]!.text).toContain(
                        "Invalid arguments",
                    );
                }
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });

        test("parseable non-ISO reported_at and consumed_at are rejected through the real transport with zero writes", async () => {
            const sourceId = await seedReady("iso-adv-src", "strict iso oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const before = await domainTableCounts(pool);
                const cases: Record<string, unknown>[] = [
                    validArgs(sourceId, {
                        reported_at: "August 6, 2026 12:30 UTC",
                        idempotency_key: "iso-adv-1",
                    }),
                    validArgs(sourceId, {
                        consumed_at: "August 6, 2026 12:30 UTC",
                        idempotency_key: "iso-adv-2",
                    }),
                    validArgs(sourceId, {
                        reported_at: "2026-08-06T13:00:00",
                        idempotency_key: "iso-adv-3",
                    }),
                    validArgs(sourceId, {
                        consumed_at: "2026-08-06",
                        idempotency_key: "iso-adv-4",
                    }),
                ];
                for (const args of cases) {
                    // Every case is Date.parse-parseable — the exact gap in
                    // the Terra finding; strict validation must reject anyway.
                    for (const field of ["reported_at", "consumed_at"]) {
                        const v = args[field];
                        expect(Number.isNaN(Date.parse(v as string))).toBe(
                            false,
                        );
                    }
                    const result = await call("reuse_meal_calculation", args);
                    expect(result.isError).toBe(true);
                    // Zod boundary rejection, not a repository/domain error.
                    expect(result.content[0]!.text).toContain(
                        "Invalid arguments",
                    );
                }
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });

        test("offset-form ISO timestamps (+00:00) remain accepted end-to-end", async () => {
            const sourceId = await seedReady("iso-ok-src", "offset iso oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId, {
                        reported_at: "2026-08-06T13:00:00.000+00:00",
                        consumed_at: "2026-08-06T12:30:00+00:00",
                        idempotency_key: "iso-ok-key",
                    }),
                );
                expect(result.isError).not.toBe(true);
                const payload = result.structuredContent as {
                    reported_at: string;
                    consumed_at: string;
                    provenance_status: string;
                };
                // timestamptz round-trip normalizes to the canonical Z form
                // at exactly the supplied instants — values preserved.
                expect(payload.reported_at).toBe("2026-08-06T13:00:00.000Z");
                expect(payload.consumed_at).toBe("2026-08-06T12:30:00.000Z");
                expect(payload.provenance_status).toBe("ready");
            });
        });

        test("parser-accepted 24:00 and out-of-range UTC offsets are rejected through the real transport with zero writes", async () => {
            const sourceId = await seedReady("iso-rng-src", "range iso oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const before = await domainTableCounts(pool);
                const cases: Record<string, unknown>[] = [
                    validArgs(sourceId, {
                        reported_at: "2026-08-06T24:00:00Z",
                        idempotency_key: "iso-rng-1",
                    }),
                    validArgs(sourceId, {
                        consumed_at: "2026-08-06T24:00:00+00:00",
                        idempotency_key: "iso-rng-2",
                    }),
                    validArgs(sourceId, {
                        reported_at: "2026-08-06T12:00:00+14:01",
                        idempotency_key: "iso-rng-3",
                    }),
                    validArgs(sourceId, {
                        consumed_at: "2026-08-06T12:00:00+15:00",
                        idempotency_key: "iso-rng-4",
                    }),
                ];
                for (const args of cases) {
                    // Every candidate is Date.parse-parseable — the parser
                    // silently normalizes 24:00 and swallows illegal offsets,
                    // which is the exact remaining Terra gap. Strict
                    // validation must reject anyway.
                    for (const field of ["reported_at", "consumed_at"]) {
                        const v = args[field];
                        expect(Number.isNaN(Date.parse(v as string))).toBe(
                            false,
                        );
                    }
                    const result = await call("reuse_meal_calculation", args);
                    expect(result.isError).toBe(true);
                    // Zod boundary rejection, not a repository/domain error.
                    expect(result.content[0]!.text).toContain(
                        "Invalid arguments",
                    );
                }
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });

        test("maximum legal offsets +14:00 and -12:00 remain accepted end-to-end", async () => {
            const sourceId = await seedReady("iso-max-src", "legal edge oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId, {
                        reported_at: "2026-08-06T13:00:00.000+14:00",
                        consumed_at: "2026-08-06T12:30:00-12:00",
                        idempotency_key: "iso-max-key",
                    }),
                );
                expect(result.isError).not.toBe(true);
                const payload = result.structuredContent as {
                    reported_at: string;
                    consumed_at: string;
                    provenance_status: string;
                };
                // timestamptz round-trip normalizes to canonical Z at exactly
                // the supplied instants — the legal extremes are preserved.
                expect(payload.reported_at).toBe("2026-08-05T23:00:00.000Z");
                expect(payload.consumed_at).toBe("2026-08-07T00:30:00.000Z");
                expect(payload.provenance_status).toBe("ready");
            });
        });

        test("forged canonical/provider/fingerprint args are inert: persisted target equals source values", async () => {
            const sourceId = await seedReady("forge-src", "forgery oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId, {
                        canonical: { calories: 9999, protein_g: 9999 },
                        provider_results: [{ provider: "own", calories: 9999 }],
                        nutrients: { calories: 9999 },
                        bundle_fingerprint: "forged",
                        source_evidence: "forged",
                    }),
                );
                expect(result.isError).not.toBe(true);
                const payload = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(payload.canonical!.calories).toBe(500);
            });
            // SQL proof: forged sentinel values appear in NO target row.
            const targets = await pool.query(
                `SELECT id FROM meal_events WHERE idempotency_key LIKE 'reuse:%'`,
            );
            expect(targets.rows).toHaveLength(1);
            const targetId = targets.rows[0]!.id as string;
            for (const table of [
                "meal_events",
                "meal_event_versions",
                "meal_event_items",
                "meal_event_nutrition_results",
                "meal_event_canonical_results",
                "meal_event_reuse_sources",
                "meal_event_reuse_provider_sources",
            ]) {
                const idColumn = table === "meal_events" ? "id" : "event_id";
                const { rows } = await pool.query(
                    `SELECT * FROM ${table} WHERE ${idColumn} = $1`,
                    [targetId],
                );
                expect(rows.length).toBeGreaterThan(0);
                const serialized = JSON.stringify(rows);
                expect(serialized).not.toContain("9999");
                expect(serialized).not.toContain("forged");
            }
            const canonical = await pool.query(
                `SELECT calories, protein_g FROM meal_event_canonical_results
                 WHERE event_id = $1 AND ordinal IS NULL`,
                [targetId],
            );
            expect(Number(canonical.rows[0]!.calories)).toBe(500);
            expect(Number(canonical.rows[0]!.protein_g)).toBe(20);
        });

        test("cross-user reuse attempt: stable meal_reuse_source_not_found, serialized response leaks nothing", async () => {
            const sourceId = await seedReady(
                "xu-src",
                "u1 confidential reuse oats",
            );
            await withReuseTools(pool, "u2", async ({ call }) => {
                const before = await domainTableCounts(pool);
                const crossUser = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId),
                );
                expect(crossUser.isError).toBe(true);
                expect(crossUser.content[0]!.text).toContain(
                    "meal_reuse_source_not_found",
                );
                const absent = await call(
                    "reuse_meal_calculation",
                    validArgs("99999999-9999-4999-9999-999999999999", {
                        idempotency_key: "xu-absent",
                    }),
                );
                expect(absent.isError).toBe(true);
                // Indistinguishable responses: identical public error text.
                expect(absent.content[0]!.text).toBe(
                    crossUser.content[0]!.text,
                );
                expect(JSON.stringify(crossUser)).not.toContain("confidential");
                expect(JSON.stringify(crossUser)).not.toContain(sourceId);
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });

        test("deleted / nonexistent-version / pending / unavailable sources -> exact stable public messages, zero writes", async () => {
            const deletedId = await seedReady("adv-del", "deleted reuse oats");
            await deleteMealEvent(pool, "u1", deletedId);
            const readyId = await seedReady("adv-v99", "version oats");
            const pendingId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "adv-pending",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "pending reuse oats" }],
            });
            const unavailableId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "adv-unavail",
                consumedAt: daysAgo(1),
                items: [
                    { ordinal: 0, raw_item_text: "unavailable reuse oats" },
                ],
            });
            await commitBundle(pool, "u1", unavailableBundle(unavailableId, 1));

            await withReuseTools(pool, "u1", async ({ call }) => {
                const before = await domainTableCounts(pool);
                const cases: [Record<string, unknown>, string][] = [
                    [
                        validArgs(deletedId, { idempotency_key: "adv-e1" }),
                        "meal_reuse_source_not_found",
                    ],
                    [
                        validArgs(readyId, {
                            source_version: 99,
                            idempotency_key: "adv-e2",
                        }),
                        "meal_reuse_source_version_not_current_or_historical",
                    ],
                    [
                        validArgs(pendingId, { idempotency_key: "adv-e3" }),
                        "meal_reuse_source_ineligible: compatibility",
                    ],
                    [
                        validArgs(unavailableId, { idempotency_key: "adv-e4" }),
                        "meal_reuse_source_ineligible: unavailable",
                    ],
                ];
                for (const [args, code] of cases) {
                    const result = await call("reuse_meal_calculation", args);
                    expect(result.isError).toBe(true);
                    expect(result.content[0]!.text).toContain(code);
                }
                expect(await domainTableCounts(pool)).toEqual(before);
                // No fabricated zero-valued canonical anywhere.
                const zeros = await pool.query(
                    `SELECT count(*)::int AS c FROM meal_event_canonical_results
                     WHERE calories = 0 OR protein_g = 0`,
                );
                expect(zeros.rows[0]!.c).toBe(0);
            });
        });

        test("same-key transport retry returns the original readback; same key + different args -> idempotency_conflict", async () => {
            const sourceId = await seedReady("retry-src", "retry oats");
            await withReuseTools(pool, "u1", async ({ call }) => {
                const first = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId),
                );
                expect(first.isError).not.toBe(true);
                const firstPayload = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                    first.structuredContent,
                );
                const before = await domainTableCounts(pool);

                const retry = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId),
                );
                expect(retry.isError).not.toBe(true);
                const retryPayload = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                    retry.structuredContent,
                );
                expect(retryPayload.event_id).toBe(firstPayload.event_id);
                expect(retryPayload.deduplicated).toBe(true);
                expect(retryPayload.canonical).toEqual(firstPayload.canonical);
                expect(await domainTableCounts(pool)).toEqual(before);

                const conflict = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId, {
                        consumed_at: "2026-08-06T19:00:00.000Z",
                    }),
                );
                expect(conflict.isError).toBe(true);
                expect(conflict.content[0]!.text).toContain(
                    "idempotency_conflict",
                );
                expect(await domainTableCounts(pool)).toEqual(before);
            });
        });

        test("concurrent transport calls through two harnesses converge on one graph", async () => {
            const sourceId = await seedReady("txrace-src", "raced reuse oats");
            const args = validArgs(sourceId, { idempotency_key: "txrace" });
            const baseline = await domainTableCounts(pool);

            let a!: ToolResult, b!: ToolResult;
            await Promise.all([
                withReuseTools(pool, "u1", async ({ call }) => {
                    a = await call("reuse_meal_calculation", args);
                }),
                withReuseTools(pool, "u1", async ({ call }) => {
                    b = await call("reuse_meal_calculation", args);
                }),
            ]);
            expect(a.isError).not.toBe(true);
            expect(b.isError).not.toBe(true);
            const payloadA = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                a.structuredContent,
            );
            const payloadB = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                b.structuredContent,
            );
            expect(payloadA.event_id).toBe(payloadB.event_id);
            expect(
                [payloadA.deduplicated, payloadB.deduplicated].sort(),
            ).toEqual([false, true]);

            const after = await domainTableCounts(pool);
            expect(after.meal_events! - baseline.meal_events!).toBe(1);
            expect(
                after.meal_event_reuse_sources! -
                    baseline.meal_event_reuse_sources!,
            ).toBe(1);
            expect(
                after.meal_event_reuse_provider_sources! -
                    baseline.meal_event_reuse_provider_sources!,
            ).toBe(3);
        });

        test("requested historical version through the public tool after a correction copies v1 facts", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "txhist-src",
                consumedAt: daysAgo(3),
                items: [{ ordinal: 0, raw_item_text: "historical v1 oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));
            await correctMeal(pool, "u1", sourceId, {
                correctionKey: "txhist-v2",
                items: [{ ordinal: 0, raw_item_text: "corrected v2 oats" }],
            });

            await withReuseTools(pool, "u1", async ({ call }) => {
                const result = await call(
                    "reuse_meal_calculation",
                    validArgs(sourceId, { source_version: 1 }),
                );
                expect(result.isError).not.toBe(true);
                const payload = REUSE_MEAL_OUTPUT_SCHEMA.parse(
                    result.structuredContent,
                );
                expect(payload.source.source_version).toBe(1);
                expect(payload.source.source_was_current).toBe(false);
                expect(payload.components).toHaveLength(1);
                expect(payload.components[0]!.raw_item_text).toBe(
                    "historical v1 oats",
                );
                expect(JSON.stringify(payload)).not.toContain("corrected");
                expect(payload.canonical!.calories).toBe(500);
            });
        });
    },
);
