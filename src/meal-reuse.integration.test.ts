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
import { searchMealProjections } from "./meal-event-projection.js";
import {
    deleteMealEvent,
    seedMealEvent,
    seedVariationCorpus,
} from "./meal-reuse.fixtures.js";

// ---------------------------------------------------------------------------
// Slice 3 repository gate: reusable-meal discovery reads against real
// PostgreSQL. Skipped loudly without DATABASE_URL_TEST; every test resets the
// public schema and replays the full migration chain 001-009 (current head).
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/meal-reuse.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
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
    "meal reuse discovery repository (requires DATABASE_URL_TEST)",
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

        describe("searchMealProjections uncapped (limit: null)", () => {
            test("returns the full match set beyond the default 50-row cap", async () => {
                const ids = await seedVariationCorpus(pool, "u1", {
                    keyPrefix: "uncapped",
                    itemText: "oat porridge",
                    count: 55,
                    now: NOW,
                    dayStart: 5,
                    dayEnd: 85,
                });
                const matches = await searchMealProjections(
                    pool,
                    "u1",
                    ["oat"],
                    {
                        limit: null,
                    },
                );
                expect(matches).toHaveLength(55);
                expect(new Set(matches.map((m) => m.id))).toEqual(new Set(ids));
            });

            test("limit: null still respects sinceIso, user scope, and active status", async () => {
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "recent",
                    consumedAt: daysAgo(3),
                    items: [{ ordinal: 0, raw_item_text: "oat porridge" }],
                });
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "old",
                    consumedAt: daysAgo(40),
                    items: [{ ordinal: 0, raw_item_text: "oat porridge" }],
                });
                const otherUser = await seedMealEvent(pool, "u2", {
                    idempotencyKey: "other-user",
                    consumedAt: daysAgo(2),
                    items: [{ ordinal: 0, raw_item_text: "oat porridge" }],
                });
                const deleted = await seedMealEvent(pool, "u1", {
                    idempotencyKey: "deleted",
                    consumedAt: daysAgo(1),
                    items: [{ ordinal: 0, raw_item_text: "oat porridge" }],
                });
                await deleteMealEvent(pool, "u1", deleted);

                const matches = await searchMealProjections(
                    pool,
                    "u1",
                    ["oat"],
                    {
                        limit: null,
                        sinceIso: daysAgo(10),
                    },
                );
                expect(matches).toHaveLength(1);
                expect(matches[0]!.logged_at).toBe(daysAgo(3));
                expect(matches.map((m) => m.id)).not.toContain(otherUser);
                expect(matches.map((m) => m.id)).not.toContain(deleted);
            });
        });
    },
);
