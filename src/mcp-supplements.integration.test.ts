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
];

const SUPPLEMENT_TOOL_NAMES = [
    "create_supplement_product",
    "get_supplement_product",
    "list_supplement_products",
    "search_supplement_products",
    "revise_supplement_product_label",
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

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

interface ListedTool {
    name: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
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
