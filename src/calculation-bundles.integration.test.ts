import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
    CalculationBundleValidationError,
    commitCalculationBundle,
    commitCalculationCorrection,
    type CalculationCorrectionMetadata,
} from "./calculation-bundles.js";
import {
    stableBundleFingerprint,
    type CalculationBundleInput,
} from "./nutrition-bundle-types.js";

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
        "src/calculation-bundles.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
    );
}

describeDb("calculation bundle PostgreSQL integration", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 1 });
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            for (const path of migrationPaths)
                await client.query(await Bun.file(path).text());
            await client.query(
                `INSERT INTO meal_events (id, user_id, reported_at, consumed_at, idempotency_key)
                 VALUES ($1, 'integration-test', now(), now(), $2)`,
                ["00000000-0000-4000-8000-000000000001", "bundle-event"],
            );
            await client.query(
                `INSERT INTO meal_event_versions (event_id, version, parser_policy_version, created_by)
                 VALUES ($1, 1, 'integration-test', 'integration-test')`,
                ["00000000-0000-4000-8000-000000000001"],
            );
        } finally {
            client.release();
        }
    });

    test("persists every provider field and recomputes canonical values", async () => {
        const bundle = makeBundle();
        const result = await commitCalculationBundle(pool, bundle);
        expect(result.canonical.nutrients.calories).toBe(505);
        expect(result.canonical.nutrients.calories).not.toBe(9999);

        const rows = await pool.query(
            `SELECT provider, source_id, raw_payload, provenance, status, error_code,
                    error_message, basis, units, request_fingerprint, algorithm_version
               FROM meal_event_nutrition_results
              WHERE event_id = $1 AND version = $2 ORDER BY provider`,
            [bundle.event_id, bundle.version],
        );
        expect(rows.rows).toHaveLength(3);
        expect(rows.rows).toEqual([
            expect.objectContaining({
                provider: "myfitnesspal",
                source_id: "mfp-source",
                raw_payload: {
                    provider: "myfitnesspal",
                    reason: "not configured",
                },
                provenance: { compatibility: true },
                status: "unavailable",
                error_code: "provider_unavailable",
                error_message: "not configured",
                basis: "per_meal",
                units: "g_and_kcal",
                request_fingerprint: "myfitnesspal-request",
                algorithm_version: "v1",
            }),
            expect.objectContaining({
                provider: "nutrition-local",
                source_id: "local-source",
                raw_payload: { provider: "nutrition-local", calories: 500 },
                provenance: { compatibility: true },
                status: "succeeded",
                error_code: null,
                error_message: null,
                basis: "per_meal",
                units: "g_and_kcal",
                request_fingerprint: "nutrition-local-request",
                algorithm_version: "v1",
            }),
            expect.objectContaining({
                provider: "own",
                source_id: "own-source",
                raw_payload: { provider: "own", calories: 510 },
                provenance: { compatibility: true },
                status: "succeeded",
                error_code: null,
                error_message: null,
                basis: "per_meal",
                units: "g_and_kcal",
                request_fingerprint: "own-request",
                algorithm_version: "v1",
            }),
        ]);

        const version = await pool.query(
            "SELECT calculation_bundle_fingerprint FROM meal_event_versions WHERE event_id = $1 AND version = $2",
            [bundle.event_id, bundle.version],
        );
        expect(version.rows[0].calculation_bundle_fingerprint).toBe(
            bundle.fingerprint,
        );
    });

    test("same event, version, and fingerprint is idempotent", async () => {
        const bundle = makeBundle();
        const first = await commitCalculationBundle(pool, bundle);
        const second = await commitCalculationBundle(pool, bundle);
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.canonical.nutrients.calories).toBe(505);
        expect(
            (
                await pool.query(
                    "SELECT count(*) FROM meal_event_nutrition_results",
                )
            ).rows[0].count,
        ).toBe("3");
        expect(
            (
                await pool.query(
                    "SELECT count(*) FROM meal_event_canonical_results",
                )
            ).rows[0].count,
        ).toBe("1");
    });

    test("rejects tampered or conflicting content without mutation", async () => {
        const bundle = makeBundle();
        await commitCalculationBundle(pool, bundle);

        const tampered = structuredClone(bundle);
        tampered.results[0]!.source_id = "forged-source";
        tampered.fingerprint = stableBundleFingerprint(tampered);
        await expect(
            commitCalculationBundle(pool, tampered),
        ).rejects.toBeInstanceOf(CalculationBundleValidationError);
        expect(
            (
                await pool.query(
                    "SELECT count(*) FROM meal_event_nutrition_results",
                )
            ).rows[0].count,
        ).toBe("3");
        expect(
            (
                await pool.query(
                    "SELECT count(*) FROM meal_event_canonical_results",
                )
            ).rows[0].count,
        ).toBe("1");
        expect(
            (
                await pool.query(
                    "SELECT source_id FROM meal_event_nutrition_results WHERE provider = 'nutrition-local'",
                )
            ).rows[0].source_id,
        ).toBe("local-source");
    });

    test("rolls back all rows when transaction hook fails after persistence", async () => {
        const bundle = makeBundle();
        await expect(
            commitCalculationBundle(pool, bundle, {
                beforeCommit: async () => {
                    throw new Error("injected bundle transaction failure");
                },
            }),
        ).rejects.toThrow("injected bundle transaction failure");
        for (const table of [
            "meal_event_nutrition_results",
            "meal_event_canonical_results",
        ]) {
            expect(
                (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0]
                    .count,
            ).toBe("0");
        }
        expect(
            (
                await pool.query(
                    "SELECT calculation_bundle_fingerprint FROM meal_event_versions",
                )
            ).rows[0].calculation_bundle_fingerprint,
        ).toBeNull();
    });

    test("persists an immutable correction with audit and journal provenance", async () => {
        const original = makeBundle();
        await commitCalculationBundle(pool, original);
        const correction = makeBundle();
        correction.version = 2;
        correction.results[0]!.source_id = "corrected-local-source";
        correction.results[0]!.raw_payload = {
            provider: "nutrition-local",
            calories: 600,
        };
        correction.results[0]!.nutrients = { calories: 600 };
        correction.fingerprint = stableBundleFingerprint(correction);
        const metadata: CalculationCorrectionMetadata = {
            correction_idempotency_key: "correction-1",
            correction_reason: "portion corrected",
            correction_author: "hermes",
            source_timestamp: "2026-08-05T12:00:00.000Z",
            confirmed: true,
            external_write_authorized: true,
            user_id: "integration-test",
        };
        const result = await commitCalculationCorrection(
            pool,
            correction,
            metadata,
        );
        expect(result.version).toBe(2);
        expect(result.canonical.nutrients.calories).toBe(555);
        const rows = await pool.query(
            "SELECT version, prior_version, correction_reason, correction_author, confirmation_received, calculation_bundle_fingerprint FROM meal_event_versions ORDER BY version",
        );
        expect(rows.rows[0].calculation_bundle_fingerprint ?? null).toBe(
            original.fingerprint,
        );
        expect(rows.rows[1]).toMatchObject({
            version: 2,
            prior_version: 1,
            correction_reason: "portion corrected",
            correction_author: "hermes",
            confirmation_received: true,
        });
        const audit = await pool.query(
            "SELECT audit_evidence, algorithm_version FROM meal_event_canonical_results WHERE version = 2",
        );
        expect(audit.rows[0].audit_evidence).toMatchObject({
            prior_version: 1,
            correction_reason: "portion corrected",
        });
        expect(audit.rows[0].algorithm_version).toBe("consensus-10pct-v1");
        expect(
            (
                await pool.query(
                    "SELECT state FROM meal_event_sync_journal WHERE version = 2",
                )
            ).rows[0].state,
        ).toBe("pending");
        const retry = await commitCalculationCorrection(
            pool,
            correction,
            metadata,
        );
        expect(retry.deduplicated).toBe(true);
        expect(
            (await pool.query("SELECT count(*) FROM meal_event_versions"))
                .rows[0].count,
        ).toBe("2");
        expect(
            (
                await pool.query(
                    "SELECT raw_payload FROM meal_event_nutrition_results WHERE version = 1 AND provider = 'nutrition-local'",
                )
            ).rows[0].raw_payload.calories,
        ).toBe(500);
    });

    test("rejects same-key retries whose correction identity is altered", async () => {
        const original = makeBundle();
        await commitCalculationBundle(pool, original);
        const correction = makeBundle();
        correction.version = 2;
        correction.results[0]!.source_id = "corrected-local-source";
        correction.results[0]!.raw_payload = {
            provider: "nutrition-local",
            calories: 600,
        };
        correction.results[0]!.nutrients = { calories: 600 };
        correction.fingerprint = stableBundleFingerprint(correction);
        const metadata: CalculationCorrectionMetadata = {
            correction_idempotency_key: "correction-identity-1",
            correction_reason: "portion corrected",
            correction_author: "hermes",
            source_timestamp: "2026-08-05T12:00:00.000Z",
            confirmed: true,
            external_write_authorized: true,
            user_id: "integration-test",
        };
        await commitCalculationCorrection(pool, correction, metadata);
        const before = await correctionRows(pool);

        const alteredRequests: Array<{
            name: string;
            bundle: CalculationBundleInput;
            metadata: CalculationCorrectionMetadata;
        }> = [];
        const alteredBundle = structuredClone(correction);
        alteredBundle.results[0]!.raw_payload = {
            provider: "nutrition-local",
            calories: 601,
        };
        alteredBundle.results[0]!.nutrients = { calories: 601 };
        alteredBundle.fingerprint = stableBundleFingerprint(alteredBundle);
        alteredRequests.push({
            name: "bundle fingerprint/content",
            bundle: alteredBundle,
            metadata,
        });
        alteredRequests.push({
            name: "version",
            bundle: { ...correction, version: 3 },
            metadata,
        });
        for (const [name, change] of [
            ["correction reason", { correction_reason: "different reason" }],
            ["correction author", { correction_author: "different-author" }],
            [
                "source timestamp",
                { source_timestamp: "2026-08-05T13:00:00.000Z" },
            ],
            ["confirmation", { confirmed: false }],
            ["authorization", { external_write_authorized: false }],
            ["user scope", { user_id: "other-user" }],
        ] as const) {
            alteredRequests.push({
                name,
                bundle: correction,
                metadata: { ...metadata, ...change },
            });
        }

        for (const request of alteredRequests) {
            await expect(
                commitCalculationCorrection(
                    pool,
                    request.bundle,
                    request.metadata,
                ),
            ).rejects.toBeInstanceOf(CalculationBundleValidationError);
            expect(await correctionRows(pool)).toEqual(before);
        }
    });

    test("keeps an exact same correction request idempotent", async () => {
        const original = makeBundle();
        await commitCalculationBundle(pool, original);
        const correction = makeBundle();
        correction.version = 2;
        correction.results[0]!.source_id = "corrected-local-source";
        correction.results[0]!.raw_payload = {
            provider: "nutrition-local",
            calories: 600,
        };
        correction.results[0]!.nutrients = { calories: 600 };
        correction.fingerprint = stableBundleFingerprint(correction);
        const metadata: CalculationCorrectionMetadata = {
            correction_idempotency_key: "correction-identity-2",
            correction_reason: "portion corrected",
            correction_author: "hermes",
            source_timestamp: "2026-08-05T12:00:00.000Z",
            confirmed: true,
            external_write_authorized: true,
            user_id: "integration-test",
        };
        const first = await commitCalculationCorrection(
            pool,
            correction,
            metadata,
        );
        const before = await correctionRows(pool);
        const second = await commitCalculationCorrection(
            pool,
            correction,
            metadata,
        );
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(await correctionRows(pool)).toEqual(before);
    });

    // ------------------------------------------------------------------
    // S1: per-scope canonical materialization matrix
    // ------------------------------------------------------------------

    test("materializes one canonical row per scope with scope-local source IDs", async () => {
        const bundle = makeScopedBundle();
        await commitCalculationBundle(pool, bundle);

        const canonical = await pool.query(
            `SELECT scope_key, calories, status, consensus_status, source_result_ids
               FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2 ORDER BY scope_key`,
            [bundle.event_id, bundle.version],
        );
        expect(canonical.rows.map((r) => r.scope_key)).toEqual([
            "event",
            "item:0",
            "item:1",
        ]);
        // Each scope's consensus is computed from its own providers alone.
        expect(Number(canonical.rows[0].calories)).toBe(505);
        expect(Number(canonical.rows[1].calories)).toBe(303);
        expect(Number(canonical.rows[2].calories)).toBe(201);
        // Every scope references exactly its own two succeeded provider rows.
        for (const row of canonical.rows) {
            expect(row.source_result_ids).toHaveLength(2);
        }
        // SQL join proof: no source_result_id crosses a scope boundary.
        const crossScope = await pool.query(
            `SELECT c.scope_key, count(*)::int AS bad
               FROM meal_event_canonical_results c
               JOIN LATERAL unnest(c.source_result_ids) AS sid ON true
               JOIN meal_event_nutrition_results r ON r.id = sid
              WHERE c.event_id = $1 AND c.version = $2
                AND r.scope_key <> c.scope_key
              GROUP BY c.scope_key`,
            [bundle.event_id, bundle.version],
        );
        expect(crossScope.rows).toEqual([]);
        // And each referenced provider row really belongs to that scope.
        const inScope = await pool.query(
            `SELECT c.scope_key, count(*)::int AS refs
               FROM meal_event_canonical_results c
               JOIN LATERAL unnest(c.source_result_ids) AS sid ON true
               JOIN meal_event_nutrition_results r ON r.id = sid
              WHERE c.event_id = $1 AND c.version = $2
                AND r.scope_key = c.scope_key
              GROUP BY c.scope_key ORDER BY c.scope_key`,
            [bundle.event_id, bundle.version],
        );
        expect(inScope.rows).toEqual([
            { scope_key: "event", refs: 2 },
            { scope_key: "item:0", refs: 2 },
            { scope_key: "item:1", refs: 2 },
        ]);
    });

    test("isolates extreme item-scope values from the event canonical", async () => {
        const bundle = makeScopedBundle();
        // Extreme item-scoped calories must not move the event consensus.
        for (const result of bundle.results) {
            if (result.scope.ordinal === 0) {
                result.nutrients = { calories: 9000 };
                result.raw_payload = { calories: 9000 };
            }
        }
        bundle.fingerprint = stableBundleFingerprint(bundle);
        await commitCalculationBundle(pool, bundle);

        const event = await pool.query(
            `SELECT calories, consensus_status FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2 AND scope_key = 'event'`,
            [bundle.event_id, bundle.version],
        );
        // Consensus of the event-scope providers alone (500, 510).
        expect(Number(event.rows[0].calories)).toBe(505);
        expect(event.rows[0].consensus_status).toBe("all_agree");
        const item0 = await pool.query(
            `SELECT calories FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2 AND scope_key = 'item:0'`,
            [bundle.event_id, bundle.version],
        );
        expect(Number(item0.rows[0].calories)).toBe(9000);
    });

    test("marks item scopes without usable provider data as pending, siblings unaffected", async () => {
        const bundle = makeScopedBundle();
        bundle.results = bundle.results.map((result) =>
            result.scope.ordinal === 1
                ? {
                      ...result,
                      status: "failed" as const,
                      nutrients: {},
                      error_code: "provider_timeout",
                      error_message: "timed out",
                  }
                : result,
        );
        bundle.fingerprint = stableBundleFingerprint(bundle);
        await commitCalculationBundle(pool, bundle);

        const rows = await pool.query(
            `SELECT scope_key, status, consensus_status, calories, source_result_ids
               FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2 ORDER BY scope_key`,
            [bundle.event_id, bundle.version],
        );
        expect(rows.rows).toHaveLength(3);
        const byScope = Object.fromEntries(
            rows.rows.map((r) => [r.scope_key, r]),
        );
        expect(byScope["item:1"].status).toBe("pending");
        expect(byScope["item:1"].consensus_status).toBe("insufficient_data");
        expect(byScope["item:1"].calories).toBeNull();
        expect(Number(byScope["event"].calories)).toBe(505);
        expect(Number(byScope["item:0"].calories)).toBe(303);
        // Failed providers are never referenced as canonical sources.
        expect(byScope["item:1"].source_result_ids ?? []).toEqual([]);
    });

    test("retry with the same fingerprint keeps exactly one canonical row per scope", async () => {
        const bundle = makeScopedBundle();
        const first = await commitCalculationBundle(pool, bundle);
        const second = await commitCalculationBundle(pool, bundle);
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        const counts = await pool.query(
            `SELECT scope_key, count(*)::int AS n
               FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2
              GROUP BY scope_key ORDER BY scope_key`,
            [bundle.event_id, bundle.version],
        );
        expect(counts.rows).toEqual([
            { scope_key: "event", n: 1 },
            { scope_key: "item:0", n: 1 },
            { scope_key: "item:1", n: 1 },
        ]);
        expect(
            (
                await pool.query(
                    "SELECT count(*) FROM meal_event_nutrition_results",
                )
            ).rows[0].count,
        ).toBe("6");
    });

    test("correction materializes per-scope canonicals and leaves the prior version immutable", async () => {
        const original = makeScopedBundle();
        await commitCalculationBundle(pool, original);
        const priorRows = await pool.query(
            `SELECT scope_key, calories, status, consensus_status, source_result_ids
               FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = 1 ORDER BY scope_key`,
            [original.event_id],
        );
        expect(priorRows.rows).toHaveLength(3);

        const correction = makeScopedBundle();
        correction.version = 2;
        for (const result of correction.results) {
            if (
                result.scope.ordinal === null &&
                result.status === "succeeded"
            ) {
                result.nutrients = { calories: 600 };
                result.raw_payload = { calories: 600 };
            }
        }
        correction.fingerprint = stableBundleFingerprint(correction);
        const metadata: CalculationCorrectionMetadata = {
            correction_idempotency_key: "correction-scoped-1",
            correction_reason: "item portions clarified",
            correction_author: "hermes",
            source_timestamp: "2026-08-05T12:00:00.000Z",
            confirmed: true,
            external_write_authorized: false,
            user_id: "integration-test",
        };
        const result = await commitCalculationCorrection(
            pool,
            correction,
            metadata,
        );
        expect(result.version).toBe(2);
        expect(result.canonical.nutrients.calories).toBe(600);

        const corrected = await pool.query(
            `SELECT scope_key, calories FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = 2 ORDER BY scope_key`,
            [correction.event_id],
        );
        expect(corrected.rows.map((r) => r.scope_key)).toEqual([
            "event",
            "item:0",
            "item:1",
        ]);
        expect(Number(corrected.rows[0].calories)).toBe(600);
        expect(Number(corrected.rows[1].calories)).toBe(303);
        expect(Number(corrected.rows[2].calories)).toBe(201);

        // Prior-version immutability: version 1 rows are byte-identical.
        const priorAfter = await pool.query(
            `SELECT scope_key, calories, status, consensus_status, source_result_ids
               FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = 1 ORDER BY scope_key`,
            [original.event_id],
        );
        expect(priorAfter.rows).toEqual(priorRows.rows);
    });

    test("rolls back every per-scope row when the transaction hook fails", async () => {
        const bundle = makeScopedBundle();
        await expect(
            commitCalculationBundle(pool, bundle, {
                beforeCommit: async () => {
                    throw new Error("injected scoped transaction failure");
                },
            }),
        ).rejects.toThrow("injected scoped transaction failure");
        for (const table of [
            "meal_event_nutrition_results",
            "meal_event_canonical_results",
        ]) {
            expect(
                (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0]
                    .count,
            ).toBe("0");
        }
    });

    test("commit over a compatibility version replaces placeholders instead of crashing", async () => {
        const eventId = "00000000-0000-4000-8000-000000000001";
        // Simulate what update_meal's compatibility correction persists for a
        // new version: one placeholder 'own' provider row + one canonical row,
        // calculation_bundle_fingerprint left NULL (see src/meal-events.ts).
        await pool.query(
            `INSERT INTO meal_event_nutrition_results
                (event_id, version, ordinal, provider, source_id, status,
                 request_fingerprint, algorithm_version, raw_payload, provenance, calories)
             VALUES ($1, 1, NULL, 'own', 'legacy:compat', 'succeeded',
                     'legacy:compat', 'legacy-compat',
                     '{"compatibility": true}', '{"compatibility": true}', 555)`,
            [eventId],
        );
        await pool.query(
            `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status,
                 calories, policy_version, audit_evidence)
             VALUES ($1, 1, NULL, 'ready', 'insufficient_data',
                     555, 'legacy-compat', '{"compatibility": true}')`,
            [eventId],
        );

        const bundle = makeBundle();
        const result = await commitCalculationBundle(pool, bundle);
        expect(result.deduplicated).toBe(false);
        expect(result.canonical.nutrients.calories).toBe(505);

        // Placeholders are gone; exactly the bundle's 3 provider rows remain.
        const providers = await pool.query(
            `SELECT provider, source_id FROM meal_event_nutrition_results
              WHERE event_id = $1 AND version = 1 AND ordinal IS NULL
              ORDER BY provider`,
            [eventId],
        );
        expect(providers.rows).toHaveLength(3);
        expect(
            providers.rows.some((r) => r.source_id === "legacy:compat"),
        ).toBe(false);
        // Exactly one canonical row per scope (event scope here).
        const canonical = await pool.query(
            `SELECT count(*) FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = 1`,
            [eventId],
        );
        expect(canonical.rows[0].count).toBe("1");
    });
});

async function correctionRows(pool: Pool) {
    return {
        versions: (
            await pool.query(
                `SELECT event_id, version, correction_idempotency_key, correction_reason,
                        correction_author, source_timestamp, confirmation_received,
                        external_write_authorized, prior_version,
                        calculation_bundle_fingerprint
                   FROM meal_event_versions ORDER BY version`,
            )
        ).rows,
        providers: (
            await pool.query(
                `SELECT event_id, version, provider, source_id, raw_payload, calories
                   FROM meal_event_nutrition_results ORDER BY version, provider`,
            )
        ).rows,
        canonical: (
            await pool.query(
                `SELECT event_id, version, status, consensus_status, calories,
                        source_result_ids, audit_evidence, algorithm_version
                   FROM meal_event_canonical_results ORDER BY version`,
            )
        ).rows,
        event: (
            await pool.query(
                "SELECT current_version, external_write_authorized FROM meal_events",
            )
        ).rows,
    };
}

function makeBundle(): CalculationBundleInput {
    const input = {
        event_id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        capture_id: "capture-1",
        resolved_input: { items: [], inputs: [] },
        results: [
            provider("nutrition-local", "local-source", 500),
            provider("own", "own-source", 510),
            {
                provider: "myfitnesspal" as const,
                status: "unavailable" as const,
                scope: { ordinal: null },
                source_id: "mfp-source",
                request_fingerprint: "myfitnesspal-request",
                algorithm_version: "v1",
                basis: "per_meal" as const,
                units: "g_and_kcal" as const,
                nutrients: {},
                raw_payload: {
                    provider: "myfitnesspal",
                    reason: "not configured",
                },
                error_code: "provider_unavailable",
                error_message: "not configured",
            },
        ],
        canonical_proposal: { calories: 9999 },
    } satisfies Omit<CalculationBundleInput, "fingerprint">;
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

function provider(
    provider: "nutrition-local" | "own",
    source_id: string,
    calories: number,
) {
    return {
        provider,
        status: "succeeded" as const,
        scope: { ordinal: null },
        source_id,
        request_fingerprint: `${provider}-request`,
        algorithm_version: "v1",
        basis: "per_meal" as const,
        units: "g_and_kcal" as const,
        nutrients: { calories },
        raw_payload: { provider, calories },
    };
}

function scopedProvider(
    provider: "nutrition-local" | "own",
    source_id: string,
    ordinal: number | null,
    calories: number,
) {
    return {
        provider,
        status: "succeeded" as const,
        scope: { ordinal },
        source_id,
        request_fingerprint: `${provider}-request-${ordinal ?? "event"}`,
        algorithm_version: "v1",
        basis: "per_meal" as const,
        units: "g_and_kcal" as const,
        nutrients: { calories },
        raw_payload: { provider, source_id, calories },
    };
}

/** Event scope + item scopes 0 and 1, two succeeded providers per scope. */
function makeScopedBundle(): CalculationBundleInput {
    const input = {
        event_id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        capture_id: "capture-1",
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
        canonical_proposal: { calories: 9999 },
    } satisfies Omit<CalculationBundleInput, "fingerprint">;
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}
