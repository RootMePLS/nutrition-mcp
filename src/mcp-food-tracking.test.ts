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
import { registerTools } from "./mcp.js";
import { startMealCapture } from "./meal-captures.js";
import { flushAnalytics } from "./analytics.js";

// ---------------------------------------------------------------------------
// Bounded MCP tool: log_meal_event. The caller supplies already-prepared
// text/metadata/provider results; the tool runs NO Telegram/vision pipeline
// and makes NO real MyFitnessPal call. DB-gated: skipped loudly without
// DATABASE_URL_TEST.
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/mcp-food-tracking.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
    );
}

const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

async function withTools(
    pool: Pool,
    run: (
        call: (
            name: string,
            args?: Record<string, unknown>,
        ) => Promise<ToolResult>,
        client?: Client,
    ) => Promise<void>,
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, "u1", false, null, { mealEventsPool: pool });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
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

function validArgs(overrides: Record<string, unknown> = {}) {
    return {
        idempotency_key: "mcp:create:1",
        reported_at: "2026-08-04T12:00:00.000Z",
        items: [
            { ordinal: 0, raw_item_text: "oatmeal 80g" },
            { ordinal: 1, raw_item_text: "banana" },
        ],
        inputs: [
            {
                source_kind: "user_text",
                content: "oatmeal 80g and a banana",
            },
        ],
        media: [],
        provider_results: [
            {
                provider: "nutrition-local",
                status: "succeeded",
                request_fingerprint: "fp-local",
                algorithm_version: "v1",
                nutrients: { calories: 500, protein_g: 20 },
            },
            {
                provider: "own",
                status: "succeeded",
                request_fingerprint: "fp-own",
                algorithm_version: "v1",
                nutrients: { calories: 510, protein_g: 20 },
            },
        ],
        ...overrides,
    };
}

describeDb("log_meal_event MCP tool (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
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
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            await client.query(
                await Bun.file("db/migrations/001_initial_schema.sql").text(),
            );
            await client.query(
                await Bun.file("db/migrations/002_food_tracking.sql").text(),
            );
            await client.query(
                await Bun.file("db/migrations/003_meal_captures.sql").text(),
            );
            await client.query(
                await Bun.file(
                    "db/migrations/004_calculation_bundles.sql",
                ).text(),
            );
            await client.query(
                await Bun.file(
                    "db/migrations/005_calculation_corrections.sql",
                ).text(),
            );
        } finally {
            client.release();
        }
    });

    test("accepts a multi-item event and returns the full structured payload", async () => {
        await withTools(pool, async (call) => {
            const r = await call("log_meal_event", validArgs());
            expect(r.isError).not.toBe(true);
            const sc = r.structuredContent!;
            expect(typeof sc.event_id).toBe("string");
            expect(sc.version).toBe(1);
            expect(sc.deduplicated).toBe(false);
            expect(
                (sc.positions as { ordinal: number }[]).map((p) => p.ordinal),
            ).toEqual([0, 1]);
            const evidence = sc.evidence as {
                source_kind: string;
                content_hash: string;
            }[];
            expect(evidence[0]!.source_kind).toBe("user_text");
            expect(evidence[0]!.content_hash.length).toBeGreaterThan(0);
            const statuses = sc.provider_statuses as {
                provider: string;
                status: string;
                error_code: string | null;
            }[];
            expect(statuses).toEqual([
                {
                    provider: "nutrition-local",
                    status: "succeeded",
                    error_code: null,
                },
                { provider: "own", status: "succeeded", error_code: null },
            ]);
            const canonical = sc.canonical as {
                consensus_status: string;
                calories: number | null;
            };
            expect(canonical.consensus_status).toBe("all_agree");
            expect(Number(canonical.calories)).toBe(505);
            expect(sc.external_sync).toBe("not_authorized");
        });
    });

    test("explicit add authorization returns pending, never synced", async () => {
        await withTools(pool, async (call) => {
            const r = await call(
                "log_meal_event",
                validArgs({ external_write_authorized: true }),
            );
            expect(r.isError).not.toBe(true);
            const sc = r.structuredContent!;
            expect(sc.external_sync).toBe("pending");
            const journal = sc.journal as { state: string; system: string }[];
            expect(journal.length).toBe(1);
            expect(journal[0]!.state).toBe("pending");
            expect(journal[0]!.system).toBe("myfitnesspal");
            // The safety boundary: this slice cannot report a delivered write.
            expect(JSON.stringify(sc)).not.toContain('"synced"');
        });
    });

    test("duplicate retry returns the original event and never duplicates the journal", async () => {
        await withTools(pool, async (call) => {
            const args = validArgs({ external_write_authorized: true });
            const first = await call("log_meal_event", args);
            const second = await call("log_meal_event", args);

            expect(first.isError).not.toBe(true);
            expect(second.isError).not.toBe(true);
            const a = first.structuredContent!;
            const b = second.structuredContent!;
            expect(a.deduplicated).toBe(false);
            expect(b.deduplicated).toBe(true);
            expect(b.event_id).toBe(a.event_id);
            expect(b.version).toBe(1);
            // The replayed response still reports journal state honestly.
            expect(b.external_sync).toBe("pending");
            expect((b.journal as unknown[]).length).toBe(1);

            const { rows } = await pool.query(
                `SELECT
                    (SELECT count(*) FROM meal_events) AS events,
                    (SELECT count(*) FROM meal_event_items) AS items,
                    (SELECT count(*) FROM meal_event_sync_journal) AS journal`,
            );
            expect(Number(rows[0]!.events)).toBe(1);
            expect(Number(rows[0]!.items)).toBe(2);
            expect(Number(rows[0]!.journal)).toBe(1);
        });
    });
    test("rejects safe but unrelated media storage keys", async () => {
        await withTools(pool, async (call) => {
            const r = await call(
                "log_meal_event",
                validArgs({
                    media: [
                        {
                            kind: "photo",
                            storage_key: "evt/1/photo-abc",
                            mime_type: "image/jpeg",
                            byte_size: 123,
                            sha256: "a".repeat(64),
                        },
                    ],
                }),
            );
            expect(r.isError).toBe(true);
            const { rows } = await pool.query(
                "SELECT count(*) AS n FROM meal_events",
            );
            expect(Number(rows[0]!.n)).toBe(0);
        });
    });
    test("validation rejects malformed input before any write", async () => {
        await withTools(pool, async (call) => {
            const cases: Record<string, unknown>[] = [
                validArgs({
                    items: [
                        { ordinal: 0, raw_item_text: "a" },
                        { ordinal: 0, raw_item_text: "b" },
                    ],
                }),
                validArgs({ items: [] }),
                validArgs({
                    media: [
                        {
                            kind: "photo",
                            storage_key: "k",
                            mime_type: "not-a-mime",
                            byte_size: 1,
                            sha256: "a".repeat(64),
                        },
                    ],
                }),
                validArgs({
                    media: [
                        {
                            kind: "photo",
                            storage_key: "k",
                            mime_type: "image/jpeg",
                            byte_size: -5,
                            sha256: "a".repeat(64),
                        },
                    ],
                }),
                validArgs({ reported_at: "not a timestamp" }),
            ];
            for (const args of cases) {
                const r = await call("log_meal_event", args);
                expect(r.isError).toBe(true);
            }
            const { rows } = await pool.query(
                "SELECT count(*) AS n FROM meal_events",
            );
            expect(Number(rows[0]!.n)).toBe(0);
        });
    });
});

describeDb("meal capture MCP lifecycle tools", () => {
    let pool: Pool;
    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });
    afterAll(() => pool.end());
    afterEach(async () => {
        await flushAnalytics();
    });
    beforeEach(async () => {
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            for (const path of [
                "001_initial_schema.sql",
                "002_food_tracking.sql",
                "003_meal_captures.sql",
            ])
                await client.query(
                    await Bun.file(`db/migrations/${path}`).text(),
                );
        } finally {
            client.release();
        }
    });
    test("rejects cross-user capture message, answer, and draft mutations", async () => {
        const other = await startMealCapture(pool, {
            user_id: "u2",
            conversation_key: "other-mutators",
            idempotency_key: "mcp-other-mutators",
        });
        await withTools(pool, async (call) => {
            expect(
                (
                    await call("append_meal_capture_message", {
                        capture_id: other.capture_id,
                        message: {
                            external_message_id: "cross-user-message",
                            kind: "text",
                            text: "no",
                        },
                    })
                ).isError,
            ).toBe(true);
            expect(
                (
                    await call("answer_meal_capture", {
                        capture_id: other.capture_id,
                        answer: { question: "q", answer: "a" },
                    })
                ).isError,
            ).toBe(true);
            expect(
                (
                    await call("save_meal_capture_draft", {
                        capture_id: other.capture_id,
                        draft: {
                            reported_at: "2026-08-05T12:00:00Z",
                            items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                            inputs: [],
                            media: [],
                            parser_policy_version: "hermes.v1",
                            created_by: "hermes",
                        },
                    })
                ).isError,
            ).toBe(true);
        });
        const row = await pool.query(
            "SELECT state, prepared_draft FROM meal_captures WHERE id=$1",
            [other.capture_id],
        );
        expect(row.rows[0]).toMatchObject({
            state: "receiving",
            prepared_draft: null,
        });
        expect(
            (
                await pool.query(
                    "SELECT count(*) AS n FROM meal_capture_messages WHERE capture_id=$1",
                    [other.capture_id],
                )
            ).rows[0]!.n,
        ).toBe("0");
        expect(
            (
                await pool.query(
                    "SELECT count(*) AS n FROM meal_capture_answers WHERE capture_id=$1",
                    [other.capture_id],
                )
            ).rows[0]!.n,
        ).toBe("0");
    });
    test("discovers and calls get/cancel/expire with user scoping and states", async () => {
        const own = await startMealCapture(pool, {
            user_id: "u1",
            conversation_key: "own",
            idempotency_key: "mcp-own",
        });
        const other = await startMealCapture(pool, {
            user_id: "u2",
            conversation_key: "other",
            idempotency_key: "mcp-other",
        });
        await withTools(pool, async (call, client) => {
            const listed = await client!.listTools();
            expect(listed.tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                    "get_meal_capture",
                    "cancel_meal_capture",
                    "expire_meal_capture",
                ]),
            );
            const hidden = await call("get_meal_capture", {
                capture_id: other.capture_id,
            });
            expect(JSON.parse(hidden.content[0]!.text!)).toBeNull();
            const read = await call("get_meal_capture", {
                capture_id: own.capture_id,
            });
            expect(JSON.parse(read.content[0]!.text!)).toMatchObject({
                capture_id: own.capture_id,
                state: "receiving",
            });
            const cancelled = await call("cancel_meal_capture", {
                capture_id: own.capture_id,
            });
            expect(JSON.parse(cancelled.content[0]!.text!)).toMatchObject({
                state: "cancelled",
            });
            const illegal = await call("expire_meal_capture", {
                capture_id: own.capture_id,
            });
            expect(illegal.isError).toBe(true);
        });
    });
    test("rejects cross-user capture message, answer, and draft mutations", async () => {
        const other = await startMealCapture(pool, {
            user_id: "u2",
            conversation_key: "other-mutators",
            idempotency_key: "mcp-other-mutators",
        });
        await withTools(pool, async (call) => {
            expect(
                (
                    await call("append_meal_capture_message", {
                        capture_id: other.capture_id,
                        message: {
                            external_message_id: "cross-user-message",
                            kind: "text",
                            text: "no",
                        },
                    })
                ).isError,
            ).toBe(true);
            expect(
                (
                    await call("answer_meal_capture", {
                        capture_id: other.capture_id,
                        answer: { question: "q", answer: "a" },
                    })
                ).isError,
            ).toBe(true);
            expect(
                (
                    await call("save_meal_capture_draft", {
                        capture_id: other.capture_id,
                        draft: {
                            reported_at: "2026-08-05T12:00:00Z",
                            items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                            inputs: [],
                            media: [],
                            parser_policy_version: "hermes.v1",
                            created_by: "hermes",
                        },
                    })
                ).isError,
            ).toBe(true);
        });
        const row = await pool.query(
            "SELECT state, prepared_draft FROM meal_captures WHERE id=$1",
            [other.capture_id],
        );
        expect(row.rows[0]).toMatchObject({
            state: "receiving",
            prepared_draft: null,
        });
        expect(
            (
                await pool.query(
                    "SELECT count(*) AS n FROM meal_capture_messages WHERE capture_id=$1",
                    [other.capture_id],
                )
            ).rows[0]!.n,
        ).toBe("0");
        expect(
            (
                await pool.query(
                    "SELECT count(*) AS n FROM meal_capture_answers WHERE capture_id=$1",
                    [other.capture_id],
                )
            ).rows[0]!.n,
        ).toBe("0");
    });
});
