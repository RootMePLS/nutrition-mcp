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
import { flushAnalytics } from "./analytics.js";
import { registerTools } from "./mcp.js";
import {
    commitBundle,
    readyBundle,
    seedMealEvent,
} from "./meal-reuse.fixtures.js";

// ---------------------------------------------------------------------------
// Slice 2 public MCP vertical path: the five supplement product tools through
// a real McpServer + Client + InMemoryTransport against real PostgreSQL.
// Mirrors the proven withTools harness (calculation-acceptance.fixtures.ts)
// but parameterizes the registered user so cross-user isolation is exercised
// at the transport boundary. Requires DATABASE_URL_TEST; analytics writes use
// the global pool, so DATABASE_URL must point at the same disposable database
// (the DB gate enforces this).
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/mcp-supplements.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
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
];

const SUPPLEMENT_TOOL_NAMES = [
    "create_supplement_product",
    "get_supplement_product",
    "list_supplement_products",
    "search_supplement_products",
    "revise_supplement_product_label",
    "create_supplement_regimen",
    "list_supplement_regimens",
    "set_supplement_regimen_active",
    "resolve_supplement_product",
    "log_supplement_intake",
    "get_supplement_intakes",
    "get_supplement_regimen_status",
    "get_supplement_nutrition_summary",
    "get_supplement_data_flags",
];

// Truthful read/write annotations: reads never write, mutations do.
const SUPPLEMENT_READ_ONLY_TOOLS = new Set([
    "get_supplement_product",
    "list_supplement_products",
    "search_supplement_products",
    "list_supplement_regimens",
    "resolve_supplement_product",
    "get_supplement_intakes",
    "get_supplement_regimen_status",
    "get_supplement_nutrition_summary",
    "get_supplement_data_flags",
]);

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

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

interface ListedTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean };
}

interface ToolContext {
    call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
    listTools: () => Promise<ListedTool[]>;
}

// Duplicate of the proven InMemoryTransport harness, with the registered
// user as a parameter so u1/u2 isolation is tested through the public path.
async function withSupplementTools(
    pool: Pool,
    userId: string,
    run: (ctx: ToolContext) => Promise<void>,
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-supplements-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, userId, false, null, { mealEventsPool: pool });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({
        name: "supplements-test-client",
        version: "0.0.0",
    });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        await run({
            call: (name, args = {}) =>
                client.callTool({
                    name,
                    arguments: args,
                }) as Promise<ToolResult>,
            listTools: async () =>
                (await client.listTools()).tools as ListedTool[],
        });
    } finally {
        await client.close();
        await server.close();
    }
}

function validCreateArgs(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        category: "sports_nutrition",
        display_name: "Impact Whey Protein",
        short_name: "Whey",
        brand: "MyProtein",
        form: "powder",
        serving_amount: 30,
        serving_unit: "g",
        serving_description: "1 level scoop",
        aliases: ["impact whey", "MP Whey"],
        nutrients: [
            {
                nutrient_key: "calories",
                display_name: "Energy",
                amount: 120,
                unit: "kcal",
                source_evidence: { label_line: "per 30 g serving" },
            },
            { nutrient_key: "protein_g", amount: 21, unit: "g" },
            // Explicit numeric zero: real label data, must read back as 0.
            { nutrient_key: "fat_g", amount: 0, unit: "g" },
            {
                nutrient_key: "vitamin_d",
                display_name: "Vitamin D",
                amount: 5,
                unit: "µg",
            },
        ],
        label_evidence: {
            kind: "label_photo",
            verified_by: "user",
            captured_on: "2026-08-05",
        },
        label_source_kind: "user_verified_label",
        idempotency_key: "create:whey:1",
        ...overrides,
    };
}

async function tableCount(pool: Pool, table: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table}`,
    );
    return rows[0]!.n as number;
}

describeDb("supplement product MCP tools (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(async () => {
        await flushAnalytics();
        await pool.end();
    });

    beforeEach(async () => {
        await resetSchema(pool);
    });

    afterEach(async () => {
        // Drain fire-and-forget analytics writes before the next reset drops
        // the schema out from under them.
        await flushAnalytics();
    });

    test("listTools advertises the fourteen supplement tools with schemas and truthful annotations", async () => {
        await withSupplementTools(pool, "u1", async ({ listTools }) => {
            const tools = await listTools();
            const byName = new Map(tools.map((t) => [t.name, t]));
            for (const name of SUPPLEMENT_TOOL_NAMES) {
                const tool = byName.get(name);
                expect(tool, `tool ${name} registered`).toBeDefined();
                expect(tool!.inputSchema).toBeDefined();
                expect(tool!.outputSchema).toBeDefined();
                // Truthful annotations: read tools declare readOnlyHint,
                // mutations do not.
                expect(tool!.annotations?.readOnlyHint).toBe(
                    SUPPLEMENT_READ_ONLY_TOOLS.has(name),
                );
            }
        });
    });

    test("listTools advertises the five supplement tools with input and output schemas", async () => {
        await withSupplementTools(pool, "u1", async ({ listTools }) => {
            const tools = await listTools();
            const byName = new Map(tools.map((t) => [t.name, t]));
            for (const name of SUPPLEMENT_TOOL_NAMES) {
                const tool = byName.get(name);
                expect(tool, `tool ${name} registered`).toBeDefined();
                expect(tool!.inputSchema).toBeDefined();
                expect(tool!.outputSchema).toBeDefined();
            }
            const create = byName.get("create_supplement_product")!;
            const required = (create.inputSchema as { required?: string[] })
                .required;
            expect(required).toContain("category");
            expect(required).toContain("display_name");
            expect(required).toContain("nutrients");
            expect(required).toContain("label_evidence");
        });
    });

    test("create_supplement_product returns a structured readback; idempotent retry deduplicates; changed payload conflicts", async () => {
        await withSupplementTools(pool, "u1", async ({ call }) => {
            const created = await call(
                "create_supplement_product",
                validCreateArgs(),
            );
            expect(created.isError).toBeFalsy();
            const payload = created.structuredContent as {
                product: {
                    product_id: string;
                    category: string;
                    status: string;
                    current_version: number;
                    version: {
                        version: number;
                        is_current: boolean;
                        display_name: string;
                        aliases: string[];
                        nutrients: {
                            nutrient_key: string;
                            amount: number;
                            unit: string;
                        }[];
                        label_evidence: Record<string, unknown>;
                    };
                };
                deduplicated: boolean;
            };
            expect(payload.deduplicated).toBe(false);
            expect(payload.product.category).toBe("sports_nutrition");
            expect(payload.product.status).toBe("active");
            expect(payload.product.current_version).toBe(1);
            expect(payload.product.version.version).toBe(1);
            expect(payload.product.version.is_current).toBe(true);
            expect(payload.product.version.display_name).toBe(
                "Impact Whey Protein",
            );
            expect(payload.product.version.aliases).toEqual([
                "impact whey",
                "MP Whey",
            ]);
            const fat = payload.product.version.nutrients.find(
                (n) => n.nutrient_key === "fat_g",
            );
            // Explicit zero survives the transport readback as 0.
            expect(fat).toBeDefined();
            expect(fat!.amount).toBe(0);
            expect(
                payload.product.version.nutrients.some(
                    (n) => n.nutrient_key === "carbs_g",
                ),
            ).toBe(false);

            // Same key + same payload: the original product, no second write.
            const retry = await call(
                "create_supplement_product",
                validCreateArgs(),
            );
            expect(retry.isError).toBeFalsy();
            const retryPayload = retry.structuredContent as {
                product: { product_id: string };
                deduplicated: boolean;
            };
            expect(retryPayload.deduplicated).toBe(true);
            expect(retryPayload.product.product_id).toBe(
                payload.product.product_id,
            );
            expect(await tableCount(pool, "supplement_products")).toBe(1);

            // Same key + different label identity: stable conflict.
            const conflict = await call(
                "create_supplement_product",
                validCreateArgs({ display_name: "Different Whey" }),
            );
            expect(conflict.isError).toBe(true);
            expect(conflict.content[0]!.text).toContain("idempotency_conflict");
            expect(await tableCount(pool, "supplement_products")).toBe(1);
        });

        // withAnalytics recorded the mutation calls against the same DB.
        await flushAnalytics();
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM tool_analytics WHERE tool_name = 'create_supplement_product'`,
        );
        expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
    });

    // Public-path proof of the migration-008 race fix: two concurrent
    // create_supplement_product calls through independent
    // McpServer/Client/InMemoryTransport pairs against the same real
    // PostgreSQL pool must converge to one product, never two roots.
    test("concurrent create_supplement_product calls with the same key converge to one product through the public transport", async () => {
        await withSupplementTools(pool, "u1", async (first) => {
            await withSupplementTools(pool, "u1", async (second) => {
                const [a, b] = await Promise.all([
                    first.call("create_supplement_product", validCreateArgs()),
                    second.call("create_supplement_product", validCreateArgs()),
                ]);
                expect(a.isError).toBeFalsy();
                expect(b.isError).toBeFalsy();
                const pa = a.structuredContent as {
                    product: { product_id: string };
                    deduplicated: boolean;
                };
                const pb = b.structuredContent as {
                    product: { product_id: string };
                    deduplicated: boolean;
                };
                expect(pa.product.product_id).toBe(pb.product.product_id);
                // Exactly one original; the concurrent twin deduplicated.
                expect([pa.deduplicated, pb.deduplicated].sort()).toEqual([
                    false,
                    true,
                ]);
            });
        });
        expect(await tableCount(pool, "supplement_products")).toBe(1);
        expect(await tableCount(pool, "supplement_product_versions")).toBe(1);
        await flushAnalytics();
    });

    // Same key, different label identity: exactly one commits, the loser is
    // a stable idempotency_conflict error response, and no second root or
    // child rows survive.
    test("concurrent create_supplement_product calls with different payloads yield one product and one conflict", async () => {
        await withSupplementTools(pool, "u1", async (first) => {
            await withSupplementTools(pool, "u1", async (second) => {
                const [a, b] = await Promise.all([
                    first.call("create_supplement_product", validCreateArgs()),
                    second.call(
                        "create_supplement_product",
                        validCreateArgs({ display_name: "Different Whey" }),
                    ),
                ]);
                const results = [a, b];
                const winners = results.filter((r) => !r.isError);
                const losers = results.filter((r) => r.isError);
                expect(winners.length).toBe(1);
                expect(losers.length).toBe(1);
                expect(losers[0]!.content[0]!.text).toContain(
                    "idempotency_conflict",
                );
            });
        });
        expect(await tableCount(pool, "supplement_products")).toBe(1);
        expect(await tableCount(pool, "supplement_product_versions")).toBe(1);
        expect(await tableCount(pool, "supplement_product_aliases")).toBe(2);
        expect(await tableCount(pool, "supplement_product_nutrients")).toBe(4);
        await flushAnalytics();
    });

    test("malformed create payloads fail validation and write nothing", async () => {
        await withSupplementTools(pool, "u1", async ({ call }) => {
            const cases: Record<string, unknown>[] = [
                validCreateArgs({ category: "medicine" }),
                validCreateArgs({ nutrients: [] }),
                validCreateArgs({
                    nutrients: [
                        { nutrient_key: "calories", amount: -5, unit: "kcal" },
                    ],
                }),
                validCreateArgs({ display_name: "" }),
                { ...validCreateArgs(), label_evidence: undefined },
                { ...validCreateArgs(), nutrients: undefined },
            ];
            for (const args of cases) {
                const result = await call("create_supplement_product", args);
                expect(result.isError).toBe(true);
                // Runtime zod rejection, not a repository or routing error.
                expect(result.content[0]!.text).toContain("Invalid arguments");
            }
            expect(await tableCount(pool, "supplement_products")).toBe(0);
            expect(await tableCount(pool, "supplement_product_versions")).toBe(
                0,
            );
        });
    });

    test("get_supplement_product reads current and historical versions; unknown id is a stable not-found error", async () => {
        await withSupplementTools(pool, "u1", async ({ call }) => {
            const created = await call(
                "create_supplement_product",
                validCreateArgs(),
            );
            const productId = (
                created.structuredContent as {
                    product: { product_id: string };
                }
            ).product.product_id;

            const current = await call("get_supplement_product", {
                product_id: productId,
            });
            expect(current.isError).toBeFalsy();
            const currentPayload = current.structuredContent as {
                product: {
                    current_version: number;
                    version: { version: number; display_name: string };
                };
            };
            expect(currentPayload.product.current_version).toBe(1);
            expect(currentPayload.product.version.version).toBe(1);

            const missing = await call("get_supplement_product", {
                product_id: "00000000-0000-4000-8000-0000000000ad",
            });
            expect(missing.isError).toBe(true);
            expect(missing.content[0]!.text).toContain(
                "supplement_product_not_found",
            );

            // Non-UUID ids are rejected by schema validation, not a DB error.
            const malformed = await call("get_supplement_product", {
                product_id: "not-a-uuid",
            });
            expect(malformed.isError).toBe(true);

            const unknownVersion = await call("get_supplement_product", {
                product_id: productId,
                version: 2,
            });
            expect(unknownVersion.isError).toBe(true);
            expect(unknownVersion.content[0]!.text).toContain(
                "supplement_product_not_found",
            );
        });
    });

    test("revise_supplement_product_label moves the current pointer; historical version stays immutable and readable", async () => {
        await withSupplementTools(pool, "u1", async ({ call }) => {
            const created = await call(
                "create_supplement_product",
                validCreateArgs(),
            );
            const productId = (
                created.structuredContent as {
                    product: { product_id: string };
                }
            ).product.product_id;

            const revised = await call("revise_supplement_product_label", {
                product_id: productId,
                display_name: "Impact Whey Protein (new formula)",
                serving_amount: 32,
                serving_unit: "g",
                aliases: ["impact whey"],
                nutrients: [
                    { nutrient_key: "calories", amount: 128, unit: "kcal" },
                    { nutrient_key: "protein_g", amount: 23, unit: "g" },
                ],
                label_evidence: { kind: "label_photo", verified_by: "user" },
                revision_idempotency_key: "revise:whey:2",
            });
            expect(revised.isError).toBeFalsy();
            const payload = revised.structuredContent as {
                product: {
                    current_version: number;
                    version: {
                        version: number;
                        display_name: string;
                        serving_amount: number;
                    };
                };
                previous_version: number;
                deduplicated: boolean;
            };
            expect(payload.deduplicated).toBe(false);
            expect(payload.previous_version).toBe(1);
            expect(payload.product.current_version).toBe(2);
            expect(payload.product.version.version).toBe(2);
            expect(payload.product.version.serving_amount).toBe(32);

            // Version 1 is still readable and untouched.
            const v1 = await call("get_supplement_product", {
                product_id: productId,
                version: 1,
            });
            expect(v1.isError).toBeFalsy();
            const v1Payload = v1.structuredContent as {
                product: {
                    current_version: number;
                    version: {
                        version: number;
                        is_current: boolean;
                        display_name: string;
                        serving_amount: number;
                        nutrients: { nutrient_key: string }[];
                    };
                };
            };
            expect(v1Payload.product.current_version).toBe(2);
            expect(v1Payload.product.version.is_current).toBe(false);
            expect(v1Payload.product.version.display_name).toBe(
                "Impact Whey Protein",
            );
            expect(v1Payload.product.version.serving_amount).toBe(30);
            expect(v1Payload.product.version.nutrients).toHaveLength(4);
        });
    });

    test("list and search are user scoped through the transport; another user sees nothing and cannot get or revise", async () => {
        let productId = "";
        await withSupplementTools(pool, "u1", async ({ call }) => {
            const created = await call(
                "create_supplement_product",
                validCreateArgs(),
            );
            productId = (
                created.structuredContent as {
                    product: { product_id: string };
                }
            ).product.product_id;

            const list = await call("list_supplement_products", {});
            expect(list.isError).toBeFalsy();
            const listPayload = list.structuredContent as {
                products: { product_id: string; display_name: string }[];
            };
            expect(listPayload.products).toHaveLength(1);
            expect(listPayload.products[0]!.product_id).toBe(productId);

            const search = await call("search_supplement_products", {
                query: "mp WHEY",
            });
            expect(search.isError).toBeFalsy();
            const searchPayload = search.structuredContent as {
                products: { product_id: string }[];
            };
            expect(searchPayload.products).toHaveLength(1);
            expect(searchPayload.products[0]!.product_id).toBe(productId);
        });

        await withSupplementTools(pool, "u2", async ({ call }) => {
            // Cross-user reads resolve as not found: no existence leakage.
            const get = await call("get_supplement_product", {
                product_id: productId,
            });
            expect(get.isError).toBe(true);
            expect(get.content[0]!.text).toContain(
                "supplement_product_not_found",
            );

            const revise = await call("revise_supplement_product_label", {
                product_id: productId,
                display_name: "Hijacked",
                nutrients: [
                    { nutrient_key: "calories", amount: 1, unit: "kcal" },
                ],
                label_evidence: { kind: "label_photo" },
            });
            expect(revise.isError).toBe(true);
            expect(revise.content[0]!.text).toContain(
                "supplement_product_not_found",
            );

            const list = await call("list_supplement_products", {});
            expect(
                (list.structuredContent as { products: unknown[] }).products,
            ).toHaveLength(0);

            const search = await call("search_supplement_products", {
                query: "whey",
            });
            expect(
                (search.structuredContent as { products: unknown[] }).products,
            ).toHaveLength(0);
        });

        // The failed cross-user revise wrote no new version.
        expect(await tableCount(pool, "supplement_product_versions")).toBe(1);
    });

    test("malformed read/revise payloads fail validation", async () => {
        await withSupplementTools(pool, "u1", async ({ call }) => {
            const badSearch = await call("search_supplement_products", {
                query: "",
            });
            expect(badSearch.isError).toBe(true);
            expect(badSearch.content[0]!.text).toContain("Invalid arguments");

            const badList = await call("list_supplement_products", {
                limit: "fifty",
            });
            expect(badList.isError).toBe(true);
            expect(badList.content[0]!.text).toContain("Invalid arguments");

            const badRevise = await call("revise_supplement_product_label", {
                display_name: "No product id",
                nutrients: [
                    { nutrient_key: "calories", amount: 1, unit: "kcal" },
                ],
                label_evidence: {},
            });
            expect(badRevise.isError).toBe(true);
            expect(badRevise.content[0]!.text).toContain("Invalid arguments");

            expect(await tableCount(pool, "supplement_products")).toBe(0);
        });
    });
});

// ---------------------------------------------------------------------------
// Slice 5: the seven regimen/intake tools through the real public transport.
// structuredContent of every success is validated by the SDK against the
// declared outputSchema automatically — a non-error result is a parsed one.
// ---------------------------------------------------------------------------

const SLICE_FIVE_TOOL_NAMES = [
    "create_supplement_regimen",
    "list_supplement_regimens",
    "set_supplement_regimen_active",
    "resolve_supplement_product",
    "log_supplement_intake",
    "get_supplement_intakes",
    "get_supplement_regimen_status",
];

const SLICE_SEVEN_TOOL_NAMES = [
    "get_supplement_nutrition_summary",
    "get_supplement_data_flags",
];

const DOMAIN_TABLES = [
    "supplement_products",
    "supplement_product_versions",
    "supplement_product_aliases",
    "supplement_product_nutrients",
    "supplement_product_label_limits",
    "supplement_regimens",
    "supplement_intake_events",
    "supplement_intake_nutrient_snapshots",
    "supplement_intake_meal_links",
    "meal_events",
    "meal_event_versions",
    "meal_event_items",
];

function validRegimenArgs(
    productId: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        product_id: productId,
        dose_servings: 1.5,
        schedule: {
            timezone: "UTC",
            frequency: "daily",
            local_time: "08:00",
        },
        starts_on: "2026-08-01",
        ends_on: null,
        idempotency_key: `regimen:${crypto.randomUUID()}`,
        ...overrides,
    };
}

function validIntakeArgs(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        servings: 2,
        occurred_at: "2026-08-02T08:00:00.000Z",
        state_action: "done",
        idempotency_key: `intake:${crypto.randomUUID()}`,
        ...overrides,
    };
}

describeDb(
    "supplement regimen/intake MCP tools (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;

        beforeAll(() => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST });
        });

        afterAll(async () => {
            await flushAnalytics();
            await pool.end();
        });

        beforeEach(async () => {
            await resetSchema(pool);
        });

        afterEach(async () => {
            await flushAnalytics();
        });

        async function domainCounts(): Promise<Record<string, number>> {
            const counts: Record<string, number> = {};
            for (const table of DOMAIN_TABLES) {
                counts[table] = await tableCount(pool, table);
            }
            return counts;
        }

        async function createProduct(
            call: ToolContext["call"],
            overrides: Record<string, unknown> = {},
        ): Promise<string> {
            const res = await call(
                "create_supplement_product",
                validCreateArgs({
                    idempotency_key: `product:${crypto.randomUUID()}`,
                    ...overrides,
                }),
            );
            expect(res.isError).toBeFalsy();
            return (
                res.structuredContent as { product: { product_id: string } }
            ).product.product_id;
        }

        async function createRegimen(
            call: ToolContext["call"],
            productId: string,
            overrides: Record<string, unknown> = {},
        ): Promise<string> {
            const res = await call(
                "create_supplement_regimen",
                validRegimenArgs(productId, overrides),
            );
            expect(res.isError).toBeFalsy();
            return (
                res.structuredContent as { regimen: { regimen_id: string } }
            ).regimen.regimen_id;
        }

        test("full vertical path: create regimen, log done/missed/cleared, read history and derived status", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call);
                const regimenId = await createRegimen(call, productId);

                const done = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ regimen_id: regimenId }),
                );
                expect(done.isError).toBeFalsy();
                const donePayload = done.structuredContent as {
                    intake: {
                        intake_id: string;
                        regimen_id: string | null;
                        product_version: number;
                        visible_state: string;
                        state_action: string;
                        nutrient_snapshots: unknown[];
                    };
                    deduplicated: boolean;
                };
                expect(donePayload.deduplicated).toBe(false);
                expect(donePayload.intake.regimen_id).toBe(regimenId);
                expect(donePayload.intake.product_version).toBe(1);
                expect(donePayload.intake.visible_state).toBe("done");
                expect(
                    donePayload.intake.nutrient_snapshots.length,
                ).toBeGreaterThan(0);

                const missed = await call(
                    "log_supplement_intake",
                    validIntakeArgs({
                        regimen_id: regimenId,
                        occurred_at: "2026-08-03T08:00:00.000Z",
                        state_action: "missed",
                    }),
                );
                expect(missed.isError).toBeFalsy();

                const cleared = await call(
                    "log_supplement_intake",
                    validIntakeArgs({
                        regimen_id: regimenId,
                        occurred_at: "2026-08-04T08:00:00.000Z",
                        state_action: "cleared",
                        supersedes_intake_id: donePayload.intake.intake_id,
                        reason: "logged on the wrong day",
                    }),
                );
                expect(cleared.isError).toBeFalsy();

                const history = await call("get_supplement_intakes", {});
                expect(history.isError).toBeFalsy();
                const facts = (
                    history.structuredContent as {
                        intakes: {
                            state_action: string;
                            visible_state: string;
                        }[];
                    }
                ).intakes;
                expect(facts).toHaveLength(3);
                // The public state vocabulary is exactly these three values;
                // raw cleared appears only as audit state_action.
                for (const fact of facts) {
                    expect(["undefined", "done", "missed"]).toContain(
                        fact.visible_state,
                    );
                }
                expect(facts[0]!.state_action).toBe("cleared");
                expect(facts[0]!.visible_state).toBe("undefined");
                expect(facts[1]!.visible_state).toBe("missed");
                expect(facts[2]!.visible_state).toBe("done");

                const status = await call("get_supplement_regimen_status", {
                    regimen_id: regimenId,
                    from_date: "2026-08-01",
                    to_date: "2026-08-04",
                });
                expect(status.isError).toBeFalsy();
                const occurrences = (
                    status.structuredContent as {
                        occurrences: {
                            local_date: string;
                            visible_state: string;
                        }[];
                    }
                ).occurrences;
                expect(
                    occurrences.map((o) => [o.local_date, o.visible_state]),
                ).toEqual([
                    // Nothing auto-marks a due occurrence: 08-01 stays
                    // undefined even though it is in the past.
                    ["2026-08-01", "undefined"],
                    ["2026-08-02", "done"],
                    ["2026-08-03", "missed"],
                    ["2026-08-04", "undefined"],
                ]);
                for (const o of occurrences) {
                    expect(["undefined", "done", "missed"]).toContain(
                        o.visible_state,
                    );
                }
            });
        });

        test("cross-user isolation: u2 cannot see or mutate u1 regimens/intakes through any new tool", async () => {
            let u1RegimenId = "";
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call);
                u1RegimenId = await createRegimen(call, productId);
                const logged = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ regimen_id: u1RegimenId }),
                );
                expect(logged.isError).toBeFalsy();

                const u2 = await withSupplementToolsCapture(productId);
                return u2;
            });

            async function withSupplementToolsCapture(u1ProductId: string) {
                await withSupplementTools(pool, "u2", async ({ call }) => {
                    const list = await call("list_supplement_regimens", {
                        include_inactive: true,
                    });
                    expect(
                        (list.structuredContent as { regimens: unknown[] })
                            .regimens,
                    ).toEqual([]);

                    const status = await call("get_supplement_regimen_status", {
                        regimen_id: u1RegimenId,
                        from_date: "2026-08-01",
                        to_date: "2026-08-03",
                    });
                    expect(status.isError).toBe(true);
                    expect(status.content[0]!.text).toContain(
                        "supplement_regimen_not_found",
                    );

                    const intakes = await call("get_supplement_intakes", {});
                    expect(
                        (intakes.structuredContent as { intakes: unknown[] })
                            .intakes,
                    ).toEqual([]);

                    const resolved = await call("resolve_supplement_product", {
                        product_id: u1ProductId,
                    });
                    expect(
                        (
                            resolved.structuredContent as {
                                resolution_status: string;
                            }
                        ).resolution_status,
                    ).toBe("not_found");
                    const aliasResolved = await call(
                        "resolve_supplement_product",
                        { alias: "MP Whey" },
                    );
                    expect(
                        (
                            aliasResolved.structuredContent as {
                                resolution_status: string;
                            }
                        ).resolution_status,
                    ).toBe("not_found");

                    const logDirect = await call(
                        "log_supplement_intake",
                        validIntakeArgs({ product_id: u1ProductId }),
                    );
                    expect(logDirect.isError).toBe(true);
                    expect(logDirect.content[0]!.text).toContain(
                        "supplement_product_not_found",
                    );

                    const logRegimen = await call(
                        "log_supplement_intake",
                        validIntakeArgs({ regimen_id: u1RegimenId }),
                    );
                    expect(logRegimen.isError).toBe(true);
                    expect(logRegimen.content[0]!.text).toContain(
                        "supplement_regimen_not_found",
                    );

                    const flip = await call("set_supplement_regimen_active", {
                        regimen_id: u1RegimenId,
                        active: false,
                    });
                    expect(flip.isError).toBe(true);
                    expect(flip.content[0]!.text).toContain(
                        "supplement_regimen_not_found",
                    );

                    const createReg = await call(
                        "create_supplement_regimen",
                        validRegimenArgs(u1ProductId),
                    );
                    expect(createReg.isError).toBe(true);
                    expect(createReg.content[0]!.text).toContain(
                        "supplement_product_not_found",
                    );
                });
            }

            // u1's rows are untouched by every u2 attempt.
            const { rows } = await pool.query(
                `SELECT active FROM supplement_regimens WHERE id = $1`,
                [u1RegimenId],
            );
            expect(rows[0]!.active).toBe(true);
            expect(await tableCount(pool, "supplement_intake_events")).toBe(1);
        });

        test("ambiguous alias: resolve returns candidates read-only; log fails with supplement_alias_ambiguous and zero writes", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                await createProduct(call, { aliases: ["shared whey"] });
                await createProduct(call, {
                    display_name: "Other Whey",
                    aliases: ["shared WHEY"],
                });

                const resolved = await call("resolve_supplement_product", {
                    alias: "shared whey",
                });
                expect(resolved.isError).toBeFalsy();
                const resolution = resolved.structuredContent as {
                    resolution_status: string;
                    candidates: { product_id: string }[];
                };
                expect(resolution.resolution_status).toBe("ambiguous");
                expect(resolution.candidates).toHaveLength(2);

                const before = await domainCounts();
                const logged = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ alias: "shared whey" }),
                );
                expect(logged.isError).toBe(true);
                expect(logged.content[0]!.text).toContain(
                    "supplement_alias_ambiguous",
                );
                expect(await domainCounts()).toEqual(before);
            });
        });

        test("malformed payloads are rejected at the schema/handler boundary with zero writes", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call);
                const before = await domainCounts();

                // Schema-level rejections (zod "Invalid arguments").
                const schemaCases: [string, Record<string, unknown>][] = [
                    [
                        "create_supplement_regimen",
                        validRegimenArgs("not-a-uuid"),
                    ],
                    [
                        "create_supplement_regimen",
                        validRegimenArgs(productId, {
                            schedule: {
                                timezone: "UTC",
                                frequency: "weekly",
                                local_time: "08:00",
                                weekdays: [8],
                            },
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            state_action: "skipped",
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            occurred_at: "2026-08-02T08:00:00",
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            occurred_at: "2026-08-02T24:00:00.000Z",
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            occurred_at: "2026-08-02T08:00:00+15:00",
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            servings: -1,
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            idempotency_key: "",
                        }),
                    ],
                    [
                        "get_supplement_regimen_status",
                        {
                            regimen_id: productId,
                            from_date: "2026-08-01",
                            to_date: "01-08-2026",
                        },
                    ],
                ];
                for (const [tool, args] of schemaCases) {
                    const result = await call(tool, args);
                    expect(result.isError, `${tool} rejects`).toBe(true);
                    expect(result.content[0]!.text).toContain(
                        "Invalid arguments",
                    );
                }

                // Handler/service-level rejections (stable validation code).
                const validationCases: [string, Record<string, unknown>][] = [
                    [
                        "resolve_supplement_product",
                        { product_id: productId, alias: "MP Whey" },
                    ],
                    ["resolve_supplement_product", {}],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            alias: "MP Whey",
                        }),
                    ],
                    [
                        "log_supplement_intake",
                        validIntakeArgs({ product_version: 1 }),
                    ],
                    [
                        "create_supplement_regimen",
                        validRegimenArgs(productId, {
                            schedule: {
                                timezone: "UTC",
                                frequency: "daily",
                                local_time: "08:00",
                                weekdays: [1],
                            },
                        }),
                    ],
                    [
                        "create_supplement_regimen",
                        validRegimenArgs(productId, {
                            schedule: {
                                timezone: "UTC",
                                frequency: "daily",
                                local_time: "08:00",
                                weekdays: [],
                            },
                        }),
                    ],
                    [
                        "create_supplement_regimen",
                        validRegimenArgs(productId, {
                            schedule: {
                                timezone: "Atlantis/North",
                                frequency: "daily",
                                local_time: "08:00",
                            },
                        }),
                    ],
                    [
                        "get_supplement_regimen_status",
                        {
                            regimen_id: productId,
                            from_date: "2026-01-01",
                            to_date: "2026-12-31",
                        },
                    ],
                ];
                for (const [tool, args] of validationCases) {
                    const result = await call(tool, args);
                    expect(result.isError, `${tool} rejects`).toBe(true);
                    expect(result.content[0]!.text).toContain(
                        "supplement_validation_failed",
                    );
                }

                expect(await domainCounts()).toEqual(before);
            });
        });

        test("all seven slice-5 tools reject unknown top-level keys with strict advertised schemas and zero writes", async () => {
            await withSupplementTools(
                pool,
                "u1",
                async ({ call, listTools }) => {
                    const productId = await createProduct(call);
                    const regimenId = await createRegimen(call, productId);

                    const STRICT_TOOLS: Record<
                        string,
                        Record<string, unknown>
                    > = {
                        create_supplement_regimen: validRegimenArgs(productId),
                        list_supplement_regimens: {},
                        set_supplement_regimen_active: {
                            regimen_id: regimenId,
                            active: true,
                        },
                        resolve_supplement_product: { product_id: productId },
                        log_supplement_intake: validIntakeArgs({
                            product_id: productId,
                        }),
                        get_supplement_intakes: {},
                        get_supplement_regimen_status: {
                            regimen_id: regimenId,
                            from_date: "2026-08-01",
                            to_date: "2026-08-07",
                        },
                        get_supplement_nutrition_summary: {
                            from_date: "2026-08-01",
                            to_date: "2026-08-07",
                            timezone: "UTC",
                        },
                        get_supplement_data_flags: {
                            from_date: "2026-08-01",
                            to_date: "2026-08-07",
                            timezone: "UTC",
                            as_of: "2026-08-06T00:00:00.000Z",
                        },
                    };

                    // Advertised JSON schema must forbid unknown top-level keys.
                    const tools = await listTools();
                    const byName = new Map(tools.map((t) => [t.name, t]));
                    for (const name of Object.keys(STRICT_TOOLS)) {
                        const schema = byName.get(name)!.inputSchema as {
                            additionalProperties?: boolean;
                        };
                        expect(
                            schema.additionalProperties,
                            `${name} advertises additionalProperties: false`,
                        ).toBe(false);
                    }

                    // Runtime: a valid payload plus one bogus top-level key is a
                    // validation error for every tool, and mutation errors write
                    // nothing to any domain table.
                    const before = await domainCounts();
                    for (const [name, valid] of Object.entries(STRICT_TOOLS)) {
                        const res = await call(name, {
                            ...valid,
                            bogus_top_level_key: "rejected",
                        });
                        expect(res.isError, `${name} rejects unknown key`).toBe(
                            true,
                        );
                        expect(res.content[0]?.text ?? "").toContain(
                            "bogus_top_level_key",
                        );
                    }
                    expect(await domainCounts()).toEqual(before);

                    // Valid payloads are preserved: the same read-only calls
                    // succeed without the bogus key.
                    for (const name of [
                        "list_supplement_regimens",
                        "resolve_supplement_product",
                        "get_supplement_intakes",
                        "get_supplement_regimen_status",
                        "get_supplement_nutrition_summary",
                        "get_supplement_data_flags",
                    ]) {
                        const ok = await call(name, STRICT_TOOLS[name]);
                        expect(
                            ok.isError,
                            `${name} valid payload ok`,
                        ).toBeFalsy();
                    }
                },
            );
        });

        test("every read-only tool leaves all domain table counts unchanged, including error paths", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call);
                const regimenId = await createRegimen(call, productId);
                const logged = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ regimen_id: regimenId }),
                );
                expect(logged.isError).toBeFalsy();

                const before = await domainCounts();
                await call("list_supplement_regimens", {});
                await call("list_supplement_regimens", {
                    include_inactive: true,
                    product_id: productId,
                    limit: 5,
                });
                await call("resolve_supplement_product", {
                    product_id: productId,
                });
                await call("resolve_supplement_product", {
                    alias: "no such product",
                });
                await call("get_supplement_intakes", {});
                await call("get_supplement_intakes", {
                    product_id: productId,
                    regimen_id: regimenId,
                    from: "2026-08-01T00:00:00.000Z",
                    to: "2026-08-31T00:00:00.000Z",
                    limit: 10,
                });
                await call("get_supplement_regimen_status", {
                    regimen_id: regimenId,
                    from_date: "2026-08-01",
                    to_date: "2026-08-05",
                });
                await call("get_supplement_nutrition_summary", {
                    from_date: "2026-08-01",
                    to_date: "2026-08-05",
                    timezone: "UTC",
                });
                await call("get_supplement_data_flags", {
                    from_date: "2026-08-01",
                    to_date: "2026-08-05",
                    timezone: "UTC",
                    as_of: "2026-08-06T00:00:00.000Z",
                });
                // Error paths of read tools write nothing either.
                await call("get_supplement_regimen_status", {
                    regimen_id: crypto.randomUUID(),
                    from_date: "2026-08-01",
                    to_date: "2026-08-05",
                });
                await call("get_supplement_nutrition_summary", {
                    from_date: "2026-13-40",
                    to_date: "2026-08-05",
                    timezone: "UTC",
                });
                await call("get_supplement_data_flags", {
                    from_date: "2026-08-01",
                    to_date: "2026-08-05",
                    timezone: "Not/AZone",
                });
                expect(await domainCounts()).toEqual(before);
            });
        });

        test("a sports_nutrition done intake through the tool creates a snack event and a link", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call); // sports_nutrition
                const logged = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ product_id: productId }),
                );
                expect(logged.isError).toBeFalsy();
                const content = logged.structuredContent as Record<
                    string,
                    unknown
                >;
                expect(typeof content.snack_event_id).toBe("string");
                expect(content.snack_version).toBe(1);
                expect(await tableCount(pool, "supplement_intake_events")).toBe(
                    1,
                );
                expect(await tableCount(pool, "meal_events")).toBe(1);
                expect(await tableCount(pool, "meal_event_versions")).toBe(1);
                expect(await tableCount(pool, "meal_event_items")).toBe(1);
                expect(
                    await tableCount(pool, "supplement_intake_meal_links"),
                ).toBe(1);
            });
        });

        test("the snack event's provenance is publicly re-readable through get_calculation_provenance", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call); // sports_nutrition, 120/21/0 + vitamin_d
                const logged = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ product_id: productId }), // servings: 2, done
                );
                expect(logged.isError).toBeFalsy();
                const content = logged.structuredContent as {
                    snack_event_id: string;
                    snack_version: number;
                };

                const prov = await call("get_calculation_provenance", {
                    event_id: content.snack_event_id,
                    version: content.snack_version,
                });
                expect(prov.isError).toBeFalsy();
                const payload = prov.structuredContent as {
                    event_id: string;
                    version: number;
                    compatibility: boolean;
                    bundle_fingerprint: string | null;
                    providers: Array<{
                        provider: string;
                        status: string;
                        source_id: string | null;
                        nutrients: Record<string, number | null>;
                    }>;
                };
                expect(payload.event_id).toBe(content.snack_event_id);
                expect(payload.version).toBe(1);
                // Label write carries no calculation bundle and says so.
                expect(payload.compatibility).toBe(true);
                expect(payload.bundle_fingerprint).toBeNull();
                expect(payload.providers).toHaveLength(1);
                const own = payload.providers[0]!;
                expect(own.provider).toBe("own");
                expect(own.status).toBe("succeeded");
                expect(own.source_id).toStartWith("suppl-snack:");
                // Exact stored label values scaled by 2 servings, zero
                // preserved, absent nutrients NULL — nothing fabricated on
                // the public surface.
                expect(own.nutrients.calories).toBe(240);
                expect(own.nutrients.protein_g).toBe(42);
                expect(own.nutrients.fat_g).toBe(0);
                expect(own.nutrients.carbs_g).toBeNull();
            });
        });

        test("replayed mutation calls with the same key deduplicate through the transport", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call);

                const regimenArgs = validRegimenArgs(productId, {
                    idempotency_key: "regimen:replay",
                });
                const first = await call(
                    "create_supplement_regimen",
                    regimenArgs,
                );
                const replay = await call(
                    "create_supplement_regimen",
                    regimenArgs,
                );
                expect(replay.isError).toBeFalsy();
                const firstRegimen = (
                    first.structuredContent as {
                        regimen: { regimen_id: string };
                    }
                ).regimen.regimen_id;
                const replayPayload = replay.structuredContent as {
                    regimen: { regimen_id: string };
                    deduplicated: boolean;
                };
                expect(replayPayload.deduplicated).toBe(true);
                expect(replayPayload.regimen.regimen_id).toBe(firstRegimen);
                expect(await tableCount(pool, "supplement_regimens")).toBe(1);

                const intakeArgs = validIntakeArgs({
                    regimen_id: firstRegimen,
                    idempotency_key: "intake:replay",
                });
                const loggedFirst = await call(
                    "log_supplement_intake",
                    intakeArgs,
                );
                const loggedReplay = await call(
                    "log_supplement_intake",
                    intakeArgs,
                );
                expect(loggedReplay.isError).toBeFalsy();
                const replayIntake = loggedReplay.structuredContent as {
                    intake: { intake_id: string };
                    deduplicated: boolean;
                };
                expect(replayIntake.deduplicated).toBe(true);
                expect(replayIntake.intake.intake_id).toBe(
                    (
                        loggedFirst.structuredContent as {
                            intake: { intake_id: string };
                        }
                    ).intake.intake_id,
                );
                expect(await tableCount(pool, "supplement_intake_events")).toBe(
                    1,
                );
                expect(
                    await tableCount(
                        pool,
                        "supplement_intake_nutrient_snapshots",
                    ),
                ).toBe(4);

                // Same key, different identity: stable conflict.
                const conflict = await call(
                    "log_supplement_intake",
                    validIntakeArgs({
                        regimen_id: firstRegimen,
                        idempotency_key: "intake:replay",
                        servings: 3,
                    }),
                );
                expect(conflict.isError).toBe(true);
                expect(conflict.content[0]!.text).toContain(
                    "idempotency_conflict",
                );
            });

            // Analytics recorded the new tools against the same database.
            await flushAnalytics();
            const { rows } = await pool.query(
                `SELECT count(*)::int AS n FROM tool_analytics
                 WHERE tool_name = 'log_supplement_intake'`,
            );
            expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
        });

        test("inactive regimen logging through the tool fails closed with the stable code", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call);
                const regimenId = await createRegimen(call, productId);

                const deactivated = await call(
                    "set_supplement_regimen_active",
                    { regimen_id: regimenId, active: false },
                );
                expect(deactivated.isError).toBeFalsy();
                expect(
                    (deactivated.structuredContent as { changed: boolean })
                        .changed,
                ).toBe(true);

                const repeat = await call("set_supplement_regimen_active", {
                    regimen_id: regimenId,
                    active: false,
                });
                expect(
                    (repeat.structuredContent as { changed: boolean }).changed,
                ).toBe(false);

                const logged = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ regimen_id: regimenId }),
                );
                expect(logged.isError).toBe(true);
                expect(logged.content[0]!.text).toContain(
                    "supplement_regimen_inactive",
                );
                expect(await tableCount(pool, "supplement_intake_events")).toBe(
                    0,
                );

                // The unique-alias path logs through the public transport.
                await call("set_supplement_regimen_active", {
                    regimen_id: regimenId,
                    active: true,
                });
                const byAlias = await call(
                    "log_supplement_intake",
                    validIntakeArgs({ alias: "MP Whey" }),
                );
                expect(byAlias.isError).toBeFalsy();
                expect(
                    (
                        byAlias.structuredContent as {
                            intake: { product_id: string };
                        }
                    ).intake.product_id,
                ).toBe(productId);
            });
        });

        test("the seven new tool descriptions carry no medical or dosage advice", async () => {
            await withSupplementTools(pool, "u1", async ({ listTools }) => {
                const tools = await listTools();
                const byName = new Map(tools.map((t) => [t.name, t]));
                for (const name of SLICE_FIVE_TOOL_NAMES) {
                    const description = byName.get(name)!.description ?? "";
                    expect(description).not.toMatch(
                        /dosage advice|should take|recommended dose|consult|interaction/i,
                    );
                }
            });
        });

        test("the slice-7 reporting/flag descriptions carry data facts only, never advice", async () => {
            await withSupplementTools(pool, "u1", async ({ listTools }) => {
                const tools = await listTools();
                const byName = new Map(tools.map((t) => [t.name, t]));
                const disclaimer =
                    "Data facts only — this server does not provide medical, dosage, or interaction advice.";
                for (const name of SLICE_SEVEN_TOOL_NAMES) {
                    const description = byName.get(name)!.description ?? "";
                    // The mandated disclaimer suffix is the only place the
                    // advice vocabulary may appear — as a negation.
                    expect(
                        description.endsWith(disclaimer),
                        `${name} ends with the data-facts disclaimer`,
                    ).toBe(true);
                    const body = description.slice(0, -disclaimer.length);
                    expect(body).not.toMatch(
                        /should take|overdose|unsafe|interaction|recommend|deficiency|toxicity|dosage advice|recommended dose|consult/i,
                    );
                }
            });
        });

        test("get_supplement_nutrition_summary returns separated structured totals through the public transport", async () => {
            await withSupplementTools(
                pool,
                "u1",
                async ({ call, listTools }) => {
                    const productId = await createProduct(call, {
                        category: "supplement",
                        nutrients: [
                            {
                                nutrient_key: "calories",
                                amount: 120,
                                unit: "kcal",
                            },
                            {
                                nutrient_key: "protein_g",
                                amount: 21,
                                unit: "g",
                            },
                            {
                                nutrient_key: "vitamin_d",
                                amount: 5,
                                unit: "µg",
                            },
                        ],
                    });
                    const logged = await call(
                        "log_supplement_intake",
                        validIntakeArgs({
                            product_id: productId,
                            occurred_at: "2026-08-03T13:00:00.000Z",
                        }),
                    );
                    expect(logged.isError).toBeFalsy();
                    // One food event through the real write path fixtures.
                    const eventId = await seedMealEvent(pool, "u1", {
                        idempotencyKey: "sum-transport-food",
                        consumedAt: "2026-08-03T12:00:00.000Z",
                        items: [
                            {
                                ordinal: 0,
                                raw_item_text: "oats",
                                normalized_name: "oats",
                            },
                        ],
                    });
                    await commitBundle(
                        pool,
                        "u1",
                        readyBundle(eventId, 1, {
                            calories: 500,
                            protein_g: 30,
                        }),
                    );

                    const res = await call("get_supplement_nutrition_summary", {
                        from_date: "2026-08-03",
                        to_date: "2026-08-03",
                        timezone: "UTC",
                    });
                    expect(res.isError).toBeFalsy();
                    // structuredContent matching the advertised outputSchema
                    // is enforced by the SDK on every call; a mismatch would
                    // surface as an error result above.
                    const tools = await listTools();
                    const advertised = tools.find(
                        (t) => t.name === "get_supplement_nutrition_summary",
                    )!;
                    expect(advertised.outputSchema).toBeDefined();
                    expect(res.structuredContent).toEqual({
                        from_date: "2026-08-03",
                        to_date: "2026-08-03",
                        timezone: "UTC",
                        food: {
                            meal_event_count: 1,
                            linked_snack_event_count_excluded: 0,
                            nutrients: [
                                {
                                    nutrient_key: "calories",
                                    unit: "kcal",
                                    amount: 500,
                                    events_with_value: 1,
                                },
                                {
                                    nutrient_key: "protein_g",
                                    unit: "g",
                                    amount: 30,
                                    events_with_value: 1,
                                },
                            ],
                        },
                        supplements: {
                            intake_fact_count_in_range: 1,
                            effective_done_intake_count: 1,
                            excluded_by_correction_count: 0,
                            nutrients: [
                                {
                                    nutrient_key: "calories",
                                    unit: "kcal",
                                    amount: 240,
                                    intakes_with_value: 1,
                                },
                                {
                                    nutrient_key: "protein_g",
                                    unit: "g",
                                    amount: 42,
                                    intakes_with_value: 1,
                                },
                                {
                                    nutrient_key: "vitamin_d",
                                    unit: "µg",
                                    amount: 10,
                                    intakes_with_value: 1,
                                },
                            ],
                        },
                        combined: [
                            {
                                nutrient_key: "calories",
                                unit: "kcal",
                                food_amount: 500,
                                supplement_amount: 240,
                                total: 740,
                            },
                            {
                                nutrient_key: "protein_g",
                                unit: "g",
                                food_amount: 30,
                                supplement_amount: 42,
                                total: 72,
                            },
                            {
                                nutrient_key: "vitamin_d",
                                unit: "µg",
                                food_amount: null,
                                supplement_amount: 10,
                                total: 10,
                            },
                        ],
                    });
                    // Text content mirrors the structured payload.
                    expect(res.content[0]!.text).toContain(
                        '"linked_snack_event_count_excluded": 0',
                    );
                },
            );
        });

        test("get_supplement_data_flags returns deterministic data-only flags through the public transport", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productA = await createProduct(call, {
                    category: "supplement",
                    display_name: "Vitamin D Tabs",
                    aliases: ["vitd-a"],
                    nutrients: [
                        { nutrient_key: "vitamin_d", amount: 10, unit: "µg" },
                    ],
                    label_limits: [
                        {
                            nutrient_key: "vitamin_d",
                            unit: "µg",
                            maximum_amount: 15,
                        },
                    ],
                });
                const productB = await createProduct(call, {
                    category: "supplement",
                    display_name: "Vitamin D Drops",
                    aliases: ["vitd-b"],
                    nutrients: [
                        { nutrient_key: "vitamin_d", amount: 20, unit: "µg" },
                    ],
                });
                const regimenId = await createRegimen(call, productA, {
                    schedule: {
                        timezone: "UTC",
                        frequency: "daily",
                        local_time: "08:00",
                    },
                    starts_on: "2026-08-01",
                    ends_on: null,
                });
                // Ad-hoc done intakes: they never claim regimen occurrences.
                await call(
                    "log_supplement_intake",
                    validIntakeArgs({
                        product_id: productA,
                        servings: 1,
                        occurred_at: "2026-08-03T08:00:00.000Z",
                    }),
                );
                await call(
                    "log_supplement_intake",
                    validIntakeArgs({
                        product_id: productB,
                        servings: 1,
                        occurred_at: "2026-08-03T09:00:00.000Z",
                    }),
                );

                const args = {
                    from_date: "2026-08-01",
                    to_date: "2026-08-07",
                    timezone: "UTC",
                    as_of: "2026-08-03T12:00:00.000Z",
                };
                const first = await call("get_supplement_data_flags", args);
                expect(first.isError).toBeFalsy();
                const flags = first.structuredContent as {
                    duplicate_nutrient_exposures: unknown[];
                    label_limit_comparisons: unknown[];
                    unmarked_active_regimen_occurrences: unknown[];
                };
                const expectedProducts = [
                    {
                        product_id: productA,
                        display_name: "Vitamin D Tabs",
                        recorded_amount: 10,
                    },
                    {
                        product_id: productB,
                        display_name: "Vitamin D Drops",
                        recorded_amount: 20,
                    },
                ].sort((a, b) => a.product_id.localeCompare(b.product_id));
                expect(flags.duplicate_nutrient_exposures).toEqual([
                    {
                        nutrient_key: "vitamin_d",
                        unit: "µg",
                        product_count: 2,
                        products: expectedProducts,
                    },
                ]);
                expect(flags.label_limit_comparisons).toEqual([
                    {
                        product_id: productA,
                        product_version: 1,
                        display_name: "Vitamin D Tabs",
                        nutrient_key: "vitamin_d",
                        unit: "µg",
                        local_date: "2026-08-03",
                        recorded_total: 10,
                        label_limit_maximum: 15,
                        exceeds_label_limit: false,
                    },
                ]);
                expect(flags.unmarked_active_regimen_occurrences).toEqual(
                    ["2026-08-01", "2026-08-02", "2026-08-03"].map(
                        (local_date) => ({
                            regimen_id: regimenId,
                            product_id: productA,
                            product_display_name: "Vitamin D Tabs",
                            local_date,
                            local_time: "08:00",
                            timezone: "UTC",
                        }),
                    ),
                );

                // Determinism: fixed as_of + fixed seeds → byte-identical
                // structured output across consecutive calls.
                const second = await call("get_supplement_data_flags", args);
                expect(JSON.stringify(second.structuredContent)).toBe(
                    JSON.stringify(first.structuredContent),
                );

                // No advice vocabulary anywhere in the structured keys.
                const keys: string[] = [];
                const collect = (value: unknown): void => {
                    if (Array.isArray(value)) {
                        value.forEach(collect);
                    } else if (value !== null && typeof value === "object") {
                        for (const [k, v] of Object.entries(value)) {
                            keys.push(k);
                            collect(v);
                        }
                    }
                };
                collect(first.structuredContent);
                for (const key of keys) {
                    expect(key).not.toMatch(
                        /should take|overdose|unsafe|interaction|recommend|deficiency|toxicity|dose|advice/i,
                    );
                }
            });
        });

        test("both new tools reject malformed payloads with stable validation errors and zero writes", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const before = await domainCounts();
                const window = {
                    from_date: "2026-08-01",
                    to_date: "2026-08-05",
                    timezone: "UTC",
                };
                for (const name of SLICE_SEVEN_TOOL_NAMES) {
                    // Strict schema: unknown top-level keys are rejected.
                    const unknownKey = await call(name, {
                        ...window,
                        bogus_top_level_key: "rejected",
                    });
                    expect(unknownKey.isError, `${name} unknown key`).toBe(
                        true,
                    );
                    expect(unknownKey.content[0]?.text ?? "").toContain(
                        "bogus_top_level_key",
                    );

                    for (const bad of [
                        { ...window, from_date: "2026-13-40" },
                        {
                            ...window,
                            from_date: "2026-08-05",
                            to_date: "2026-08-01",
                        },
                        { ...window, timezone: "Not/AZone" },
                    ]) {
                        const res = await call(name, bad);
                        expect(res.isError, `${name} rejects`).toBe(true);
                        expect(res.content[0]!.text).toContain(
                            "supplement_validation_failed",
                        );
                    }
                }
                // Bad as_of is rejected by schema refinement on the flags tool.
                const badAsOf = await call("get_supplement_data_flags", {
                    ...window,
                    as_of: "not-a-timestamp",
                });
                expect(badAsOf.isError).toBe(true);
                expect(await domainCounts()).toEqual(before);
            });
        });

        test("both new tools are user-scoped through the transport", async () => {
            await withSupplementTools(pool, "u1", async ({ call }) => {
                const productId = await createProduct(call, {
                    category: "supplement",
                });
                await call(
                    "log_supplement_intake",
                    validIntakeArgs({
                        product_id: productId,
                        occurred_at: "2026-08-03T13:00:00.000Z",
                    }),
                );
            });
            await withSupplementTools(pool, "u2", async ({ call }) => {
                const summary = await call("get_supplement_nutrition_summary", {
                    from_date: "2026-08-03",
                    to_date: "2026-08-03",
                    timezone: "UTC",
                });
                expect(summary.isError).toBeFalsy();
                const s = summary.structuredContent as {
                    food: { meal_event_count: number; nutrients: unknown[] };
                    supplements: {
                        intake_fact_count_in_range: number;
                        nutrients: unknown[];
                    };
                    combined: unknown[];
                };
                expect(s.food.meal_event_count).toBe(0);
                expect(s.food.nutrients).toEqual([]);
                expect(s.supplements.intake_fact_count_in_range).toBe(0);
                expect(s.supplements.nutrients).toEqual([]);
                expect(s.combined).toEqual([]);

                const flags = await call("get_supplement_data_flags", {
                    from_date: "2026-08-01",
                    to_date: "2026-08-07",
                    timezone: "UTC",
                    as_of: "2026-08-06T00:00:00.000Z",
                });
                expect(flags.isError).toBeFalsy();
                const f = flags.structuredContent as {
                    duplicate_nutrient_exposures: unknown[];
                    label_limit_comparisons: unknown[];
                    unmarked_active_regimen_occurrences: unknown[];
                };
                expect(f.duplicate_nutrient_exposures).toEqual([]);
                expect(f.label_limit_comparisons).toEqual([]);
                expect(f.unmarked_active_regimen_occurrences).toEqual([]);
            });
        });
    },
);
