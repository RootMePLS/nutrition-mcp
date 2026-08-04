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
                provenance: {
                    source_id: "mfp-source",
                    capture_id: "capture-1",
                },
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
                provenance: {
                    source_id: "local-source",
                    capture_id: "capture-1",
                },
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
                provenance: {
                    source_id: "own-source",
                    capture_id: "capture-1",
                },
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
});

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
