import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
    registerTools,
    ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA,
    CAPTURE_STATE_OUTPUT_SCHEMA,
    CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA,
    GET_MEAL_CAPTURE_OUTPUT_SCHEMA,
} from "./mcp.js";
import { startMealCapture } from "./meal-captures.js";
import { createMediaStore, type MediaStore } from "./media-store.js";
import { flushAnalytics } from "./analytics.js";
import { stableBundleFingerprint } from "./nutrition-bundle-types.js";
import {
    CALCULATION_BUNDLE_OUTPUT_SCHEMA,
    CALCULATION_PROVENANCE_OUTPUT_SCHEMA,
} from "./calculation-bundles.js";

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

// Shared reset for DB-gated suites: drop the public schema and replay the
// given migrations in order so each test starts from a clean database.
async function resetSchemaWithMigrations(
    pool: Pool,
    migrations: string[],
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        for (const path of migrations) {
            await client.query(await Bun.file(`db/migrations/${path}`).text());
        }
    } finally {
        client.release();
    }
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
    extraDeps: { mediaStore?: MediaStore; userId?: string } = {},
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, extraDeps.userId ?? "u1", false, null, {
        mealEventsPool: pool,
        ...(extraDeps.mediaStore ? { mediaStore: extraDeps.mediaStore } : {}),
    });
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
        await resetSchemaWithMigrations(pool, [
            "001_initial_schema.sql",
            "002_food_tracking.sql",
            "003_meal_captures.sql",
            "004_calculation_bundles.sql",
            "005_calculation_corrections.sql",
            "011_nutrient_expansion.sql",
        ]);
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

describeDb(
    "calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;

        beforeAll(() => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST });
        });

        afterAll(async () => {
            await pool.end();
        });

        // Drain fire-and-forget analytics writes before the next test drops
        // the schema, so no write lands on a missing tool_analytics table.
        afterEach(async () => {
            await flushAnalytics();
        });

        beforeEach(async () => {
            await resetSchemaWithMigrations(pool, [
                "001_initial_schema.sql",
                "002_food_tracking.sql",
                "003_meal_captures.sql",
                "004_calculation_bundles.sql",
                "005_calculation_corrections.sql",
                "011_nutrient_expansion.sql",
            ]);
        });

        test("commits an event+item bundle and reads item canonicals back through public provenance", async () => {
            // Seed an owned event + version so the bundle commit has a target.
            await pool.query(
                `INSERT INTO meal_events (id, user_id, reported_at, consumed_at, idempotency_key)
                 VALUES ($1, 'u1', now(), now(), 'mcp-scoped-bundle-event')`,
                ["00000000-0000-4000-8000-000000000101"],
            );
            await pool.query(
                `INSERT INTO meal_event_versions (event_id, version, parser_policy_version, created_by)
                 VALUES ($1, 1, 'mcp-test', 'mcp-test')`,
                ["00000000-0000-4000-8000-000000000101"],
            );
            const scopedResult = (
                provider: "nutrition-local" | "own",
                ordinal: number | null,
                calories: number,
            ) => ({
                provider,
                status: "succeeded" as const,
                scope: { ordinal },
                source_id: `${provider}-${ordinal ?? "event"}-source`,
                request_fingerprint: `${provider}-request-${ordinal ?? "event"}`,
                algorithm_version: "v1",
                basis: "per_meal" as const,
                units: "g_and_kcal" as const,
                nutrients: { calories },
                raw_payload: { provider, ordinal, calories },
                provenance: { provider, retrieved_at: "2026-08-05T12:00:00Z" },
            });
            const bundleInput = {
                event_id: "00000000-0000-4000-8000-000000000101",
                version: 1,
                resolved_input: {
                    items: [
                        { ordinal: 0, raw_item_text: "oatmeal 80g" },
                        { ordinal: 1, raw_item_text: "banana" },
                    ],
                    inputs: [],
                },
                results: [
                    scopedResult("nutrition-local", null, 500),
                    scopedResult("own", null, 510),
                    scopedResult("nutrition-local", 0, 300),
                    scopedResult("own", 0, 306),
                    scopedResult("nutrition-local", 1, 200),
                    scopedResult("own", 1, 202),
                ],
            };
            const bundle = {
                ...bundleInput,
                fingerprint: stableBundleFingerprint(bundleInput),
            };
            await withTools(pool, async (call) => {
                const committed = await call("commit_calculation_bundle", {
                    bundle,
                });
                expect(committed.isError).not.toBe(true);
                const bundleOutput = CALCULATION_BUNDLE_OUTPUT_SCHEMA.parse(
                    committed.structuredContent,
                );
                expect(bundleOutput.canonical?.nutrients.calories).toBe(505);
                expect(
                    bundleOutput.item_canonicals.map((c) => c.ordinal),
                ).toEqual([0, 1]);
                expect(
                    bundleOutput.item_canonicals[0]!.nutrients.calories,
                ).toBe(303);
                expect(
                    bundleOutput.item_canonicals[1]!.nutrients.calories,
                ).toBe(201);

                const provenance = await call("get_calculation_provenance", {
                    event_id: bundle.event_id,
                });
                expect(provenance.isError).not.toBe(true);
                const provenanceOutput =
                    CALCULATION_PROVENANCE_OUTPUT_SCHEMA.parse(
                        provenance.structuredContent,
                    );
                expect(provenanceOutput.canonical?.nutrients.calories).toBe(
                    505,
                );
                expect(
                    provenanceOutput.item_canonicals.map((c) => c.ordinal),
                ).toEqual([0, 1]);
                expect(
                    provenanceOutput.item_canonicals.map(
                        (c) => c.nutrients.calories,
                    ),
                ).toEqual([303, 201]);
                // Scope-local sources: each item canonical references only its
                // own scope's provider rows.
                for (const item of provenanceOutput.item_canonicals) {
                    const scoped = provenanceOutput.providers.filter(
                        (p) => p.ordinal === item.ordinal,
                    );
                    expect(item.source_result_ids?.sort()).toEqual(
                        scoped.map((p) => p.id).sort(),
                    );
                }
            });
            // DB-level cross-check in the same test: three canonical rows.
            const rows = await pool.query(
                `SELECT scope_key FROM meal_event_canonical_results
                  WHERE event_id = $1 AND version = 1 ORDER BY scope_key`,
                [bundle.event_id],
            );
            expect(rows.rows.map((r) => r.scope_key)).toEqual([
                "event",
                "item:0",
                "item:1",
            ]);
        });
    },
);

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
        await resetSchemaWithMigrations(pool, [
            "001_initial_schema.sql",
            "002_food_tracking.sql",
            "003_meal_captures.sql",
            "011_nutrient_expansion.sql",
        ]);
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
    test("rejects cross-user capture message, answer, and draft mutations without persisting rows", async () => {
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

// ---------------------------------------------------------------------------
// attach_meal_capture_media: the public byte path. Real InMemoryTransport,
// real PostgreSQL, real temporary filesystem media root. Filesystem bytes and
// recomputed hashes are asserted alongside DB rows.
// ---------------------------------------------------------------------------

const MCP_PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8,
]);
const MCP_PNG_BASE64 = Buffer.from(MCP_PNG_BYTES).toString("base64");
const MCP_PNG_SHA256 = new Bun.CryptoHasher("sha256")
    .update(MCP_PNG_BYTES)
    .digest("hex");

async function stagedMediaFiles(root: string): Promise<string[]> {
    try {
        const entries = await readdir(root, { recursive: true });
        return entries
            .map((entry) => entry.toString())
            .filter((entry) =>
                /(?:^|\/)(?:photo|audio)-[0-9a-f]{64}(?:\.[a-z0-9]+)?$/.test(
                    entry,
                ),
            )
            .sort();
    } catch {
        return [];
    }
}

describeDb("attach_meal_capture_media MCP tool", () => {
    let pool: Pool;
    let mediaRoot: string;
    let mediaStore: MediaStore;
    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });
    afterAll(async () => {
        await pool.end();
    });
    afterEach(async () => {
        await flushAnalytics();
        await rm(mediaRoot, { recursive: true, force: true });
    });
    beforeEach(async () => {
        await resetSchemaWithMigrations(pool, [
            "001_initial_schema.sql",
            "002_food_tracking.sql",
            "003_meal_captures.sql",
            "004_calculation_bundles.sql",
            "005_calculation_corrections.sql",
            "011_nutrient_expansion.sql",
        ]);
        // Fresh media root per test: the DB resets per test, so the
        // filesystem must too, or staged files from prior tests leak in.
        mediaRoot = await mkdtemp(join(tmpdir(), "mcp-capture-media-test-"));
        mediaStore = createMediaStore(mediaRoot);
    });

    test("start -> attach -> draft referencing media -> confirm persists event media", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "media-flow",
                    idempotency_key: "mcp-media-flow",
                });
                expect(started.isError).not.toBe(true);
                const captureId = JSON.parse(started.content[0]!.text!)
                    .capture_id as string;

                const attached = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: MCP_PNG_BASE64,
                    idempotency_key: "mcp-media-flow-attach-1",
                });
                expect(attached.isError).not.toBe(true);
                const media = ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA.parse(
                    attached.structuredContent,
                );
                expect(media.capture_id).toBe(captureId);
                expect(media.deduplicated).toBe(false);
                expect(media.sha256).toBe(MCP_PNG_SHA256);
                expect(media.byte_size).toBe(MCP_PNG_BYTES.byteLength);
                expect(media.storage_key).toBe(
                    `capture/${captureId}/photo-${MCP_PNG_SHA256}.png`,
                );
                expect(media.capture_state).toBe("receiving");
                // Filesystem truth before confirm.
                const stagedPath = join(mediaRoot, media.storage_key);
                expect(await Bun.file(stagedPath).exists()).toBe(true);
                const onDisk = new Uint8Array(
                    await Bun.file(stagedPath).arrayBuffer(),
                );
                expect(onDisk).toEqual(MCP_PNG_BYTES);
                expect(
                    new Bun.CryptoHasher("sha256").update(onDisk).digest("hex"),
                ).toBe(media.sha256);

                const drafted = await call("save_meal_capture_draft", {
                    capture_id: captureId,
                    draft: {
                        reported_at: "2026-08-05T12:00:00Z",
                        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                        inputs: [
                            {
                                source_kind: "user_text",
                                content: "oatmeal with a photo",
                            },
                        ],
                        media: [
                            {
                                kind: media.kind,
                                storage_key: media.storage_key,
                                mime_type: media.mime_type,
                                byte_size: media.byte_size,
                                sha256: media.sha256,
                                metadata: media.metadata,
                            },
                        ],
                        parser_policy_version: "hermes.v1",
                        created_by: "hermes",
                    },
                });
                expect(drafted.isError).not.toBe(true);

                const confirmed = await call("confirm_meal_capture", {
                    capture_id: captureId,
                    confirmation: "add",
                });
                expect(confirmed.isError).not.toBe(true);
                const confirmedContent = confirmed.structuredContent!;
                expect(confirmedContent.state).toBe("confirmed");
                const eventId = confirmedContent.event_id as string;

                // The event aggregate carries the capture-scoped media row.
                const eventMedia = await pool.query(
                    `SELECT kind, storage_key, mime_type, byte_size, sha256 FROM meal_event_media WHERE event_id=$1 AND version=1`,
                    [eventId],
                );
                expect(eventMedia.rows).toHaveLength(1);
                expect(eventMedia.rows[0]).toMatchObject({
                    kind: "photo",
                    storage_key: media.storage_key,
                    mime_type: "image/png",
                    sha256: media.sha256,
                });
                expect(Number(eventMedia.rows[0]!.byte_size)).toBe(
                    MCP_PNG_BYTES.byteLength,
                );
                // Bytes survive confirmation (no promotion in this slice).
                expect(await Bun.file(stagedPath).exists()).toBe(true);
            },
            { mediaStore },
        );
    });

    test("retry through MCP returns the same media identity without duplicating row or file", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "media-retry",
                    idempotency_key: "mcp-media-retry",
                });
                const captureId = JSON.parse(started.content[0]!.text!)
                    .capture_id as string;
                const args = {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: MCP_PNG_BASE64,
                };
                const first = await call("attach_meal_capture_media", args);
                const second = await call("attach_meal_capture_media", args);
                expect(first.isError).not.toBe(true);
                expect(second.isError).not.toBe(true);
                const a = ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA.parse(
                    first.structuredContent,
                );
                const b = ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA.parse(
                    second.structuredContent,
                );
                expect(a.deduplicated).toBe(false);
                expect(b.deduplicated).toBe(true);
                expect(b.media_id).toBe(a.media_id);
                expect(b.storage_key).toBe(a.storage_key);
                const { rows } = await pool.query(
                    `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
                    [captureId],
                );
                expect(Number(rows[0]!.n)).toBe(1);
                expect(await stagedMediaFiles(mediaRoot)).toEqual([
                    a.storage_key,
                ]);
            },
            { mediaStore },
        );
    });

    test("rejects cross-user capture media attach", async () => {
        const other = await startMealCapture(pool, {
            user_id: "u2",
            conversation_key: "other-media",
            idempotency_key: "mcp-other-media",
        });
        await withTools(
            pool,
            async (call) => {
                const r = await call("attach_meal_capture_media", {
                    capture_id: other.capture_id,
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: MCP_PNG_BASE64,
                });
                expect(r.isError).toBe(true);
            },
            { mediaStore },
        );
        const { rows } = await pool.query(
            `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
            [other.capture_id],
        );
        expect(Number(rows[0]!.n)).toBe(0);
        expect(await stagedMediaFiles(mediaRoot)).toEqual([]);
    });

    test("malformed input matrix: invalid base64, disallowed MIME, kind mismatch, oversized", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "media-malformed",
                    idempotency_key: "mcp-media-malformed",
                });
                const captureId = JSON.parse(started.content[0]!.text!)
                    .capture_id as string;
                const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
                const cases: Record<string, unknown>[] = [
                    {
                        capture_id: captureId,
                        kind: "photo",
                        mime_type: "image/png",
                        bytes_base64: "!!!not-valid-base64!!!",
                    },
                    {
                        capture_id: captureId,
                        kind: "photo",
                        mime_type: "image/gif",
                        bytes_base64: MCP_PNG_BASE64,
                    },
                    {
                        capture_id: captureId,
                        kind: "audio",
                        mime_type: "image/png",
                        bytes_base64: MCP_PNG_BASE64,
                    },
                    {
                        capture_id: captureId,
                        kind: "photo",
                        mime_type: "image/png",
                        bytes_base64: oversized.toString("base64"),
                    },
                    {
                        capture_id: captureId,
                        kind: "photo",
                        mime_type: "image/png",
                        bytes_base64: MCP_PNG_BASE64,
                        sha256: "f".repeat(64),
                    },
                ];
                for (const args of cases) {
                    const r = await call("attach_meal_capture_media", args);
                    expect(r.isError).toBe(true);
                }
                const { rows } = await pool.query(
                    `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
                    [captureId],
                );
                expect(Number(rows[0]!.n)).toBe(0);
                expect(await stagedMediaFiles(mediaRoot)).toEqual([]);
            },
            { mediaStore },
        );
    });

    test("attach on a confirmed capture is rejected and stages nothing", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "media-confirmed",
                    idempotency_key: "mcp-media-confirmed",
                });
                const captureId = JSON.parse(started.content[0]!.text!)
                    .capture_id as string;
                await call("save_meal_capture_draft", {
                    capture_id: captureId,
                    draft: {
                        reported_at: "2026-08-05T12:00:00Z",
                        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                        inputs: [],
                        media: [],
                        parser_policy_version: "hermes.v1",
                        created_by: "hermes",
                    },
                });
                const confirmed = await call("confirm_meal_capture", {
                    capture_id: captureId,
                    confirmation: "add",
                });
                expect(confirmed.isError).not.toBe(true);
                const late = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: MCP_PNG_BASE64,
                });
                expect(late.isError).toBe(true);
                expect(late.content[0]!.text).toContain(
                    "capture is no longer editable",
                );
                const { rows } = await pool.query(
                    `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
                    [captureId],
                );
                expect(Number(rows[0]!.n)).toBe(0);
                expect(await stagedMediaFiles(mediaRoot)).toEqual([]);
            },
            { mediaStore },
        );
    });

    test("append_meal_capture_message rejects schema-invalid message before the handler", async () => {
        await withTools(pool, async (call) => {
            const started = await call("start_meal_capture", {
                conversation_key: "schema-reject",
                idempotency_key: "schema-reject-1",
            });
            const { capture_id } = JSON.parse(started.content[0]!.text!);
            const bad = await call("append_meal_capture_message", {
                capture_id,
                message: { kind: "text", text: "no id" }, // missing external_message_id + received_at
            });
            expect(bad.isError).toBe(true);
            // No message row was persisted.
            const rows = await pool.query(
                "SELECT count(*) FROM meal_capture_messages",
            );
            expect(rows.rows[0]!.count).toBe("0");
        });
    });
});

// ---------------------------------------------------------------------------
// attach_meal_capture_media file_path MCP tool
// ---------------------------------------------------------------------------

describeDb("attach_meal_capture_media file_path MCP tool", () => {
    let pool: Pool;
    let mediaRoot: string;
    let mediaStore: MediaStore;
    let tmpFilePath: string;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });
    afterAll(async () => {
        await pool.end();
    });
    afterEach(async () => {
        await flushAnalytics();
        await rm(mediaRoot, { recursive: true, force: true });
    });
    beforeEach(async () => {
        await resetSchemaWithMigrations(pool, [
            "001_initial_schema.sql",
            "002_food_tracking.sql",
            "003_meal_captures.sql",
            "004_calculation_bundles.sql",
            "005_calculation_corrections.sql",
            "011_nutrient_expansion.sql",
        ]);
        mediaRoot = await mkdtemp(
            join(tmpdir(), "mcp-capture-media-filepath-"),
        );
        mediaStore = createMediaStore(mediaRoot);

        // Write a real temp file for the file_path tests inside the media
        // root so the regular root cleanup handles it.
        tmpFilePath = join(mediaRoot, "test-photo.png");
        await Bun.write(tmpFilePath, MCP_PNG_BYTES);
    });

    test("attach via file_path produces same result as bytes_base64", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-flow",
                    idempotency_key: "mcp-filepath-flow",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;

                const attached = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: tmpFilePath,
                    idempotency_key: "mcp-filepath-attach-1",
                });
                expect(attached.isError).not.toBe(true);
                const media = ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA.parse(
                    attached.structuredContent,
                );
                expect(media.capture_id).toBe(captureId);
                expect(media.deduplicated).toBe(false);
                expect(media.sha256).toBe(MCP_PNG_SHA256);
                expect(media.byte_size).toBe(MCP_PNG_BYTES.byteLength);
                expect(media.storage_key).toBe(
                    `capture/${captureId}/photo-${MCP_PNG_SHA256}.png`,
                );

                // Full round-trip: attach → draft → confirm → verify media
                await call("save_meal_capture_draft", {
                    capture_id: captureId,
                    draft: {
                        reported_at: "2026-08-05T12:00:00Z",
                        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                        inputs: [
                            {
                                source_kind: "user_text",
                                content: "oatmeal",
                            },
                        ],
                        media: [
                            {
                                kind: media.kind,
                                storage_key: media.storage_key,
                                mime_type: media.mime_type,
                                byte_size: media.byte_size,
                                sha256: media.sha256,
                                metadata: media.metadata,
                            },
                        ],
                        parser_policy_version: "hermes.v1",
                        created_by: "hermes",
                    },
                });
                const confirmed = await call("confirm_meal_capture", {
                    capture_id: captureId,
                    confirmation: "add",
                });
                expect(confirmed.isError).not.toBe(true);
            },
            { mediaStore },
        );
    });

    test("rejects both file_path and bytes_base64", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-both",
                    idempotency_key: "mcp-filepath-both",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;
                const r = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: tmpFilePath,
                    bytes_base64: MCP_PNG_BASE64,
                });
                expect(r.isError).toBe(true);
                expect(r.content[0]!.text).toContain("not both");
            },
            { mediaStore },
        );
    });

    test("rejects relative file_path", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-relative",
                    idempotency_key: "mcp-filepath-relative",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;
                const r = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: "test-photo.png",
                });
                expect(r.isError).toBe(true);
                expect(r.content[0]!.text).toContain("absolute path");
            },
            { mediaStore },
        );
    });

    test("rejects file_path that does not exist", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-missing",
                    idempotency_key: "mcp-filepath-missing",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;
                const r = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: "/tmp/nonexistent-file-xxx.png",
                });
                expect(r.isError).toBe(true);
                expect(r.content[0]!.text).toContain("does not exist");
            },
            { mediaStore },
        );
    });

    test("rejects file_path with .. segments", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-dotdot",
                    idempotency_key: "mcp-filepath-dotdot",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;
                const r = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: "/tmp/../etc/passwd",
                });
                expect(r.isError).toBe(true);
                expect(r.content[0]!.text).toContain("..");
            },
            { mediaStore },
        );
    });

    test("sha256 cross-check on file_path (mismatch → error)", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-sha256",
                    idempotency_key: "mcp-filepath-sha256",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;
                const r = await call("attach_meal_capture_media", {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: tmpFilePath,
                    sha256: "f".repeat(64),
                });
                expect(r.isError).toBe(true);
                expect(r.content[0]!.text).toContain("sha256 does not match");
            },
            { mediaStore },
        );
    });

    test("retry with file_path is idempotent", async () => {
        await withTools(
            pool,
            async (call) => {
                const started = await call("start_meal_capture", {
                    conversation_key: "filepath-retry",
                    idempotency_key: "mcp-filepath-retry",
                });
                const captureId = JSON.parse(
                    started.content[0]!.text!,
                ).capture_id;
                const args = {
                    capture_id: captureId,
                    kind: "photo",
                    mime_type: "image/png",
                    file_path: tmpFilePath,
                };
                const first = await call("attach_meal_capture_media", args);
                const second = await call("attach_meal_capture_media", args);
                expect(first.isError).not.toBe(true);
                expect(second.isError).not.toBe(true);
                const a = ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA.parse(
                    first.structuredContent,
                );
                const b = ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA.parse(
                    second.structuredContent,
                );
                expect(a.deduplicated).toBe(false);
                expect(b.deduplicated).toBe(true);
                expect(b.media_id).toBe(a.media_id);
                expect(b.storage_key).toBe(a.storage_key);
                const { rows } = await pool.query(
                    `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
                    [captureId],
                );
                expect(Number(rows[0]!.n)).toBe(1);
            },
            { mediaStore },
        );
    });
});

// ---------------------------------------------------------------------------
// S6 capture lifecycle structured-output contracts. Every one of the nine
// lifecycle tools must (a) advertise a declared outputSchema over listTools
// and (b) return runtime structuredContent on success that parses through the
// exact exported schema and rejects extra keys under .strict().
// ---------------------------------------------------------------------------

const CAPTURE_LIFECYCLE_TOOLS = [
    "start_meal_capture",
    "append_meal_capture_message",
    "answer_meal_capture",
    "save_meal_capture_draft",
    "get_meal_capture",
    "cancel_meal_capture",
    "expire_meal_capture",
    "confirm_meal_capture",
    "attach_meal_capture_media",
] as const;

type CaptureLifecycleTool = (typeof CAPTURE_LIFECYCLE_TOOLS)[number];

// The exact exported schema each tool's runtime structuredContent must
// satisfy. Every contract — including confirm — is an exported strict Zod
// object, returned directly with no test-synthesized wrapper.
function captureSchemaFor(tool: CaptureLifecycleTool): z.ZodTypeAny {
    if (tool === "get_meal_capture") return GET_MEAL_CAPTURE_OUTPUT_SCHEMA;
    if (tool === "confirm_meal_capture")
        return CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA;
    if (tool === "attach_meal_capture_media")
        return ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA;
    return CAPTURE_STATE_OUTPUT_SCHEMA;
}

function parseCaptureStructured(
    tool: CaptureLifecycleTool,
    result: ToolResult,
): Record<string, unknown> {
    expect(result.isError, `${tool} returned an MCP error`).not.toBe(true);
    expect(
        result.structuredContent,
        `${tool} returned no structuredContent`,
    ).toBeDefined();
    const schema = captureSchemaFor(tool);
    const parsed = schema.parse(result.structuredContent) as Record<
        string,
        unknown
    >;
    // Strict extra-key rejection on the exact runtime payload shape.
    expect(() =>
        schema.parse({ ...parsed, unexpected_extra_key: true }),
    ).toThrow();
    return parsed;
}

// The exported confirm contract must be directly parseable and strict with
// no test-synthesized wrapper: S6 requires the exact exported schema to
// parse runtime structuredContent and reject extra keys on its own.
describe("confirm_meal_capture exported output schema (S6)", () => {
    const validConfirmOutput = {
        capture_id: "cap-1",
        state: "confirmed",
        event_id: "evt-1",
        version: 1,
        deduplicated: false,
        provenance_status: "ready",
        compatibility: true,
        bundle_fingerprint: "fp-1",
        canonical: {
            calories: 500,
            protein_g: 30,
            carbs_g: 50,
            fat_g: 20,
            fiber_g: null,
            sugar_g: null,
            alcohol_g: null,
        },
    } as const;

    test("parses a valid confirm payload through the exact export", () => {
        expect(
            CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA.parse(validConfirmOutput),
        ).toEqual(validConfirmOutput);
        expect(
            CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA.parse({
                ...validConfirmOutput,
                bundle_fingerprint: null,
                canonical: null,
            }),
        ).toEqual({
            ...validConfirmOutput,
            bundle_fingerprint: null,
            canonical: null,
        });
    });

    test("rejects extra keys under its own .strict() boundary", () => {
        expect(() =>
            CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA.parse({
                ...validConfirmOutput,
                unexpected_extra_key: true,
            }),
        ).toThrow();
    });
});

describeDb(
    "capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;
        let mediaRoot: string;
        let mediaStore: MediaStore;
        beforeAll(() => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST });
        });
        afterAll(async () => {
            await pool.end();
        });
        afterEach(async () => {
            await flushAnalytics();
            await rm(mediaRoot, { recursive: true, force: true });
        });
        beforeEach(async () => {
            await resetSchemaWithMigrations(pool, [
                "001_initial_schema.sql",
                "002_food_tracking.sql",
                "003_meal_captures.sql",
                "004_calculation_bundles.sql",
                "005_calculation_corrections.sql",
                "011_nutrient_expansion.sql",
            ]);
            mediaRoot = await mkdtemp(join(tmpdir(), "mcp-capture-s6-test-"));
            mediaStore = createMediaStore(mediaRoot);
        });

        test("inventory: all nine capture lifecycle tools advertise a declared outputSchema", async () => {
            expect(CAPTURE_LIFECYCLE_TOOLS).toHaveLength(9);
            await withTools(pool, async (_call, client) => {
                const { tools } = await client!.listTools();
                const byName = new Map(tools.map((tool) => [tool.name, tool]));
                for (const name of CAPTURE_LIFECYCLE_TOOLS) {
                    const tool = byName.get(name);
                    expect(tool, `${name} is not registered`).toBeDefined();
                    expect(
                        tool!.outputSchema,
                        `${name} advertises no outputSchema`,
                    ).toBeDefined();
                }
            });
        });

        test("start -> append -> answer -> draft -> get -> cancel returns schema-exact structuredContent", async () => {
            await withTools(pool, async (call) => {
                const startArgs = {
                    conversation_key: "s6-flow",
                    idempotency_key: "mcp-s6-flow",
                };
                const startedResult = await call(
                    "start_meal_capture",
                    startArgs,
                );
                const started = parseCaptureStructured(
                    "start_meal_capture",
                    startedResult,
                );
                expect(started.state).toBe("receiving");
                expect(started.deduplicated).toBe(false);
                expect(started.event_id).toBeNull();
                expect(started.version).toBeNull();
                const captureId = started.capture_id as string;
                // Text compatibility: the human-readable JSON payload stays.
                expect(
                    JSON.parse(startedResult.content[0]!.text!).capture_id,
                ).toBe(captureId);

                const replayed = parseCaptureStructured(
                    "start_meal_capture",
                    await call("start_meal_capture", startArgs),
                );
                expect(replayed.deduplicated).toBe(true);
                expect(replayed.capture_id).toBe(captureId);

                const appendedResult = await call(
                    "append_meal_capture_message",
                    {
                        capture_id: captureId,
                        message: {
                            external_message_id: "msg-1",
                            kind: "text",
                            text: "oatmeal 80g",
                            received_at: "2026-08-05T12:00:00.000Z",
                        },
                    },
                );
                const appended = parseCaptureStructured(
                    "append_meal_capture_message",
                    appendedResult,
                );
                expect(appended.capture_id).toBe(captureId);
                expect(appended.state).toBe("receiving");
                // Text compatibility: the acknowledgement string stays.
                expect(appendedResult.content[0]!.text).toBe(
                    "Capture message retained.",
                );

                const answeredResult = await call("answer_meal_capture", {
                    capture_id: captureId,
                    answer: { question: "portion size?", answer: "80g" },
                });
                const answered = parseCaptureStructured(
                    "answer_meal_capture",
                    answeredResult,
                );
                expect(answered.capture_id).toBe(captureId);
                expect(answered.state).toBe("receiving");
                expect(answeredResult.content[0]!.text).toBe(
                    "Capture answer retained.",
                );

                const draftedResult = await call("save_meal_capture_draft", {
                    capture_id: captureId,
                    draft: {
                        reported_at: "2026-08-05T12:00:00Z",
                        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                        inputs: [
                            {
                                source_kind: "user_text",
                                content: "oatmeal 80g",
                            },
                        ],
                        media: [],
                        parser_policy_version: "hermes.v1",
                        created_by: "hermes",
                    },
                });
                const drafted = parseCaptureStructured(
                    "save_meal_capture_draft",
                    draftedResult,
                );
                expect(drafted.state).toBe("ready_to_confirm");
                expect(draftedResult.content[0]!.text).toBe(
                    "Meal draft ready for explicit confirmation.",
                );

                const read = parseCaptureStructured(
                    "get_meal_capture",
                    await call("get_meal_capture", { capture_id: captureId }),
                );
                const capture = read.capture as Record<string, unknown>;
                expect(capture.capture_id).toBe(captureId);
                expect(capture.state).toBe("ready_to_confirm");
                expect(capture.user_id).toBe("u1");
                expect(capture.conversation_key).toBe("s6-flow");
                expect(capture.messages).toHaveLength(1);
                expect(capture.answers).toHaveLength(1);
                expect(capture.prepared_draft).not.toBeNull();

                // A missing capture is an explicit null, not an error.
                const missing = parseCaptureStructured(
                    "get_meal_capture",
                    await call("get_meal_capture", {
                        capture_id: "00000000-0000-4000-8000-000000000999",
                    }),
                );
                expect(missing.capture).toBeNull();

                const cancelled = parseCaptureStructured(
                    "cancel_meal_capture",
                    await call("cancel_meal_capture", {
                        capture_id: captureId,
                    }),
                );
                expect(cancelled.state).toBe("cancelled");
                expect(cancelled.deduplicated).toBe(false);
                const cancelReplay = parseCaptureStructured(
                    "cancel_meal_capture",
                    await call("cancel_meal_capture", {
                        capture_id: captureId,
                    }),
                );
                expect(cancelReplay.state).toBe("cancelled");
                expect(cancelReplay.deduplicated).toBe(true);
            });
        });

        test("expire_meal_capture returns schema-exact structuredContent for overdue captures", async () => {
            await withTools(pool, async (call) => {
                const started = parseCaptureStructured(
                    "start_meal_capture",
                    await call("start_meal_capture", {
                        conversation_key: "s6-expire",
                        idempotency_key: "mcp-s6-expire",
                        expires_at: "2026-08-01T00:00:00.000Z",
                    }),
                );
                const captureId = started.capture_id as string;
                const expiredResult = await call("expire_meal_capture", {
                    capture_id: captureId,
                });
                const expired = parseCaptureStructured(
                    "expire_meal_capture",
                    expiredResult,
                );
                expect(expired.state).toBe("expired");
                expect(expired.deduplicated).toBe(false);
                expect(JSON.parse(expiredResult.content[0]!.text!).state).toBe(
                    "expired",
                );
                const replay = parseCaptureStructured(
                    "expire_meal_capture",
                    await call("expire_meal_capture", {
                        capture_id: captureId,
                    }),
                );
                expect(replay.state).toBe("expired");
                expect(replay.deduplicated).toBe(true);
            });
        });

        test("confirm and attach parse through their exact exported contracts", async () => {
            await withTools(
                pool,
                async (call) => {
                    const started = parseCaptureStructured(
                        "start_meal_capture",
                        await call("start_meal_capture", {
                            conversation_key: "s6-confirm",
                            idempotency_key: "mcp-s6-confirm",
                        }),
                    );
                    const captureId = started.capture_id as string;

                    const attached = parseCaptureStructured(
                        "attach_meal_capture_media",
                        await call("attach_meal_capture_media", {
                            capture_id: captureId,
                            kind: "photo",
                            mime_type: "image/png",
                            bytes_base64: MCP_PNG_BASE64,
                            idempotency_key: "mcp-s6-confirm-attach",
                        }),
                    );
                    expect(attached.capture_id).toBe(captureId);
                    expect(attached.capture_state).toBe("receiving");

                    const drafted = await call("save_meal_capture_draft", {
                        capture_id: captureId,
                        draft: {
                            reported_at: "2026-08-05T12:00:00Z",
                            items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
                            inputs: [
                                {
                                    source_kind: "user_text",
                                    content: "oatmeal with a photo",
                                },
                            ],
                            media: [
                                {
                                    kind: attached.kind,
                                    storage_key: attached.storage_key,
                                    mime_type: attached.mime_type,
                                    byte_size: attached.byte_size,
                                    sha256: attached.sha256,
                                    metadata: attached.metadata,
                                },
                            ],
                            parser_policy_version: "hermes.v1",
                            created_by: "hermes",
                        },
                    });
                    expect(drafted.isError).not.toBe(true);

                    const confirmedResult = await call("confirm_meal_capture", {
                        capture_id: captureId,
                        confirmation: "add",
                    });
                    const confirmed = parseCaptureStructured(
                        "confirm_meal_capture",
                        confirmedResult,
                    );
                    expect(confirmed.capture_id).toBe(captureId);
                    expect(confirmed.state).toBe("confirmed");
                    expect(typeof confirmed.event_id).toBe("string");
                    expect(confirmed.version).toBe(1);
                },
                { mediaStore },
            );
        });
    },
);
