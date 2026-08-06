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
import { searchReuseCandidates } from "./meal-reuse.js";
import {
    commitBundle,
    correctMeal,
    deleteMealEvent,
    domainTableCounts,
    readyBundle,
    seedMealEvent,
    seedVariationCorpus,
    unavailableBundle,
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

        describe("searchReuseCandidates", () => {
            test("90-day window: exactly -90d included, -91d excluded", async () => {
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "b89",
                    consumedAt: daysAgo(89),
                    items: [{ ordinal: 0, raw_item_text: "boundary oats" }],
                });
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "b90",
                    consumedAt: daysAgo(90),
                    items: [{ ordinal: 0, raw_item_text: "boundary oats" }],
                });
                const excluded = await seedMealEvent(pool, "u1", {
                    idempotencyKey: "b91",
                    consumedAt: daysAgo(91),
                    items: [{ ordinal: 0, raw_item_text: "boundary oats" }],
                });

                const res = await searchReuseCandidates(pool, "u1", ["oats"], {
                    now: NOW,
                });
                expect(res.match_mode).toBe("lexical");
                expect(res.window_days).toBe(90);
                expect(res.total_matches_90d).toBe(2);
                expect(res.variations).toHaveLength(1);
                expect(res.variations[0]!.occurrences_90d).toBe(2);
                expect(JSON.stringify(res)).not.toContain(excluded);
            });

            test("ranking counts the full 90d set (no pre-grouping cap misranks 55 vs 8)", async () => {
                await seedVariationCorpus(pool, "u1", {
                    keyPrefix: "cap-a",
                    itemText: "oat porridge alpha",
                    count: 55,
                    now: NOW,
                    dayStart: 5,
                    dayEnd: 85,
                });
                await seedVariationCorpus(pool, "u1", {
                    keyPrefix: "cap-b",
                    itemText: "oat porridge beta",
                    count: 8,
                    now: NOW,
                    dayStart: 0,
                    dayEnd: 4,
                });

                const res = await searchReuseCandidates(pool, "u1", ["oat"], {
                    now: NOW,
                });
                expect(res.total_matches_90d).toBe(63);
                expect(
                    res.variations.map((v) => [
                        v.variation_key,
                        v.occurrences_90d,
                    ]),
                ).toEqual([
                    ["oat porridge alpha", 55],
                    ["oat porridge beta", 8],
                ]);
            });

            test("equal frequency tie-breaks by newest last occurrence", async () => {
                for (const [key, text, days] of [
                    ["tie-a1", "tie variation alpha", 10],
                    ["tie-a2", "tie variation alpha", 5],
                    ["tie-b1", "tie variation beta", 8],
                    ["tie-b2", "tie variation beta", 1],
                ] as const) {
                    await seedMealEvent(pool, "u1", {
                        idempotencyKey: key,
                        consumedAt: daysAgo(days),
                        items: [{ ordinal: 0, raw_item_text: text }],
                    });
                }
                const res = await searchReuseCandidates(pool, "u1", ["tie"], {
                    now: NOW,
                });
                expect(res.variations.map((v) => v.variation_key)).toEqual([
                    "tie variation beta",
                    "tie variation alpha",
                ]);
            });

            test("at most two candidates per variation, newest first", async () => {
                for (let i = 1; i <= 5; i++) {
                    await seedMealEvent(pool, "u1", {
                        idempotencyKey: `cap-${i}`,
                        consumedAt: daysAgo(i),
                        items: [{ ordinal: 0, raw_item_text: "capped oats" }],
                    });
                }
                const res = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["capped"],
                    {
                        now: NOW,
                    },
                );
                const variation = res.variations[0]!;
                expect(variation.occurrences_90d).toBe(5);
                expect(variation.candidates).toHaveLength(2);
                expect(variation.candidates[0]!.consumed_at).toBe(daysAgo(1));
                expect(variation.candidates[1]!.consumed_at).toBe(daysAgo(2));
                expect(variation.last_consumed_at).toBe(
                    variation.candidates[0]!.consumed_at,
                );
            });

            test("lexical semantics: case-insensitive, escaped literals, AND tokens, OR alternatives", async () => {
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "lex-1",
                    consumedAt: daysAgo(1),
                    items: [
                        { ordinal: 0, raw_item_text: "oat porridge with milk" },
                    ],
                });
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "lex-2",
                    consumedAt: daysAgo(2),
                    items: [
                        { ordinal: 0, raw_item_text: "oat porridge plain" },
                    ],
                });
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "lex-3",
                    consumedAt: daysAgo(3),
                    items: [
                        { ordinal: 0, raw_item_text: "50%_off\\ bar special" },
                    ],
                });
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "lex-4",
                    consumedAt: daysAgo(4),
                    items: [{ ordinal: 0, raw_item_text: "beetroot salad" }],
                });

                // Case-insensitive.
                const upper = await searchReuseCandidates(pool, "u1", ["OAT"], {
                    now: NOW,
                });
                expect(upper.total_matches_90d).toBe(2);

                // Tokens within one alternative are AND'd.
                const anded = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["oat milk"],
                    { now: NOW },
                );
                expect(anded.total_matches_90d).toBe(1);
                expect(anded.variations[0]!.variation_key).toBe(
                    "oat porridge with milk",
                );

                // LIKE metacharacters match literally after escaping.
                const escaped = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["50%_off\\"],
                    { now: NOW },
                );
                expect(escaped.total_matches_90d).toBe(1);
                const unescaped = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["500off"],
                    { now: NOW },
                );
                expect(unescaped.total_matches_90d).toBe(0);

                // Alternatives are OR'd.
                const alternatives = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["beetroot", "milk"],
                    { now: NOW },
                );
                expect(alternatives.total_matches_90d).toBe(2);
            });

            test("ready candidate echoes committed bundle consensus and provenance", async () => {
                const id = await seedMealEvent(pool, "u1", {
                    idempotencyKey: "ready-1",
                    consumedAt: daysAgo(2),
                    items: [{ ordinal: 0, raw_item_text: "ready oats" }],
                });
                await commitBundle(pool, "u1", readyBundle(id, 1));

                const res = await searchReuseCandidates(pool, "u1", ["ready"], {
                    now: NOW,
                });
                const candidate = res.variations[0]!.candidates[0]!;
                expect(candidate.source_event_id).toBe(id);
                expect(candidate.provenance_status).toBe("ready");
                expect(candidate.compatibility).toBe(false);
                expect(candidate.bundle_fingerprint).not.toBeNull();
                expect(candidate.canonical).not.toBeNull();
                expect(candidate.canonical!.status).toBe("ready");
                expect(candidate.canonical!.consensus_status).toBe("all_agree");
                expect(candidate.canonical!.calories).toBe(500);
                expect(candidate.canonical!.protein_g).toBe(20);
                expect(candidate.canonical!.carbs_g).toBe(60);
                expect(candidate.canonical!.fat_g).toBe(15);
            });

            test("pending and unavailable candidates never fabricate zero nutrients", async () => {
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "pending-1",
                    consumedAt: daysAgo(1),
                    items: [{ ordinal: 0, raw_item_text: "pending oats" }],
                });
                const unavailableId = await seedMealEvent(pool, "u1", {
                    idempotencyKey: "unavailable-1",
                    consumedAt: daysAgo(2),
                    items: [{ ordinal: 0, raw_item_text: "unavailable oats" }],
                });
                await commitBundle(
                    pool,
                    "u1",
                    unavailableBundle(unavailableId, 1),
                );

                const res = await searchReuseCandidates(pool, "u1", ["oats"], {
                    now: NOW,
                });
                const pending = res.variations.find(
                    (v) => v.variation_key === "pending oats",
                )!.candidates[0]!;
                expect(pending.provenance_status).toBe("pending");
                expect(pending.bundle_fingerprint).toBeNull();
                expect(pending.canonical).not.toBeNull();
                expect(pending.canonical!.calories).toBeNull();
                expect(pending.canonical!.calories).not.toBe(0);
                expect(pending.canonical!.protein_g).toBeNull();
                const unavailable = res.variations.find(
                    (v) => v.variation_key === "unavailable oats",
                )!.candidates[0]!;
                expect(unavailable.provenance_status).toBe("unavailable");
            });

            test("corrected events surface only current-version components", async () => {
                const id = await seedMealEvent(pool, "u1", {
                    idempotencyKey: "corr-1",
                    consumedAt: daysAgo(3),
                    items: [
                        {
                            ordinal: 0,
                            raw_item_text: "oatmeal with raisins",
                            normalized_name: "oatmeal with raisins",
                        },
                    ],
                });
                await correctMeal(pool, "u1", id, {
                    correctionKey: "corr-1-v2",
                    items: [
                        {
                            ordinal: 0,
                            raw_item_text: "oatmeal with banana",
                            normalized_name: "oatmeal with banana",
                        },
                    ],
                });

                const res = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["oatmeal"],
                    { now: NOW },
                );
                expect(res.variations).toHaveLength(1);
                expect(res.variations[0]!.variation_key).toBe(
                    "oatmeal with banana",
                );
                const candidate = res.variations[0]!.candidates[0]!;
                expect(candidate.source_version).toBe(2);
                expect(candidate.current_version).toBe(2);
                expect(candidate.is_current).toBe(true);
                expect(JSON.stringify(res)).not.toContain("raisins");
            });

            test("user isolation: no cross-user ids or item text, empty not error", async () => {
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "iso-u1",
                    consumedAt: daysAgo(1),
                    items: [{ ordinal: 0, raw_item_text: "u1 secret oats" }],
                });
                await seedMealEvent(pool, "u2", {
                    idempotencyKey: "iso-u2",
                    consumedAt: daysAgo(1),
                    items: [{ ordinal: 0, raw_item_text: "u2 hidden oats" }],
                });

                const resU1 = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["oats"],
                    {
                        now: NOW,
                    },
                );
                expect(resU1.total_matches_90d).toBe(1);
                expect(JSON.stringify(resU1)).not.toContain("u2");

                const resU2 = await searchReuseCandidates(
                    pool,
                    "u2",
                    ["secret"],
                    { now: NOW },
                );
                expect(resU2.total_matches_90d).toBe(0);
                expect(resU2.variations).toEqual([]);
            });

            test("deleted events leave counts and candidates", async () => {
                const ids: string[] = [];
                for (let i = 1; i <= 3; i++) {
                    ids.push(
                        await seedMealEvent(pool, "u1", {
                            idempotencyKey: `del-${i}`,
                            consumedAt: daysAgo(i),
                            items: [
                                { ordinal: 0, raw_item_text: "deleted oats" },
                            ],
                        }),
                    );
                }
                await deleteMealEvent(pool, "u1", ids[0]!);

                const res = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["deleted"],
                    { now: NOW },
                );
                expect(res.total_matches_90d).toBe(2);
                const variation = res.variations[0]!;
                expect(variation.occurrences_90d).toBe(2);
                expect(
                    variation.candidates.map((c) => c.source_event_id),
                ).not.toContain(ids[0]);
            });

            test("read-only: domain table counts identical across calls", async () => {
                const id = await seedMealEvent(pool, "u1", {
                    idempotencyKey: "ro-1",
                    consumedAt: daysAgo(1),
                    items: [{ ordinal: 0, raw_item_text: "readonly oats" }],
                });
                await commitBundle(pool, "u1", readyBundle(id, 1));

                const before = await domainTableCounts(pool);
                await searchReuseCandidates(pool, "u1", ["readonly"], {
                    now: NOW,
                });
                await searchReuseCandidates(pool, "u1", ["oats"], { now: NOW });
                await searchReuseCandidates(pool, "u1", ["nothing-matches"], {
                    now: NOW,
                });
                expect(await domainTableCounts(pool)).toEqual(before);
            });

            test("components are ordinal-ordered with seeded fields populated", async () => {
                await seedMealEvent(pool, "u1", {
                    idempotencyKey: "comp-1",
                    consumedAt: daysAgo(1),
                    mealType: "lunch",
                    items: [
                        {
                            ordinal: 0,
                            raw_item_text: "chicken salad bowl",
                            normalized_name: "chicken salad",
                            quantity: 250,
                            portion_value: 1,
                            portion_unit: "bowl",
                            notes: "extra dressing",
                        },
                        {
                            ordinal: 1,
                            raw_item_text: "sparkling water",
                            quantity: null,
                        },
                    ],
                });

                const res = await searchReuseCandidates(
                    pool,
                    "u1",
                    ["chicken"],
                    { now: NOW },
                );
                const candidate = res.variations[0]!.candidates[0]!;
                expect(candidate.meal_type).toBe("lunch");
                expect(candidate.components.map((c) => c.ordinal)).toEqual([
                    0, 1,
                ]);
                expect(candidate.components[0]).toEqual({
                    ordinal: 0,
                    raw_item_text: "chicken salad bowl",
                    normalized_name: "chicken salad",
                    quantity: 250,
                    portion_value: 1,
                    portion_unit: "bowl",
                    notes: "extra dressing",
                });
                expect(candidate.components[1]!.raw_item_text).toBe(
                    "sparkling water",
                );
                expect(candidate.components[1]!.notes).toBeNull();
            });
        });
    },
);

// ---------------------------------------------------------------------------
// Slice 4 repository gate: the confirmed reuse mutation against real
// PostgreSQL. Same reset/replay harness as the Slice 3 suite above.
// ---------------------------------------------------------------------------

import { deriveReuseIdempotencyFingerprint } from "./meal-types.js";
import { getMealEventProvenance } from "./meal-events.js";
import { getReuseLineage, reuseMealCalculation } from "./meal-reuse.js";
import { reuseCommand, snapshotAggregate } from "./meal-reuse.fixtures.js";

/** Columns that identity-remap in a copy: every other column is byte-equal. */
function stripIdentity(
    row: Record<string, unknown>,
    extra: string[] = [],
): Record<string, unknown> {
    const { id, event_id, version, scope_key, ...rest } = row;
    for (const key of extra) delete rest[key];
    return rest;
}

describeDb(
    "reuse_meal_calculation repository (requires DATABASE_URL_TEST)",
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

        test("creates a fresh root/version 1 with the supplied fresh timestamps and derived occurrence idempotency key", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "fresh-src",
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: "reuse oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));
            const command = reuseCommand({ source_event_id: sourceId });

            const result = await reuseMealCalculation(pool, command);

            expect(result.event_id).not.toBe(sourceId);
            expect(result.version).toBe(1);
            expect(result.deduplicated).toBe(false);
            expect(result.source_event_id).toBe(sourceId);
            expect(result.source_version).toBe(1);
            const { rows } = await pool.query(
                `SELECT * FROM meal_events WHERE id = $1`,
                [result.event_id],
            );
            const root = rows[0]!;
            expect(root.user_id).toBe("u1");
            expect((root.reported_at as Date).toISOString()).toBe(
                command.reported_at,
            );
            expect((root.consumed_at as Date).toISOString()).toBe(
                command.consumed_at,
            );
            expect(root.meal_type).toBe("breakfast");
            expect(root.status).toBe("active");
            expect(root.current_version).toBe(1);
            expect(root.external_write_authorized).toBe(false);
            const expectedKey = deriveReuseIdempotencyFingerprint({
                user_id: "u1",
                reuse_idempotency_key: command.idempotency_key,
                source_event_id: sourceId,
                source_version: 1,
                reported_at: command.reported_at,
                consumed_at: command.consumed_at,
            });
            expect(root.idempotency_key).toBe(expectedKey);
            expect(root.idempotency_key.startsWith("reuse:")).toBe(true);
            expect(root.idempotency_key).not.toBe("fresh-src");
            // No raw occurrence evidence is copied: the lineage row is the
            // target's evidence of origin.
            const inputs = await pool.query(
                `SELECT count(*)::int AS c FROM meal_event_inputs WHERE event_id = $1`,
                [result.event_id],
            );
            expect(inputs.rows[0]!.c).toBe(0);
            const journal = await pool.query(
                `SELECT count(*)::int AS c FROM meal_event_sync_journal WHERE event_id = $1`,
                [result.event_id],
            );
            expect(journal.rows[0]!.c).toBe(0);
        });

        test("copies items, all provider rows, and all canonical rows column-for-column with remapped source_result_ids", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "copy-src",
                consumedAt: daysAgo(3),
                mealType: "lunch",
                items: [
                    {
                        ordinal: 0,
                        raw_item_text: "copy chicken bowl",
                        normalized_name: "chicken bowl",
                        quantity: 250,
                        portion_value: 1,
                        portion_unit: "bowl",
                        notes: "extra sauce",
                    },
                    { ordinal: 1, raw_item_text: "copy water", quantity: null },
                ],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));
            const source = await snapshotAggregate(pool, sourceId, 1);

            const result = await reuseMealCalculation(
                pool,
                reuseCommand({ source_event_id: sourceId }),
            );
            const target = await snapshotAggregate(pool, result.event_id, 1);

            // Items: identical content, same ordinals.
            expect(target.items.map((r) => stripIdentity(r))).toEqual(
                source.items.map((r) => stripIdentity(r)),
            );
            // Provider evidence: every column byte-equal except identity.
            expect(target.provider_results).toHaveLength(
                source.provider_results.length,
            );
            expect(
                target.provider_results.map((r) => stripIdentity(r)),
            ).toEqual(source.provider_results.map((r) => stripIdentity(r)));
            // Canonical facts: byte-equal except identity and the remapped
            // source_result_ids.
            expect(target.canonical_results).toHaveLength(
                source.canonical_results.length,
            );
            expect(
                target.canonical_results.map((r) =>
                    stripIdentity(r, ["source_result_ids"]),
                ),
            ).toEqual(
                source.canonical_results.map((r) =>
                    stripIdentity(r, ["source_result_ids"]),
                ),
            );
            // Remap: source canonical ids -> target canonical ids through the
            // persisted provider mapping, order preserved.
            const targetProviderIds = new Set(
                target.provider_results.map((r) => r.id as string),
            );
            const sourceCanonical = source.canonical_results.find(
                (r) => r.ordinal === null,
            )!;
            const targetCanonical = target.canonical_results.find(
                (r) => r.ordinal === null,
            )!;
            expect(targetCanonical.source_result_ids).toHaveLength(3);
            for (const id of targetCanonical.source_result_ids as string[]) {
                expect(targetProviderIds.has(id)).toBe(true);
            }
            // Each remapped id corresponds to the true source id in order.
            const mappings = await pool.query(
                `SELECT target_provider_result_id, source_provider_result_id
                 FROM meal_event_reuse_provider_sources
                 WHERE event_id = $1 AND version = 1`,
                [result.event_id],
            );
            const toSource = new Map(
                mappings.rows.map((m) => [
                    m.target_provider_result_id as string,
                    m.source_provider_result_id as string,
                ]),
            );
            expect(
                (targetCanonical.source_result_ids as string[]).map((id) =>
                    toSource.get(id),
                ),
            ).toEqual(sourceCanonical.source_result_ids as string[]);
        });

        test("persists lineage + three provider mappings with exact source identity and bundle fingerprint", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "lineage-src",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "lineage oats" }],
            });
            const bundle = readyBundle(sourceId, 1);
            await commitBundle(pool, "u1", bundle);
            const command = reuseCommand({ source_event_id: sourceId });

            const result = await reuseMealCalculation(pool, command);
            const lineage = await getReuseLineage(pool, "u1", result.event_id);

            expect(lineage).not.toBeNull();
            expect(lineage!.source_event_id).toBe(sourceId);
            expect(lineage!.source_version).toBe(1);
            expect(lineage!.source_bundle_fingerprint).toBe(
                bundle.fingerprint!,
            );
            expect(lineage!.reuse_idempotency_key).toBe(
                command.idempotency_key,
            );
            expect(lineage!.confirmation_received).toBe(true);
            const sourceCanonical = await pool.query(
                `SELECT id FROM meal_event_canonical_results
                 WHERE event_id = $1 AND version = 1 AND ordinal IS NULL`,
                [sourceId],
            );
            expect(lineage!.source_canonical_result_id).toBe(
                sourceCanonical.rows[0]!.id,
            );
            expect(typeof lineage!.copied_at).toBe("string");
            expect(lineage!.provider_mappings).toHaveLength(3);
            const sourceProviders = await pool.query(
                `SELECT id, request_fingerprint FROM meal_event_nutrition_results
                 WHERE event_id = $1 AND version = 1`,
                [sourceId],
            );
            const sourceById = new Map(
                sourceProviders.rows.map((r) => [
                    r.id as string,
                    r.request_fingerprint as string,
                ]),
            );
            const targetProviders = await pool.query(
                `SELECT id, request_fingerprint FROM meal_event_nutrition_results
                 WHERE event_id = $1 AND version = 1`,
                [result.event_id],
            );
            const targetIds = new Set(
                targetProviders.rows.map((r) => r.id as string),
            );
            for (const mapping of lineage!.provider_mappings) {
                expect(targetIds.has(mapping.target_provider_result_id)).toBe(
                    true,
                );
                expect(sourceById.get(mapping.source_provider_result_id)).toBe(
                    mapping.source_request_fingerprint,
                );
            }
        });

        test("target re-derives ready/non-compatibility through getMealEventProvenance", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "prov-src",
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: "provenance oats" }],
            });
            const bundle = readyBundle(sourceId, 1);
            await commitBundle(pool, "u1", bundle);

            const result = await reuseMealCalculation(
                pool,
                reuseCommand({ source_event_id: sourceId }),
            );
            const readback = await getMealEventProvenance(
                pool,
                "u1",
                result.event_id,
            );

            expect(readback).not.toBeNull();
            expect(readback!.provenance_status).toBe("ready");
            expect(readback!.compatibility).toBe(false);
            expect(readback!.is_current).toBe(true);
            expect(
                readback!.aggregate.version.calculation_bundle_fingerprint,
            ).toBe(bundle.fingerprint!);
            expect(readback!.aggregate.canonical!.calories).toBe(500);
            expect(readback!.aggregate.canonical!.protein_g).toBe(20);
            expect(readback!.aggregate.canonical!.carbs_g).toBe(60);
            expect(readback!.aggregate.canonical!.fat_g).toBe(15);
            expect(result.provenance_status).toBe("ready");
            expect(result.compatibility).toBe(false);
            expect(result.source_bundle_fingerprint).toBe(bundle.fingerprint!);
        });

        test("source aggregate is byte-identical before and after reuse", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "immutable-src",
                consumedAt: daysAgo(4),
                items: [{ ordinal: 0, raw_item_text: "immutable oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));
            const before = await snapshotAggregate(pool, sourceId, 1);

            await reuseMealCalculation(
                pool,
                reuseCommand({ source_event_id: sourceId }),
            );

            expect(await snapshotAggregate(pool, sourceId, 1)).toEqual(before);
        });

        test("reuses the requested historical version after a correction (source_was_current=false)", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "hist-src",
                consumedAt: daysAgo(5),
                items: [{ ordinal: 0, raw_item_text: "historical v1 oats" }],
            });
            const bundle = readyBundle(sourceId, 1);
            await commitBundle(pool, "u1", bundle);
            await correctMeal(pool, "u1", sourceId, {
                correctionKey: "hist-src-v2",
                items: [{ ordinal: 0, raw_item_text: "corrected v2 oats" }],
            });
            const sourceV1 = await snapshotAggregate(pool, sourceId, 1);

            const result = await reuseMealCalculation(
                pool,
                reuseCommand({ source_event_id: sourceId, source_version: 1 }),
            );

            expect(result.source_was_current).toBe(false);
            const target = await snapshotAggregate(pool, result.event_id, 1);
            expect(target.items.map((r) => stripIdentity(r))).toEqual(
                sourceV1.items.map((r) => stripIdentity(r)),
            );
            expect(
                target.canonical_results.map((r) =>
                    stripIdentity(r, ["source_result_ids"]),
                ),
            ).toEqual(
                sourceV1.canonical_results.map((r) =>
                    stripIdentity(r, ["source_result_ids"]),
                ),
            );
            // The v2 correction text never leaks into the v1 copy.
            expect(JSON.stringify(target.items)).not.toContain("corrected");
        });

        test("reuse of the current version sets source_was_current true", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "cur-src",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "current oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));

            const result = await reuseMealCalculation(
                pool,
                reuseCommand({ source_event_id: sourceId, source_version: 1 }),
            );

            expect(result.source_was_current).toBe(true);
        });

        test("getReuseLineage returns the link user-scoped; null for another user", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "scope-src",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "scoped oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));

            const result = await reuseMealCalculation(
                pool,
                reuseCommand({ source_event_id: sourceId }),
            );

            expect(
                await getReuseLineage(pool, "u1", result.event_id),
            ).not.toBeNull();
            expect(
                await getReuseLineage(pool, "u2", result.event_id),
            ).toBeNull();
            expect(await getReuseLineage(pool, "u1", sourceId)).toBeNull();
        });
    },
);

// ---------------------------------------------------------------------------
// Slice 4 fail-closed eligibility: every rejection class carries a stable
// typed error, writes nothing, and never fabricates a zero-valued canonical.
// ---------------------------------------------------------------------------

import {
    MealReuseIdempotencyConflictError,
    MealReuseSourceIneligibleError,
    MealReuseSourceNotFoundError,
    MealReuseSourceVersionError,
} from "./meal-reuse.js";
import { MealEventValidationError } from "./meal-events.js";

/** No rejection path may leave a fabricated zero nutrient anywhere. */
async function expectNoZeroCanonical(pool: Pool): Promise<void> {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS c FROM meal_event_canonical_results
         WHERE calories = 0 OR protein_g = 0 OR carbs_g = 0 OR fat_g = 0`,
    );
    expect(rows[0]!.c).toBe(0);
}

async function catchReuseError(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (err) {
        return err as Error;
    }
    throw new Error("expected reuseMealCalculation to reject, but it resolved");
}

describeDb(
    "reuse_meal_calculation fail-closed eligibility (requires DATABASE_URL_TEST)",
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

        async function seedReadySource(
            userId: string,
            key: string,
            itemText: string,
        ): Promise<string> {
            const id = await seedMealEvent(pool, userId, {
                idempotencyKey: key,
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: itemText }],
            });
            await commitBundle(pool, userId, readyBundle(id, 1));
            return id;
        }

        test("absent source id -> meal_reuse_source_not_found, zero writes", async () => {
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        source_event_id: "99999999-9999-9999-9999-999999999999",
                    }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseSourceNotFoundError);
            expect((err as MealReuseSourceNotFoundError).code).toBe(
                "meal_reuse_source_not_found",
            );
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("cross-user source -> identical not_found; error leaks no source text or ids", async () => {
            const sourceId = await seedReadySource(
                "u1",
                "xu-src",
                "u1 private porridge",
            );
            const before = await domainTableCounts(pool);
            const crossUser = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        user_id: "u2",
                        source_event_id: sourceId,
                    }),
                ),
            );
            const absent = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        user_id: "u2",
                        source_event_id: "99999999-9999-9999-9999-999999999999",
                        idempotency_key: "xu-absent",
                    }),
                ),
            );
            expect(crossUser).toBeInstanceOf(MealReuseSourceNotFoundError);
            // Indistinguishable from a genuinely absent source by design.
            expect(crossUser.message).toBe(absent.message);
            expect(JSON.stringify(crossUser)).not.toContain("private");
            expect(JSON.stringify(crossUser)).not.toContain(sourceId);
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("deleted source -> not_found, zero writes", async () => {
            const sourceId = await seedReadySource(
                "u1",
                "del-src",
                "deleted porridge",
            );
            await deleteMealEvent(pool, "u1", sourceId);
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({ source_event_id: sourceId }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseSourceNotFoundError);
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("source_version 0 is rejected by validation before any query", async () => {
            const sourceId = await seedReadySource(
                "u1",
                "v0-src",
                "version zero oats",
            );
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        source_event_id: sourceId,
                        source_version: 0,
                    }),
                ),
            );
            expect(err).toBeInstanceOf(MealEventValidationError);
            expect(err.message).toContain("source_version");
            expect(await domainTableCounts(pool)).toEqual(before);
        });

        test("nonexistent version (current+1) -> version error, never a leak of version existence across users", async () => {
            const sourceId = await seedReadySource(
                "u1",
                "v99-src",
                "version ninety-nine oats",
            );
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        source_event_id: sourceId,
                        source_version: 99,
                    }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseSourceVersionError);
            expect((err as MealReuseSourceVersionError).code).toBe(
                "meal_reuse_source_version_not_current_or_historical",
            );
            // Scope check precedes the version check: u2 sees not_found even
            // for a version number that also does not exist.
            const crossUser = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        user_id: "u2",
                        source_event_id: sourceId,
                        source_version: 99,
                        idempotency_key: "v99-xu",
                    }),
                ),
            );
            expect(crossUser).toBeInstanceOf(MealReuseSourceNotFoundError);
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("bundle-less pending source -> ineligible: compatibility", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "pending-src",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "pending oats" }],
            });
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({ source_event_id: sourceId }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseSourceIneligibleError);
            expect((err as MealReuseSourceIneligibleError).category).toBe(
                "compatibility",
            );
            expect(err.message).toContain(
                "meal_reuse_source_ineligible: compatibility",
            );
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("unavailable bundle source -> ineligible: unavailable", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "unavail-src",
                consumedAt: daysAgo(1),
                items: [{ ordinal: 0, raw_item_text: "unavailable oats" }],
            });
            await commitBundle(pool, "u1", unavailableBundle(sourceId, 1));
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({ source_event_id: sourceId }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseSourceIneligibleError);
            expect((err as MealReuseSourceIneligibleError).category).toBe(
                "unavailable",
            );
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("ready-then-tampered canonical (emptied audit_evidence) -> ineligible: pending, nothing created", async () => {
            const sourceId = await seedReadySource(
                "u1",
                "tamper-src",
                "tampered oats",
            );
            await pool.query(
                `UPDATE meal_event_canonical_results
                 SET audit_evidence = '{}'::jsonb
                 WHERE event_id = $1 AND version = 1 AND ordinal IS NULL`,
                [sourceId],
            );
            const before = await domainTableCounts(pool);
            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({ source_event_id: sourceId }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseSourceIneligibleError);
            expect((err as MealReuseSourceIneligibleError).category).toBe(
                "pending",
            );
            expect(await domainTableCounts(pool)).toEqual(before);
            await expectNoZeroCanonical(pool);
        });

        test("idempotency conflict error carries the shared stable code", async () => {
            const err = new MealReuseIdempotencyConflictError();
            expect(err.code).toBe("idempotency_conflict");
            expect(err.message).toContain("idempotency_conflict");
        });
    },
);

// ---------------------------------------------------------------------------
// Slice 4 idempotency: identical retry converges on the original graph with
// zero new rows; changed identity under the same key is a stable conflict;
// different keys produce independent targets.
// ---------------------------------------------------------------------------

describeDb(
    "reuse_meal_calculation idempotency (requires DATABASE_URL_TEST)",
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

        async function seedReady(key: string, text: string): Promise<string> {
            const id = await seedMealEvent(pool, "u1", {
                idempotencyKey: key,
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: text }],
            });
            await commitBundle(pool, "u1", readyBundle(id, 1));
            return id;
        }

        test("identical retry returns the original readback with zero row delta", async () => {
            const sourceId = await seedReady("idem-src", "idempotent oats");
            const command = reuseCommand({ source_event_id: sourceId });
            const first = await reuseMealCalculation(pool, command);
            const before = await domainTableCounts(pool);

            const retry = await reuseMealCalculation(pool, command);

            expect(retry.event_id).toBe(first.event_id);
            expect(retry.deduplicated).toBe(true);
            expect(retry.source_event_id).toBe(sourceId);
            expect(retry.source_version).toBe(1);
            expect(retry.source_was_current).toBe(true);
            expect(retry.source_bundle_fingerprint).toBe(
                first.source_bundle_fingerprint,
            );
            expect(retry.provenance_status).toBe("ready");
            expect(retry.compatibility).toBe(false);
            expect(await domainTableCounts(pool)).toEqual(before);
        });

        test("same key + different source_version -> idempotency_conflict, zero delta", async () => {
            const sourceId = await seedReady("confv-src", "conflict v oats");
            await correctMeal(pool, "u1", sourceId, {
                correctionKey: "confv-v2",
                items: [{ ordinal: 0, raw_item_text: "conflict v oats v2" }],
            });
            await reuseMealCalculation(
                pool,
                reuseCommand({
                    source_event_id: sourceId,
                    source_version: 1,
                    idempotency_key: "conflict-key",
                }),
            );
            const before = await domainTableCounts(pool);

            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        source_event_id: sourceId,
                        source_version: 2,
                        idempotency_key: "conflict-key",
                    }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseIdempotencyConflictError);
            expect((err as MealReuseIdempotencyConflictError).code).toBe(
                "idempotency_conflict",
            );
            expect(await domainTableCounts(pool)).toEqual(before);
        });

        test("same key + different consumed_at -> idempotency_conflict, zero delta", async () => {
            const sourceId = await seedReady("conft-src", "conflict t oats");
            await reuseMealCalculation(
                pool,
                reuseCommand({
                    source_event_id: sourceId,
                    idempotency_key: "conflict-time",
                }),
            );
            const before = await domainTableCounts(pool);

            const err = await catchReuseError(
                reuseMealCalculation(
                    pool,
                    reuseCommand({
                        source_event_id: sourceId,
                        idempotency_key: "conflict-time",
                        consumed_at: "2026-08-06T12:45:00.000Z",
                    }),
                ),
            );
            expect(err).toBeInstanceOf(MealReuseIdempotencyConflictError);
            expect(await domainTableCounts(pool)).toEqual(before);
        });

        test("different keys + same source produce two independent targets and lineage rows", async () => {
            const sourceId = await seedReady("twice-src", "twice reused oats");
            const first = await reuseMealCalculation(
                pool,
                reuseCommand({
                    source_event_id: sourceId,
                    idempotency_key: "twice-1",
                }),
            );
            const second = await reuseMealCalculation(
                pool,
                reuseCommand({
                    source_event_id: sourceId,
                    idempotency_key: "twice-2",
                    consumed_at: "2026-08-06T18:00:00.000Z",
                    reported_at: "2026-08-06T18:30:00.000Z",
                }),
            );
            expect(second.event_id).not.toBe(first.event_id);
            expect(second.deduplicated).toBe(false);
            const lineage = await pool.query(
                `SELECT event_id FROM meal_event_reuse_sources
                 WHERE user_id = 'u1' AND source_event_id = $1
                 ORDER BY event_id`,
                [sourceId],
            );
            expect(lineage.rows.map((r) => r.event_id).sort()).toEqual(
                [first.event_id, second.event_id].sort(),
            );
            // Both targets are independent, ready roots.
            for (const eventId of [first.event_id, second.event_id]) {
                const readback = await getMealEventProvenance(
                    pool,
                    "u1",
                    eventId,
                );
                expect(readback!.provenance_status).toBe("ready");
            }
            // The source root was never repointed by either reuse.
            const source = await pool.query(
                `SELECT current_version FROM meal_events WHERE id = $1`,
                [sourceId],
            );
            expect(source.rows[0]!.current_version).toBe(1);
        });
    },
);

// ---------------------------------------------------------------------------
// Slice 4 concurrency + injected rollback: DB-serialized same-key racers
// converge on exactly one graph; a post-child/pre-commit failure leaves zero
// operation-owned rows and an intact, reusable source.
// ---------------------------------------------------------------------------

describeDb(
    "reuse_meal_calculation concurrency and rollback (requires DATABASE_URL_TEST)",
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

        test("concurrent same-key reuse from two separate Pools converges on one graph", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "race-src",
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: "raced oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));
            const baseline = await domainTableCounts(pool);
            const command = reuseCommand({
                source_event_id: sourceId,
                idempotency_key: "race-key",
            });

            const poolB = new Pool({ connectionString: DATABASE_URL_TEST });
            try {
                const [a, b] = await Promise.all([
                    reuseMealCalculation(pool, command),
                    reuseMealCalculation(poolB, command),
                ]);
                expect(a.event_id).toBe(b.event_id);
                expect([a.deduplicated, b.deduplicated].sort()).toEqual([
                    false,
                    true,
                ]);
            } finally {
                await poolB.end();
            }

            const after = await domainTableCounts(pool);
            expect(after.meal_events! - baseline.meal_events!).toBe(1);
            expect(
                after.meal_event_versions! - baseline.meal_event_versions!,
            ).toBe(1);
            expect(after.meal_event_items! - baseline.meal_event_items!).toBe(
                1,
            );
            expect(
                after.meal_event_nutrition_results! -
                    baseline.meal_event_nutrition_results!,
            ).toBe(3);
            expect(
                after.meal_event_canonical_results! -
                    baseline.meal_event_canonical_results!,
            ).toBe(1);
            expect(
                after.meal_event_reuse_sources! -
                    baseline.meal_event_reuse_sources!,
            ).toBe(1);
            expect(
                after.meal_event_reuse_provider_sources! -
                    baseline.meal_event_reuse_provider_sources!,
            ).toBe(3);
            for (const table of Object.keys(after)) {
                if (
                    table.startsWith("supplement_") ||
                    table === "meal_event_inputs"
                ) {
                    expect(after[table]).toBe(baseline[table]);
                }
            }
        });

        test("injected post-child/pre-commit failure leaves zero operation-owned rows, source intact, key reusable", async () => {
            const sourceId = await seedMealEvent(pool, "u1", {
                idempotencyKey: "rb-src",
                consumedAt: daysAgo(2),
                items: [{ ordinal: 0, raw_item_text: "rollback oats" }],
            });
            await commitBundle(pool, "u1", readyBundle(sourceId, 1));
            const sourceBefore = await snapshotAggregate(pool, sourceId, 1);
            const baseline = await domainTableCounts(pool);
            const command = reuseCommand({
                source_event_id: sourceId,
                idempotency_key: "rollback-key",
            });

            const err = await catchReuseError(
                reuseMealCalculation(pool, command, {
                    beforeCommit: async () => {
                        throw new Error("injected pre-commit failure");
                    },
                }),
            );
            expect(err.message).toContain("injected pre-commit failure");
            // All-or-nothing: the lineage row, mapping rows, and every target
            // graph row aborted with the transaction.
            expect(await domainTableCounts(pool)).toEqual(baseline);
            expect(await snapshotAggregate(pool, sourceId, 1)).toEqual(
                sourceBefore,
            );

            // The key stays usable: a clean retry succeeds.
            const retry = await reuseMealCalculation(pool, command);
            expect(retry.deduplicated).toBe(false);
            const readback = await getMealEventProvenance(
                pool,
                "u1",
                retry.event_id,
            );
            expect(readback!.provenance_status).toBe("ready");
        });
    },
);
