import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool } from "pg";
import { flushAnalytics } from "./analytics.js";
import {
    CALCULATION_CORRECTION_OUTPUT_SCHEMA,
    CALCULATION_PROVENANCE_OUTPUT_SCHEMA,
    CalculationBundleValidationError,
    commitCalculationBundle,
    commitCalculationCorrection,
} from "./calculation-bundles.js";
import {
    EVENT,
    correctionMetadata,
    eventTableCounts,
    makeScopedBundle,
    makeScopedCorrection,
    seedEvent,
    withTools,
} from "./calculation-acceptance.fixtures.js";
import { stableBundleFingerprint } from "./nutrition-bundle-types.js";

// ---------------------------------------------------------------------------
// S2 acceptance matrix: concurrency, migration rerun safety, and correction
// guarantees pinned against real PostgreSQL and the real MCP transport. This
// suite is test-only acceptance evidence; it must never require production
// edits to pass. Migrate-all happens once in beforeAll (the gate resets the
// schema per suite); each case isolates itself with its own event id. Shared
// builders and the transport harness live in
// calculation-acceptance.fixtures.ts.
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
