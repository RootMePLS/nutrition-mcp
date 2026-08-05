import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool, type PoolClient } from "pg";
import { flushAnalytics } from "./analytics.js";
import {
    CALCULATION_CORRECTION_OUTPUT_SCHEMA,
    CALCULATION_PROVENANCE_OUTPUT_SCHEMA,
    CalculationBundleValidationError,
    commitCalculationBundle,
    commitCalculationCorrection,
    type CalculationCorrectionMetadata,
} from "./calculation-bundles.js";
import { registerTools } from "./mcp.js";
import {
    stableBundleFingerprint,
    type CalculationBundleInput,
} from "./nutrition-bundle-types.js";

// ---------------------------------------------------------------------------
// S2 acceptance matrix: concurrency, migration rerun safety, and correction
// guarantees pinned against real PostgreSQL and the real MCP transport. This
// suite is test-only acceptance evidence; it must never require production
// edits to pass. Migrate-all happens once in beforeAll (the gate resets the
// schema per suite); each case isolates itself with its own event id.
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;
const describeDb = DATABASE_URL_TEST ? describe : describe.skip;
const migrationPaths = [
    "db/migrations/001_initial_schema.sql",
    "db/migrations/002_food_tracking.sql",
    "db/migrations/003_meal_captures.sql",
    "db/migrations/004_calculation_bundles.sql",
    "db/migrations/005_calculation_corrections.sql",
];

if (!DATABASE_URL_TEST) {
    console.log(
        "src/calculation-acceptance.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
    );
}

const EVENT = {
    concurrentBundles: "00000000-0000-4000-8000-000000000201",
    concurrentCorrections: "00000000-0000-4000-8000-000000000202",
    migrationRerun: "00000000-0000-4000-8000-000000000203",
    correctionRollback: "00000000-0000-4000-8000-000000000204",
    staleVersion: "00000000-0000-4000-8000-000000000205",
    crossUser: "00000000-0000-4000-8000-000000000206",
    mcpCorrection: "00000000-0000-4000-8000-000000000207",
    failedProvider: "00000000-0000-4000-8000-000000000208",
} as const;

async function seedEvent(
    client: PoolClient,
    eventId: string,
    userId: string,
): Promise<void> {
    await client.query(
        `INSERT INTO meal_events (id, user_id, reported_at, consumed_at, idempotency_key)
         VALUES ($1, $2, now(), now(), $3)`,
        [eventId, userId, `s2-event-${eventId.slice(-4)}`],
    );
    await client.query(
        `INSERT INTO meal_event_versions (event_id, version, parser_policy_version, created_by)
         VALUES ($1, 1, 's2-acceptance', 's2-acceptance')`,
        [eventId],
    );
}

function scopedProvider(
    provider: "nutrition-local" | "own",
    sourceId: string,
    ordinal: number | null,
    calories: number,
) {
    return {
        provider,
        status: "succeeded" as const,
        scope: { ordinal },
        source_id: sourceId,
        request_fingerprint: `${provider}-request-${sourceId}`,
        algorithm_version: "v1",
        basis: "per_meal" as const,
        units: "g_and_kcal" as const,
        nutrients: { calories },
        raw_payload: { provider, source_id: sourceId, calories },
        provenance: { provider, retrieved_at: "2026-08-05T12:00:00Z" },
    };
}

/** Event scope + item scopes 0 and 1, two succeeded providers per scope. */
function makeScopedBundle(
    eventId: string,
    version: number,
): CalculationBundleInput {
    const input = {
        event_id: eventId,
        version,
        resolved_input: {
            items: [
                { ordinal: 0, raw_item_text: "oatmeal 80g" },
                { ordinal: 1, raw_item_text: "banana" },
            ],
            inputs: [],
        },
        results: [
            scopedProvider("nutrition-local", "local-event", null, 500),
            scopedProvider("own", "own-event", null, 510),
            scopedProvider("nutrition-local", "local-item0", 0, 300),
            scopedProvider("own", "own-item0", 0, 306),
            scopedProvider("nutrition-local", "local-item1", 1, 200),
            scopedProvider("own", "own-item1", 1, 202),
        ],
    };
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

/** Correction of makeScopedBundle: event-scope providers move to 600 kcal. */
function makeScopedCorrection(
    eventId: string,
    version: number,
): CalculationBundleInput {
    const bundle = makeScopedBundle(eventId, version);
    for (const result of bundle.results) {
        if (result.scope.ordinal === null) {
            result.nutrients = { calories: 600 };
            result.raw_payload = {
                ...result.raw_payload,
                calories: 600,
            };
        }
    }
    bundle.fingerprint = stableBundleFingerprint({
        ...bundle,
        fingerprint: undefined,
    } as never);
    return bundle;
}

function correctionMetadata(
    key: string,
    userId: string,
): CalculationCorrectionMetadata {
    return {
        correction_idempotency_key: key,
        correction_reason: "portion corrected",
        correction_author: "hermes",
        source_timestamp: "2026-08-05T12:00:00.000Z",
        confirmed: true,
        external_write_authorized: false,
        user_id: userId,
    };
}

interface TableCounts {
    versions: string;
    results: string;
    canonical: string;
}

async function eventTableCounts(
    pool: Pool,
    eventId: string,
): Promise<TableCounts> {
    const [versions, results, canonical] = await Promise.all([
        pool.query(
            "SELECT count(*) FROM meal_event_versions WHERE event_id = $1",
            [eventId],
        ),
        pool.query(
            "SELECT count(*) FROM meal_event_nutrition_results WHERE event_id = $1",
            [eventId],
        ),
        pool.query(
            "SELECT count(*) FROM meal_event_canonical_results WHERE event_id = $1",
            [eventId],
        ),
    ]);
    return {
        versions: versions.rows[0].count,
        results: results.rows[0].count,
        canonical: canonical.rows[0].count,
    };
}

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
    ) => Promise<void>,
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-s2-acceptance", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, "u1", false, null, { mealEventsPool: pool });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({
        name: "s2-acceptance-client",
        version: "0.0.0",
    });
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

describeDb("calculation concurrency and correction acceptance matrix", () => {
    let pool: Pool;

    beforeAll(async () => {
        // max >= 2 so the concurrency cases genuinely hold two clients.
        pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 4 });
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            for (const path of migrationPaths) {
                await client.query(await Bun.file(path).text());
            }
        } finally {
            client.release();
        }
    });

    afterAll(async () => {
        await pool.end();
    });

    // Drain fire-and-forget analytics writes from the MCP cases before the
    // pool closes, so no write lands on a torn-down schema.
    afterEach(async () => {
        await flushAnalytics();
    });

    test("concurrent identical calculation bundles converge", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.concurrentBundles, "s2-user");
        } finally {
            client.release();
        }
        const bundle = makeScopedBundle(EVENT.concurrentBundles, 1);

        // Genuine concurrency: both commits are launched synchronously and
        // race on two pool clients; FOR UPDATE ordering on the version row
        // serializes them deterministically.
        const [first, second] = await Promise.all([
            commitCalculationBundle(pool, bundle),
            commitCalculationBundle(pool, bundle),
        ]);

        // One winner persists; the loser converges by deduplicating. A loser
        // that failed or left partial rows would be a real defect.
        expect(first.event_id).toBe(EVENT.concurrentBundles);
        expect(second.event_id).toBe(EVENT.concurrentBundles);
        expect(
            [first.deduplicated, second.deduplicated].sort((a, b) =>
                a === b ? 0 : a ? 1 : -1,
            ),
        ).toEqual([false, true]);
        expect(first.fingerprint).toBe(bundle.fingerprint);
        expect(second.fingerprint).toBe(bundle.fingerprint);

        const version = await pool.query(
            `SELECT calculation_bundle_fingerprint FROM meal_event_versions
              WHERE event_id = $1 AND version = 1`,
            [EVENT.concurrentBundles],
        );
        expect(version.rows[0].calculation_bundle_fingerprint).toBe(
            bundle.fingerprint,
        );

        // Exactly one provider row per provider+scope.
        const providers = await pool.query(
            `SELECT provider, scope_key, count(*)::int AS n
               FROM meal_event_nutrition_results
              WHERE event_id = $1
              GROUP BY provider, scope_key ORDER BY provider, scope_key`,
            [EVENT.concurrentBundles],
        );
        expect(providers.rows).toEqual([
            { provider: "nutrition-local", scope_key: "event", n: 1 },
            { provider: "nutrition-local", scope_key: "item:0", n: 1 },
            { provider: "nutrition-local", scope_key: "item:1", n: 1 },
            { provider: "own", scope_key: "event", n: 1 },
            { provider: "own", scope_key: "item:0", n: 1 },
            { provider: "own", scope_key: "item:1", n: 1 },
        ]);

        // Exactly one canonical row per scope.
        const canonical = await pool.query(
            `SELECT scope_key, count(*)::int AS n
               FROM meal_event_canonical_results
              WHERE event_id = $1
              GROUP BY scope_key ORDER BY scope_key`,
            [EVENT.concurrentBundles],
        );
        expect(canonical.rows).toEqual([
            { scope_key: "event", n: 1 },
            { scope_key: "item:0", n: 1 },
            { scope_key: "item:1", n: 1 },
        ]);
    });

    test("concurrent identical corrections yield one new version", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.concurrentCorrections, "s2-user");
        } finally {
            client.release();
        }
        await commitCalculationBundle(
            pool,
            makeScopedBundle(EVENT.concurrentCorrections, 1),
        );
        const correction = makeScopedCorrection(EVENT.concurrentCorrections, 2);
        const metadata = correctionMetadata(
            "s2-concurrent-correction",
            "s2-user",
        );

        const [first, second] = await Promise.all([
            commitCalculationCorrection(pool, correction, metadata),
            commitCalculationCorrection(pool, correction, metadata),
        ]);

        expect(first.version).toBe(2);
        expect(second.version).toBe(2);
        expect(
            [first.deduplicated, second.deduplicated].sort((a, b) =>
                a === b ? 0 : a ? 1 : -1,
            ),
        ).toEqual([false, true]);

        // Exactly versions 1 and 2 exist — no N+2, no orphans.
        const versions = await pool.query(
            `SELECT version FROM meal_event_versions
              WHERE event_id = $1 ORDER BY version`,
            [EVENT.concurrentCorrections],
        );
        expect(versions.rows.map((r) => r.version)).toEqual([1, 2]);
        const perVersion = await pool.query(
            `SELECT version, count(*)::int AS n
               FROM meal_event_nutrition_results
              WHERE event_id = $1 GROUP BY version ORDER BY version`,
            [EVENT.concurrentCorrections],
        );
        expect(perVersion.rows).toEqual([
            { version: 1, n: 6 },
            { version: 2, n: 6 },
        ]);
        const canonicalPerVersion = await pool.query(
            `SELECT version, count(*)::int AS n
               FROM meal_event_canonical_results
              WHERE event_id = $1 GROUP BY version ORDER BY version`,
            [EVENT.concurrentCorrections],
        );
        expect(canonicalPerVersion.rows).toEqual([
            { version: 1, n: 3 },
            { version: 2, n: 3 },
        ]);
    });

    test("migration 005 reruns safely", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.migrationRerun, "s2-user");
        } finally {
            client.release();
        }
        // Populate correction-era columns and the partial unique index so the
        // rerun is exercised against real data, not an empty schema.
        await commitCalculationBundle(
            pool,
            makeScopedBundle(EVENT.migrationRerun, 1),
        );
        await commitCalculationCorrection(
            pool,
            makeScopedCorrection(EVENT.migrationRerun, 2),
            correctionMetadata("s2-migration-rerun", "s2-user"),
        );

        const tables = [
            "meal_events",
            "meal_event_versions",
            "meal_event_nutrition_results",
            "meal_event_canonical_results",
        ];
        const countOf = async () => {
            const out: Record<string, string> = {};
            for (const table of tables) {
                out[table] = (
                    await pool.query(`SELECT count(*) FROM ${table}`)
                ).rows[0].count;
            }
            return out;
        };
        const before = await countOf();

        // Re-apply the real migration file on the populated database.
        const client2 = await pool.connect();
        try {
            await client2.query(
                await Bun.file(
                    "db/migrations/005_calculation_corrections.sql",
                ).text(),
            );
        } finally {
            client2.release();
        }

        expect(await countOf()).toEqual(before);

        // Correction data survives the rerun byte-for-byte.
        const correctionRow = await pool.query(
            `SELECT prior_version, correction_reason, correction_author,
                    confirmation_received, calculation_bundle_fingerprint
               FROM meal_event_versions
              WHERE event_id = $1 AND version = 2`,
            [EVENT.migrationRerun],
        );
        expect(correctionRow.rows[0]).toMatchObject({
            prior_version: 1,
            correction_reason: "portion corrected",
            correction_author: "hermes",
            confirmation_received: true,
        });

        // The constraint and partial unique index are still present.
        const constraint = await pool.query(
            "SELECT conname FROM pg_constraint WHERE conname = 'meal_event_versions_prior_fk'",
        );
        expect(constraint.rows).toHaveLength(1);
        const index = await pool.query(
            "SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_correction_bundle_fingerprint'",
        );
        expect(index.rows).toHaveLength(1);
    });

    test("correction rollback leaves prior state intact", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.correctionRollback, "s2-user");
        } finally {
            client.release();
        }
        await commitCalculationBundle(
            pool,
            makeScopedBundle(EVENT.correctionRollback, 1),
        );

        // Inject a deterministic failure AFTER the new version/provider/
        // canonical rows are written: the UPDATE of meal_events is the last
        // mutation before the readback, so a trigger on it aborts a fully
        // populated correction transaction.
        const setup = await pool.connect();
        try {
            await setup.query(
                `CREATE OR REPLACE FUNCTION s2_injected_correction_failure()
                 RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN
                     RAISE EXCEPTION 'injected correction rollback failure';
                 END $$`,
            );
            await setup.query(
                `CREATE TRIGGER s2_injected_correction_failure
                 BEFORE UPDATE ON meal_events
                 FOR EACH ROW EXECUTE FUNCTION s2_injected_correction_failure()`,
            );
        } finally {
            setup.release();
        }

        try {
            await expect(
                commitCalculationCorrection(
                    pool,
                    makeScopedCorrection(EVENT.correctionRollback, 2),
                    correctionMetadata("s2-rollback", "s2-user"),
                ),
            ).rejects.toThrow("injected correction rollback failure");
        } finally {
            const teardown = await pool.connect();
            try {
                await teardown.query(
                    "DROP TRIGGER s2_injected_correction_failure ON meal_events",
                );
                await teardown.query(
                    "DROP FUNCTION s2_injected_correction_failure()",
                );
            } finally {
                teardown.release();
            }
        }

        const event = await pool.query(
            "SELECT current_version FROM meal_events WHERE id = $1",
            [EVENT.correctionRollback],
        );
        expect(event.rows[0].current_version).toBe(1);
        // Zero rows for the aborted version anywhere.
        for (const table of [
            "meal_event_versions",
            "meal_event_nutrition_results",
            "meal_event_canonical_results",
        ]) {
            expect(
                (
                    await pool.query(
                        `SELECT count(*) FROM ${table} WHERE event_id = $1 AND version = 2`,
                        [EVENT.correctionRollback],
                    )
                ).rows[0].count,
            ).toBe("0");
        }
        // Prior version rows are untouched.
        expect(await eventTableCounts(pool, EVENT.correctionRollback)).toEqual({
            versions: "1",
            results: "6",
            canonical: "3",
        });
    });

    test("stale-version correction with fresh idempotency key is rejected", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.staleVersion, "s2-user");
        } finally {
            client.release();
        }
        await commitCalculationBundle(
            pool,
            makeScopedBundle(EVENT.staleVersion, 1),
        );
        await commitCalculationCorrection(
            pool,
            makeScopedCorrection(EVENT.staleVersion, 2),
            correctionMetadata("s2-stale-first", "s2-user"),
        );
        const before = await eventTableCounts(pool, EVENT.staleVersion);

        // Current version is 2; a correction must target 3. A fresh
        // idempotency key must not smuggle a stale version 2 write past the
        // append-only guard.
        const stale = makeScopedCorrection(EVENT.staleVersion, 2);
        await expect(
            commitCalculationCorrection(
                pool,
                stale,
                correctionMetadata("s2-stale-fresh-key", "s2-user"),
            ),
        ).rejects.toThrow("correction must append the current version");
        await expect(
            commitCalculationCorrection(
                pool,
                stale,
                correctionMetadata("s2-stale-fresh-key-2", "s2-user"),
            ),
        ).rejects.toBeInstanceOf(CalculationBundleValidationError);

        expect(await eventTableCounts(pool, EVENT.staleVersion)).toEqual(
            before,
        );
        const event = await pool.query(
            "SELECT current_version FROM meal_events WHERE id = $1",
            [EVENT.staleVersion],
        );
        expect(event.rows[0].current_version).toBe(2);
    });

    test("direct cross-user correction is rejected", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.crossUser, "owner-user");
        } finally {
            client.release();
        }
        await commitCalculationBundle(
            pool,
            makeScopedBundle(EVENT.crossUser, 1),
        );
        const before = await eventTableCounts(pool, EVENT.crossUser);

        await expect(
            commitCalculationCorrection(
                pool,
                makeScopedCorrection(EVENT.crossUser, 2),
                correctionMetadata("s2-cross-user", "intruder-user"),
            ),
        ).rejects.toThrow("event is not owned by user");

        expect(await eventTableCounts(pool, EVENT.crossUser)).toEqual(before);
        const event = await pool.query(
            "SELECT current_version FROM meal_events WHERE id = $1",
            [EVENT.crossUser],
        );
        expect(event.rows[0].current_version).toBe(1);
    });

    test("MCP correction round-trip", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.mcpCorrection, "u1");
        } finally {
            client.release();
        }
        await withTools(pool, async (call) => {
            const committed = await call("commit_calculation_bundle", {
                bundle: makeScopedBundle(EVENT.mcpCorrection, 1),
            });
            expect(committed.isError).not.toBe(true);

            const corrected = await call("commit_calculation_correction", {
                bundle: makeScopedCorrection(EVENT.mcpCorrection, 2),
                correction_idempotency_key: "s2-mcp-correction",
                correction_reason: "portion corrected",
                correction_author: "hermes",
                source_timestamp: "2026-08-05T12:00:00.000Z",
                confirmed: true,
            });
            expect(corrected.isError).not.toBe(true);

            // The structured output parses with the real correction schema.
            const output = CALCULATION_CORRECTION_OUTPUT_SCHEMA.parse(
                corrected.structuredContent,
            );
            expect(output.event_id).toBe(EVENT.mcpCorrection);
            expect(output.version).toBe(2);
            expect(output.deduplicated).toBe(false);
            expect(output.canonical?.nutrients.calories).toBe(600);
            expect(output.item_canonicals.map((c) => c.ordinal)).toEqual([
                0, 1,
            ]);
            expect(output.external_sync).toBe("not_authorized");
        });

        // SQL cross-check in the same test: the database shows version N+1.
        const event = await pool.query(
            "SELECT current_version FROM meal_events WHERE id = $1",
            [EVENT.mcpCorrection],
        );
        expect(event.rows[0].current_version).toBe(2);
        const canonical = await pool.query(
            `SELECT scope_key, calories FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = 2 ORDER BY scope_key`,
            [EVENT.mcpCorrection],
        );
        expect(canonical.rows.map((r) => r.scope_key)).toEqual([
            "event",
            "item:0",
            "item:1",
        ]);
        expect(Number(canonical.rows[0].calories)).toBe(600);
    });

    test("failed provider is readable through public provenance", async () => {
        const client = await pool.connect();
        try {
            await seedEvent(client, EVENT.failedProvider, "u1");
        } finally {
            client.release();
        }
        const bundle = makeScopedBundle(EVENT.failedProvider, 1);
        bundle.results = bundle.results.map((result) =>
            result.provider === "own" && result.scope.ordinal === null
                ? {
                      ...result,
                      status: "failed" as const,
                      nutrients: {},
                      raw_payload: {
                          provider: "own",
                          error: "upstream timeout",
                      },
                      error_code: "provider_timeout",
                      error_message: "timed out after 30s",
                  }
                : result,
        );
        bundle.fingerprint = stableBundleFingerprint({
            ...bundle,
            fingerprint: undefined,
        } as never);
        await commitCalculationBundle(pool, bundle);

        await withTools(pool, async (call) => {
            const provenance = await call("get_calculation_provenance", {
                event_id: EVENT.failedProvider,
            });
            expect(provenance.isError).not.toBe(true);
            const output = CALCULATION_PROVENANCE_OUTPUT_SCHEMA.parse(
                provenance.structuredContent,
            );
            const failed = output.providers.find(
                (p) => p.provider === "own" && p.ordinal === null,
            );
            expect(failed).toBeDefined();
            // error_code / error_message come back verbatim.
            expect(failed!.status).toBe("failed");
            expect(failed!.error_code).toBe("provider_timeout");
            expect(failed!.error_message).toBe("timed out after 30s");
            expect(failed!.raw_payload).toEqual({
                provider: "own",
                error: "upstream timeout",
            });
            // Nutrients are NULL, never fabricated zeros.
            for (const value of Object.values(failed!.nutrients)) {
                expect(value).toBeNull();
            }
            // The event canonical is computed from the succeeded provider
            // alone and stays readable.
            expect(output.canonical?.nutrients.calories).toBe(500);
        });
    });
});
