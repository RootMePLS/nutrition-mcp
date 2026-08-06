import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool } from "pg";
import {
    createSupplementProduct,
    reviseSupplementProductLabel,
    getSupplementProduct,
    listSupplementProducts,
    searchSupplementProducts,
    createSupplementRegimen,
    SupplementIdempotencyConflictError,
    SupplementProductInactiveError,
    SupplementProductNotFoundError,
    SupplementProductVersionNotFoundError,
    SupplementValidationError,
    type CreateSupplementProductCommand,
    type CreateSupplementRegimenCommand,
} from "./supplements.js";

// ---------------------------------------------------------------------------
// Slice 2 repository gate: versioned, user-scoped supplement product
// catalogue against real PostgreSQL. Skipped loudly without
// DATABASE_URL_TEST; every test resets the public schema and replays the
// full migration chain 001-009 (the current head).
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/supplements.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
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

function validCreateCommand(
    overrides: Record<string, unknown> = {},
): CreateSupplementProductCommand {
    return {
        user_id: "u1",
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
            // Explicit numeric zero: real label data, must persist as 0.
            { nutrient_key: "fat_g", amount: 0, unit: "g" },
            // Generic non-food-compatible key with its own unit.
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
        created_by: "test",
        ...overrides,
    } as CreateSupplementProductCommand;
}

async function tableCount(pool: Pool, table: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table}`,
    );
    return rows[0]!.n as number;
}

describeDb("supplement product repository (requires DATABASE_URL_TEST)", () => {
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

    describe("createSupplementProduct", () => {
        test("persists root, immutable version 1, aliases, and generic nutrients with units/evidence", async () => {
            const result = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            expect(result.deduplicated).toBe(false);
            const p = result.product;
            expect(typeof p.product_id).toBe("string");
            expect(p.category).toBe("sports_nutrition");
            expect(p.status).toBe("active");
            expect(p.current_version).toBe(1);
            expect(p.version.version).toBe(1);
            expect(p.version.is_current).toBe(true);
            expect(p.version.display_name).toBe("Impact Whey Protein");
            expect(p.version.short_name).toBe("Whey");
            expect(p.version.brand).toBe("MyProtein");
            expect(p.version.form).toBe("powder");
            expect(p.version.serving_amount).toBe(30);
            expect(p.version.serving_unit).toBe("g");
            expect(p.version.serving_description).toBe("1 level scoop");
            expect(p.version.label_source_kind).toBe("user_verified_label");
            expect(p.version.label_evidence).toEqual({
                kind: "label_photo",
                verified_by: "user",
                captured_on: "2026-08-05",
            });
            expect(p.version.aliases).toEqual(["impact whey", "MP Whey"]);
            expect(p.version.nutrients).toEqual([
                {
                    nutrient_key: "calories",
                    display_name: "Energy",
                    amount: 120,
                    unit: "kcal",
                    source_evidence: { label_line: "per 30 g serving" },
                },
                {
                    nutrient_key: "fat_g",
                    display_name: null,
                    amount: 0,
                    unit: "g",
                    source_evidence: {},
                },
                {
                    nutrient_key: "protein_g",
                    display_name: null,
                    amount: 21,
                    unit: "g",
                    source_evidence: {},
                },
                {
                    nutrient_key: "vitamin_d",
                    display_name: "Vitamin D",
                    amount: 5,
                    unit: "µg",
                    source_evidence: {},
                },
            ]);

            expect(await tableCount(pool, "supplement_products")).toBe(1);
            expect(await tableCount(pool, "supplement_product_versions")).toBe(
                1,
            );
            expect(await tableCount(pool, "supplement_product_aliases")).toBe(
                2,
            );
            expect(await tableCount(pool, "supplement_product_nutrients")).toBe(
                4,
            );
        });

        test("stores trimmed raw aliases plus lowercase normalized lookup form", async () => {
            const result = await createSupplementProduct(
                pool,
                validCreateCommand({ aliases: ["  MP   WHEY "] }),
            );
            expect(result.product.version.aliases).toEqual(["MP   WHEY"]);
            const { rows } = await pool.query(
                `SELECT alias, normalized_alias FROM supplement_product_aliases WHERE product_id = $1`,
                [result.product.product_id],
            );
            expect(rows).toEqual([
                { alias: "MP   WHEY", normalized_alias: "mp whey" },
            ]);
        });

        test("explicit numeric zero persists as 0; an unsupplied nutrient is absent, never null", async () => {
            const result = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            const { rows } = await pool.query(
                `SELECT nutrient_key, amount::text AS amount FROM supplement_product_nutrients
                 WHERE product_id = $1 ORDER BY nutrient_key`,
                [result.product.product_id],
            );
            const byKey = new Map(rows.map((r) => [r.nutrient_key, r.amount]));
            expect(byKey.get("fat_g")).toBe("0");
            // carbs_g was never supplied: no row at all (unknown is absent).
            expect(byKey.has("carbs_g")).toBe(false);
            // The amount column is NOT NULL: no unknown can persist as null.
            const { rows: nullRows } = await pool.query(
                `SELECT count(*)::int AS n FROM supplement_product_nutrients WHERE amount IS NULL`,
            );
            expect(nullRows[0]!.n).toBe(0);
        });

        test("persists optional label-defined nutrient limits", async () => {
            const result = await createSupplementProduct(
                pool,
                validCreateCommand({
                    label_limits: [
                        {
                            nutrient_key: "vitamin_d",
                            unit: "µg",
                            maximum_amount: 100,
                            source_evidence: { label_line: "do not exceed" },
                        },
                    ],
                }),
            );
            expect(result.product.version.label_limits).toEqual([
                {
                    nutrient_key: "vitamin_d",
                    unit: "µg",
                    maximum_amount: 100,
                    source_evidence: { label_line: "do not exceed" },
                },
            ]);
            expect(
                await tableCount(pool, "supplement_product_label_limits"),
            ).toBe(1);
        });

        test("rejects duplicate normalized aliases within one label version before any write", async () => {
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ aliases: ["Whey", "  whey "] }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            expect(await tableCount(pool, "supplement_products")).toBe(0);
        });

        test("rejects an empty alias and a missing display name", async () => {
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ aliases: ["ok", "   "] }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ display_name: "  " }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            expect(await tableCount(pool, "supplement_products")).toBe(0);
        });

        test("rejects an unknown category", async () => {
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ category: "medicine" }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            expect(await tableCount(pool, "supplement_products")).toBe(0);
        });

        test("rejects serving_amount without serving_unit and vice versa", async () => {
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ serving_unit: null }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ serving_amount: null }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ serving_amount: -1 }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            expect(await tableCount(pool, "supplement_products")).toBe(0);
        });

        test("rejects malformed nutrient lists (null amount, negative amount, duplicate key+unit)", async () => {
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({
                        nutrients: [
                            {
                                nutrient_key: "calories",
                                amount: null,
                                unit: "kcal",
                            },
                        ],
                    }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({
                        nutrients: [
                            {
                                nutrient_key: "calories",
                                amount: -5,
                                unit: "kcal",
                            },
                        ],
                    }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({
                        nutrients: [
                            {
                                nutrient_key: "calories",
                                amount: 1,
                                unit: "kcal",
                            },
                            {
                                nutrient_key: "calories",
                                amount: 2,
                                unit: "kcal",
                            },
                        ],
                    }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ nutrients: [] }),
                ),
            ).rejects.toBeInstanceOf(SupplementValidationError);
            expect(await tableCount(pool, "supplement_products")).toBe(0);
        });

        test("same idempotency key and payload returns the original product; changed payload conflicts", async () => {
            const first = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            const retry = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            expect(retry.deduplicated).toBe(true);
            expect(retry.product.product_id).toBe(first.product.product_id);
            expect(await tableCount(pool, "supplement_products")).toBe(1);

            await expect(
                createSupplementProduct(
                    pool,
                    validCreateCommand({ display_name: "Different Whey" }),
                ),
            ).rejects.toBeInstanceOf(SupplementIdempotencyConflictError);
            expect(await tableCount(pool, "supplement_products")).toBe(1);
        });

        // Regression coverage for the reviewer-terra race: concurrent
        // first-time creates used to pass the unlocked lookup together and
        // each commit a root. Migration 008's partial unique index
        // (uniq_spv_user_create_idem) serializes the race at the database;
        // these tests fire truly concurrent calls from separate pg clients
        // via Promise.all and assert exact child-row counts.
        describe("concurrent first-time create idempotency", () => {
            // One pool per caller so every create runs on its own PostgreSQL
            // connection; max: 1 forbids silent connection reuse.
            function callerPools(n: number): Pool[] {
                return Array.from(
                    { length: n },
                    () =>
                        new Pool({
                            connectionString: DATABASE_URL_TEST,
                            max: 1,
                        }),
                );
            }

            async function endPools(pools: Pool[]): Promise<void> {
                await Promise.all(pools.map((p) => p.end()));
            }

            test("same user/key/payload converges to exactly one root and one version-1 label", async () => {
                const callers = callerPools(4);
                try {
                    const results = await Promise.all(
                        callers.map((p) =>
                            createSupplementProduct(p, validCreateCommand()),
                        ),
                    );
                    const ids = new Set(
                        results.map((r) => r.product.product_id),
                    );
                    expect(ids.size).toBe(1);
                    expect(results.filter((r) => !r.deduplicated).length).toBe(
                        1,
                    );
                    expect(results.filter((r) => r.deduplicated).length).toBe(
                        3,
                    );
                    for (const r of results) {
                        expect(r.product.current_version).toBe(1);
                        expect(r.product.version.version).toBe(1);
                        expect(r.product.version.display_name).toBe(
                            "Impact Whey Protein",
                        );
                    }
                } finally {
                    await endPools(callers);
                }
                expect(await tableCount(pool, "supplement_products")).toBe(1);
                expect(
                    await tableCount(pool, "supplement_product_versions"),
                ).toBe(1);
                expect(
                    await tableCount(pool, "supplement_product_aliases"),
                ).toBe(2);
                expect(
                    await tableCount(pool, "supplement_product_nutrients"),
                ).toBe(4);
            });

            test("same user/key with different payloads commits exactly one root and conflicts the loser", async () => {
                const callers = callerPools(2);
                let settled: PromiseSettledResult<unknown>[];
                try {
                    settled = await Promise.allSettled([
                        createSupplementProduct(
                            callers[0]!,
                            validCreateCommand(),
                        ),
                        createSupplementProduct(
                            callers[1]!,
                            validCreateCommand({
                                display_name: "Different Whey",
                            }),
                        ),
                    ]);
                } finally {
                    await endPools(callers);
                }
                const fulfilled = settled.filter(
                    (s) => s.status === "fulfilled",
                );
                const rejected = settled.filter((s) => s.status === "rejected");
                expect(fulfilled.length).toBe(1);
                expect(rejected.length).toBe(1);
                expect(
                    (rejected[0] as PromiseRejectedResult).reason,
                ).toBeInstanceOf(SupplementIdempotencyConflictError);
                // Exactly one committed root + version-1; the loser left no
                // child rows behind (whole transaction rolled back).
                expect(await tableCount(pool, "supplement_products")).toBe(1);
                expect(
                    await tableCount(pool, "supplement_product_versions"),
                ).toBe(1);
                expect(
                    await tableCount(pool, "supplement_product_aliases"),
                ).toBe(2);
                expect(
                    await tableCount(pool, "supplement_product_nutrients"),
                ).toBe(4);
                expect(
                    await tableCount(pool, "supplement_product_label_limits"),
                ).toBe(0);
            });

            test("different users may reuse the same idempotency key concurrently", async () => {
                const callers = callerPools(2);
                try {
                    const [a, b] = await Promise.all([
                        createSupplementProduct(
                            callers[0]!,
                            validCreateCommand(),
                        ),
                        createSupplementProduct(
                            callers[1]!,
                            validCreateCommand({ user_id: "u2" }),
                        ),
                    ]);
                    expect(a!.deduplicated).toBe(false);
                    expect(b!.deduplicated).toBe(false);
                    expect(a!.product.product_id).not.toBe(
                        b!.product.product_id,
                    );
                } finally {
                    await endPools(callers);
                }
                expect(await tableCount(pool, "supplement_products")).toBe(2);
                expect(
                    await tableCount(pool, "supplement_product_versions"),
                ).toBe(2);
            });

            test("concurrent creates with a null idempotency key stay independent (never forced unique)", async () => {
                const callers = callerPools(2);
                try {
                    const [a, b] = await Promise.all([
                        createSupplementProduct(
                            callers[0]!,
                            validCreateCommand({ idempotency_key: null }),
                        ),
                        createSupplementProduct(
                            callers[1]!,
                            validCreateCommand({ idempotency_key: null }),
                        ),
                    ]);
                    expect(a!.deduplicated).toBe(false);
                    expect(b!.deduplicated).toBe(false);
                    expect(a!.product.product_id).not.toBe(
                        b!.product.product_id,
                    );
                } finally {
                    await endPools(callers);
                }
                expect(await tableCount(pool, "supplement_products")).toBe(2);
            });
        });
    });

    describe("reviseSupplementProductLabel", () => {
        test("inserts version 2, moves the root current pointer, and leaves version 1 immutable", async () => {
            const created = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            const productId = created.product.product_id;

            const revised = await reviseSupplementProductLabel(pool, {
                user_id: "u1",
                product_id: productId,
                display_name: "Impact Whey Protein (new formula)",
                short_name: "Whey",
                brand: "MyProtein",
                form: "powder",
                serving_amount: 32,
                serving_unit: "g",
                serving_description: "1 heaped scoop",
                aliases: ["impact whey"],
                nutrients: [
                    { nutrient_key: "calories", amount: 128, unit: "kcal" },
                    { nutrient_key: "protein_g", amount: 23, unit: "g" },
                ],
                label_evidence: { kind: "label_photo", verified_by: "user" },
                label_source_kind: "user_verified_label",
                revision_idempotency_key: "revise:whey:2",
                created_by: "test",
            });
            expect(revised.deduplicated).toBe(false);
            expect(revised.previous_version).toBe(1);
            expect(revised.product.current_version).toBe(2);
            expect(revised.product.version.version).toBe(2);
            expect(revised.product.version.is_current).toBe(true);

            // Version 1 row is untouched: names and nutrients are immutable.
            const v1 = await getSupplementProduct(pool, "u1", productId, 1);
            expect(v1).not.toBeNull();
            expect(v1!.version.is_current).toBe(false);
            expect(v1!.version.display_name).toBe("Impact Whey Protein");
            expect(v1!.version.serving_amount).toBe(30);
            expect(v1!.version.nutrients).toHaveLength(4);
            expect(v1!.version.aliases).toEqual(["impact whey", "MP Whey"]);

            const { rows: v1Nutrients } = await pool.query(
                `SELECT nutrient_key, amount::text AS amount FROM supplement_product_nutrients
                 WHERE product_id = $1 AND version = 1 ORDER BY nutrient_key`,
                [productId],
            );
            expect(v1Nutrients).toEqual([
                { nutrient_key: "calories", amount: "120" },
                { nutrient_key: "fat_g", amount: "0" },
                { nutrient_key: "protein_g", amount: "21" },
                { nutrient_key: "vitamin_d", amount: "5" },
            ]);

            const { rows: root } = await pool.query(
                `SELECT current_version FROM supplement_products WHERE id = $1`,
                [productId],
            );
            expect(root[0]!.current_version).toBe(2);

            const { rows: v2 } = await pool.query(
                `SELECT prior_version FROM supplement_product_versions WHERE product_id = $1 AND version = 2`,
                [productId],
            );
            expect(v2[0]!.prior_version).toBe(1);
        });

        test("same revision idempotency key and payload returns the existing version; changed payload conflicts", async () => {
            const created = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            const productId = created.product.product_id;
            const revision = {
                user_id: "u1",
                product_id: productId,
                display_name: "Impact Whey Protein v2",
                short_name: null,
                brand: null,
                form: null,
                serving_amount: null,
                serving_unit: null,
                serving_description: null,
                aliases: [],
                nutrients: [
                    { nutrient_key: "calories", amount: 130, unit: "kcal" },
                ],
                label_limits: [],
                label_evidence: { kind: "label_photo" },
                label_source_kind: null,
                revision_idempotency_key: "revise:whey:fixed",
                created_by: "test",
            };
            const first = await reviseSupplementProductLabel(pool, revision);
            expect(first.product.current_version).toBe(2);

            const retry = await reviseSupplementProductLabel(pool, revision);
            expect(retry.deduplicated).toBe(true);
            expect(retry.product.current_version).toBe(2);
            expect(await tableCount(pool, "supplement_product_versions")).toBe(
                2,
            );

            await expect(
                reviseSupplementProductLabel(pool, {
                    ...revision,
                    display_name: "Conflicting Name",
                }),
            ).rejects.toBeInstanceOf(SupplementIdempotencyConflictError);
            expect(await tableCount(pool, "supplement_product_versions")).toBe(
                2,
            );
        });

        test("another user cannot revise the product (not found, no leakage)", async () => {
            const created = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            await expect(
                reviseSupplementProductLabel(pool, {
                    user_id: "u2",
                    product_id: created.product.product_id,
                    display_name: "Hijacked",
                    short_name: null,
                    brand: null,
                    form: null,
                    serving_amount: null,
                    serving_unit: null,
                    serving_description: null,
                    aliases: [],
                    nutrients: [
                        { nutrient_key: "calories", amount: 1, unit: "kcal" },
                    ],
                    label_limits: [],
                    label_evidence: { kind: "label_photo" },
                    label_source_kind: null,
                    revision_idempotency_key: null,
                    created_by: "test",
                }),
            ).rejects.toBeInstanceOf(SupplementProductNotFoundError);
            expect(await tableCount(pool, "supplement_product_versions")).toBe(
                1,
            );
        });

        test("revising a deleted product fails closed as inactive", async () => {
            const created = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            await pool.query(
                `UPDATE supplement_products SET status = 'deleted', deleted_at = now() WHERE id = $1`,
                [created.product.product_id],
            );
            await expect(
                reviseSupplementProductLabel(pool, {
                    user_id: "u1",
                    product_id: created.product.product_id,
                    display_name: "Revived",
                    short_name: null,
                    brand: null,
                    form: null,
                    serving_amount: null,
                    serving_unit: null,
                    serving_description: null,
                    aliases: [],
                    nutrients: [
                        { nutrient_key: "calories", amount: 1, unit: "kcal" },
                    ],
                    label_limits: [],
                    label_evidence: { kind: "label_photo" },
                    label_source_kind: null,
                    revision_idempotency_key: null,
                    created_by: "test",
                }),
            ).rejects.toBeInstanceOf(SupplementProductInactiveError);
            expect(await tableCount(pool, "supplement_product_versions")).toBe(
                1,
            );
        });

        test("revising an unknown product is not found", async () => {
            await expect(
                reviseSupplementProductLabel(pool, {
                    user_id: "u1",
                    product_id: "00000000-0000-0000-0000-00000000dead",
                    display_name: "Ghost",
                    short_name: null,
                    brand: null,
                    form: null,
                    serving_amount: null,
                    serving_unit: null,
                    serving_description: null,
                    aliases: [],
                    nutrients: [
                        { nutrient_key: "calories", amount: 1, unit: "kcal" },
                    ],
                    label_limits: [],
                    label_evidence: { kind: "label_photo" },
                    label_source_kind: null,
                    revision_idempotency_key: null,
                    created_by: "test",
                }),
            ).rejects.toBeInstanceOf(SupplementProductNotFoundError);
        });
    });

    describe("reads", () => {
        test("getSupplementProduct returns current by default, historical on request, null for unknown version/user/deleted", async () => {
            const created = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            const productId = created.product.product_id;

            const current = await getSupplementProduct(pool, "u1", productId);
            expect(current!.version.version).toBe(1);

            expect(
                await getSupplementProduct(pool, "u1", productId, 2),
            ).toBeNull();
            // Cross-user reads resolve as not found: no existence leakage.
            expect(
                await getSupplementProduct(pool, "u2", productId),
            ).toBeNull();

            await pool.query(
                `UPDATE supplement_products SET status = 'deleted', deleted_at = now() WHERE id = $1`,
                [productId],
            );
            expect(
                await getSupplementProduct(pool, "u1", productId),
            ).toBeNull();
        });

        test("listSupplementProducts is user scoped and excludes deleted by default", async () => {
            const a = await createSupplementProduct(pool, validCreateCommand());
            await createSupplementProduct(
                pool,
                validCreateCommand({
                    display_name: "Creatine Monohydrate",
                    category: "supplement",
                    short_name: null,
                    aliases: ["creatine"],
                    idempotency_key: "create:creatine:1",
                    nutrients: [
                        { nutrient_key: "creatine_g", amount: 5, unit: "g" },
                    ],
                }),
            );
            await createSupplementProduct(
                pool,
                validCreateCommand({
                    user_id: "u2",
                    display_name: "U2 Vitamin",
                    idempotency_key: "create:u2:1",
                }),
            );

            const u1List = await listSupplementProducts(pool, "u1");
            expect(u1List).toHaveLength(2);
            expect(u1List.map((p) => p.display_name).sort()).toEqual([
                "Creatine Monohydrate",
                "Impact Whey Protein",
            ]);
            const whey = u1List.find(
                (p) => p.product_id === a.product.product_id,
            )!;
            expect(whey.aliases).toEqual(["impact whey", "MP Whey"]);
            expect(whey.category).toBe("sports_nutrition");
            expect(whey.current_version).toBe(1);

            const u2List = await listSupplementProducts(pool, "u2");
            expect(u2List).toHaveLength(1);
            expect(u2List[0]!.display_name).toBe("U2 Vitamin");

            await pool.query(
                `UPDATE supplement_products SET status = 'deleted', deleted_at = now() WHERE id = $1`,
                [a.product.product_id],
            );
            expect(await listSupplementProducts(pool, "u1")).toHaveLength(1);
            const withDeleted = await listSupplementProducts(pool, "u1", {
                includeDeleted: true,
            });
            expect(withDeleted).toHaveLength(2);
            expect(
                withDeleted.find((p) => p.product_id === a.product.product_id)!
                    .status,
            ).toBe("deleted");
        });

        test("searchSupplementProducts matches name/short name/alias case-insensitively, scoped and active only", async () => {
            await createSupplementProduct(pool, validCreateCommand());
            await createSupplementProduct(
                pool,
                validCreateCommand({
                    display_name: "Creatine Monohydrate",
                    category: "supplement",
                    short_name: null,
                    aliases: ["creatine"],
                    idempotency_key: "create:creatine:1",
                    nutrients: [
                        { nutrient_key: "creatine_g", amount: 5, unit: "g" },
                    ],
                }),
            );
            await createSupplementProduct(
                pool,
                validCreateCommand({
                    user_id: "u2",
                    display_name: "U2 Impact Whey Clone",
                    idempotency_key: "create:u2:1",
                }),
            );

            // Display name, case-insensitive substring.
            const byName = await searchSupplementProducts(pool, "u1", "WHEY");
            expect(byName).toHaveLength(1);
            expect(byName[0]!.display_name).toBe("Impact Whey Protein");

            // Short name.
            const byShort = await searchSupplementProducts(pool, "u1", "whey");
            expect(byShort).toHaveLength(1);

            // Alias of the current version, mixed case.
            const byAlias = await searchSupplementProducts(
                pool,
                "u1",
                "mp WHEY",
            );
            expect(byAlias).toHaveLength(1);
            expect(byAlias[0]!.display_name).toBe("Impact Whey Protein");

            // The other user's similarly named product never leaks.
            const u2 = await searchSupplementProducts(pool, "u2", "impact");
            expect(u2).toHaveLength(1);
            expect(u2[0]!.display_name).toBe("U2 Impact Whey Clone");

            expect(
                await searchSupplementProducts(pool, "u1", "nonexistent"),
            ).toHaveLength(0);
        });

        test("search matches aliases of the current version only, not historical ones", async () => {
            const created = await createSupplementProduct(
                pool,
                validCreateCommand(),
            );
            await reviseSupplementProductLabel(pool, {
                user_id: "u1",
                product_id: created.product.product_id,
                display_name: "Impact Whey Protein",
                short_name: null,
                brand: null,
                form: null,
                serving_amount: 30,
                serving_unit: "g",
                serving_description: null,
                aliases: ["new-whey-alias"],
                nutrients: [
                    { nutrient_key: "calories", amount: 120, unit: "kcal" },
                ],
                label_limits: [],
                label_evidence: { kind: "label_photo" },
                label_source_kind: null,
                revision_idempotency_key: "revise:whey:aliases",
                created_by: "test",
            });
            // "MP Whey" is only on version 1: no longer searchable.
            expect(
                await searchSupplementProducts(pool, "u1", "mp whey"),
            ).toHaveLength(0);
            expect(
                await searchSupplementProducts(pool, "u1", "new-whey-alias"),
            ).toHaveLength(1);
        });
    });
});

// ---------------------------------------------------------------------------
// Slice 5: supplement regimens — transactional, idempotent creation over the
// migration 010 partial unique index. Real PostgreSQL only.
// ---------------------------------------------------------------------------

function validRegimenCommand(
    productId: string,
    overrides: Record<string, unknown> = {},
): CreateSupplementRegimenCommand {
    return {
        user_id: "u1",
        product_id: productId,
        dose_servings: 1.5,
        schedule: {
            timezone: "Europe/Berlin",
            frequency: "weekly",
            local_time: "08:30",
            weekdays: [1, 4],
        },
        starts_on: "2026-08-01",
        ends_on: "2026-12-31",
        idempotency_key: `regimen:${crypto.randomUUID()}`,
        created_by: "test",
        ...overrides,
    } as CreateSupplementRegimenCommand;
}

async function sliceFiveWriteTableCounts(
    pool: Pool,
): Promise<Record<string, number>> {
    return {
        supplement_intake_events: await tableCount(
            pool,
            "supplement_intake_events",
        ),
        supplement_intake_nutrient_snapshots: await tableCount(
            pool,
            "supplement_intake_nutrient_snapshots",
        ),
        supplement_intake_meal_links: await tableCount(
            pool,
            "supplement_intake_meal_links",
        ),
        meal_events: await tableCount(pool, "meal_events"),
    };
}

const ZERO_SLICE_FIVE_WRITES: Record<string, number> = {
    supplement_intake_events: 0,
    supplement_intake_nutrient_snapshots: 0,
    supplement_intake_meal_links: 0,
    meal_events: 0,
};

describeDb(
    "supplement regimen repository: create (requires DATABASE_URL_TEST)",
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

        async function seedProduct(
            overrides: Record<string, unknown> = {},
        ): Promise<{ product_id: string }> {
            const result = await createSupplementProduct(
                pool,
                validCreateCommand({
                    idempotency_key: `product:${crypto.randomUUID()}`,
                    ...overrides,
                }),
            );
            return { product_id: result.product.product_id };
        }

        async function reviseToV2(productId: string, displayName: string) {
            return reviseSupplementProductLabel(pool, {
                user_id: "u1",
                product_id: productId,
                display_name: displayName,
                short_name: "Whey",
                brand: "MyProtein",
                form: "powder",
                serving_amount: 32,
                serving_unit: "g",
                serving_description: "1 heaped scoop",
                aliases: ["impact whey"],
                nutrients: [
                    { nutrient_key: "calories", amount: 128, unit: "kcal" },
                    { nutrient_key: "protein_g", amount: 23, unit: "g" },
                ],
                label_evidence: { kind: "label_photo", verified_by: "user" },
                label_source_kind: "user_verified_label",
                revision_idempotency_key: `revise:${crypto.randomUUID()}`,
                created_by: "test",
            });
        }

        test("create regimen persists version binding, schedule, window, and audit metadata", async () => {
            const { product_id } = await seedProduct();
            const result = await createSupplementRegimen(
                pool,
                validRegimenCommand(product_id, {
                    idempotency_key: "reg:persist",
                }),
            );
            expect(result.deduplicated).toBe(false);
            const r = result.regimen;
            expect(typeof r.regimen_id).toBe("string");
            expect(r.product_id).toBe(product_id);
            expect(r.product_version).toBe(1);
            expect(r.product_display_name).toBe("Impact Whey Protein");
            expect(r.category).toBe("sports_nutrition");
            expect(r.dose_servings).toBe(1.5);
            expect(r.schedule).toEqual({
                timezone: "Europe/Berlin",
                frequency: "weekly",
                local_time: "08:30",
                weekdays: [1, 4],
            });
            expect(r.starts_on).toBe("2026-08-01");
            expect(r.ends_on).toBe("2026-12-31");
            expect(r.active).toBe(true);
            expect(r.deactivated_at).toBeNull();
            expect(typeof r.created_at).toBe("string");
            expect(typeof r.updated_at).toBe("string");

            // The stored row denormalizes timezone from the schedule and carries
            // the caller's audit metadata.
            const { rows } = await pool.query(
                `SELECT timezone, created_by, idempotency_key
             FROM supplement_regimens WHERE id = $1`,
                [r.regimen_id],
            );
            expect(rows[0]).toEqual({
                timezone: "Europe/Berlin",
                created_by: "test",
                idempotency_key: "reg:persist",
            });
            expect(await tableCount(pool, "supplement_regimens")).toBe(1);
        });

        test("omitted product_version defaults to the current version at create time and pins it", async () => {
            const { product_id } = await seedProduct();
            const created = await createSupplementRegimen(
                pool,
                validRegimenCommand(product_id),
            );
            expect(created.regimen.product_version).toBe(1);

            await reviseToV2(product_id, "Impact Whey Protein (new formula)");

            // A later label revision never moves the regimen's bound version.
            const { rows } = await pool.query(
                `SELECT product_version FROM supplement_regimens WHERE id = $1`,
                [created.regimen.regimen_id],
            );
            expect(rows[0]!.product_version).toBe(1);
        });

        test("an explicit historical version binds that version and its display name", async () => {
            const { product_id } = await seedProduct();
            await reviseToV2(product_id, "Impact Whey Protein (new formula)");

            const created = await createSupplementRegimen(
                pool,
                validRegimenCommand(product_id, { product_version: 1 }),
            );
            expect(created.regimen.product_version).toBe(1);
            expect(created.regimen.product_display_name).toBe(
                "Impact Whey Protein",
            );
        });

        test("a version the product does not have fails closed with zero rows", async () => {
            const { product_id } = await seedProduct();
            await expect(
                createSupplementRegimen(
                    pool,
                    validRegimenCommand(product_id, { product_version: 7 }),
                ),
            ).rejects.toBeInstanceOf(SupplementProductVersionNotFoundError);
            expect(await tableCount(pool, "supplement_regimens")).toBe(0);
        });

        test("unknown, cross-user, and deleted products all fail closed as not found", async () => {
            const { product_id } = await seedProduct();

            await expect(
                createSupplementRegimen(
                    pool,
                    validRegimenCommand(crypto.randomUUID()),
                ),
            ).rejects.toBeInstanceOf(SupplementProductNotFoundError);

            await expect(
                createSupplementRegimen(
                    pool,
                    validRegimenCommand(product_id, { user_id: "u2" }),
                ),
            ).rejects.toBeInstanceOf(SupplementProductNotFoundError);

            await pool.query(
                `UPDATE supplement_products SET status = 'deleted' WHERE id = $1`,
                [product_id],
            );
            await expect(
                createSupplementRegimen(pool, validRegimenCommand(product_id)),
            ).rejects.toBeInstanceOf(SupplementProductNotFoundError);
            expect(await tableCount(pool, "supplement_regimens")).toBe(0);
        });

        test("rejects nonpositive/nonfinite dose, invalid schedule, inverted window, and junk dates with zero rows", async () => {
            const { product_id } = await seedProduct();
            const rejections: Record<string, unknown>[] = [
                { dose_servings: 0 },
                { dose_servings: -2 },
                { dose_servings: Number.NaN },
                { dose_servings: Number.POSITIVE_INFINITY },
                {
                    schedule: {
                        timezone: "Mars/Olympus",
                        frequency: "daily",
                        local_time: "08:00",
                    },
                },
                {
                    schedule: {
                        timezone: "UTC",
                        frequency: "hourly",
                        local_time: "08:00",
                    },
                },
                {
                    schedule: {
                        timezone: "UTC",
                        frequency: "weekly",
                        local_time: "08:00",
                    },
                },
                {
                    schedule: {
                        timezone: "UTC",
                        frequency: "daily",
                        local_time: "08:00",
                        weekdays: [1],
                    },
                },
                {
                    schedule: {
                        timezone: "UTC",
                        frequency: "daily",
                        local_time: "25:00",
                    },
                },
                { ends_on: "2026-07-31" },
                { starts_on: "2026-02-30" },
                { starts_on: "not-a-date" },
                { starts_on: "2026-08-01T00:00:00Z" },
                { ends_on: "2026-13-01" },
            ];
            for (const overrides of rejections) {
                await expect(
                    createSupplementRegimen(
                        pool,
                        validRegimenCommand(product_id, overrides),
                    ),
                ).rejects.toBeInstanceOf(SupplementValidationError);
            }
            expect(await tableCount(pool, "supplement_regimens")).toBe(0);
        });

        test("same-key same-identity replay returns the deduplicated original", async () => {
            const { product_id } = await seedProduct();
            const command = validRegimenCommand(product_id, {
                idempotency_key: "reg:replay",
            });
            const first = await createSupplementRegimen(pool, command);
            const replay = await createSupplementRegimen(pool, command);
            expect(first.deduplicated).toBe(false);
            expect(replay.deduplicated).toBe(true);
            expect(replay.regimen.regimen_id).toBe(first.regimen.regimen_id);
            expect(await tableCount(pool, "supplement_regimens")).toBe(1);
        });

        test("same key with a differing identity is a stable conflict, never a second row", async () => {
            const { product_id } = await seedProduct();
            await createSupplementRegimen(
                pool,
                validRegimenCommand(product_id, {
                    idempotency_key: "reg:conflict",
                }),
            );
            for (const overrides of [
                { dose_servings: 2 },
                {
                    schedule: {
                        timezone: "Europe/Berlin",
                        frequency: "daily",
                        local_time: "08:30",
                    },
                },
                { starts_on: "2026-08-02" },
                { ends_on: null },
            ]) {
                await expect(
                    createSupplementRegimen(
                        pool,
                        validRegimenCommand(product_id, {
                            idempotency_key: "reg:conflict",
                            ...overrides,
                        }),
                    ),
                ).rejects.toBeInstanceOf(SupplementIdempotencyConflictError);
            }
            expect(await tableCount(pool, "supplement_regimens")).toBe(1);
        });

        test("two concurrent same-key creates converge on exactly one row", async () => {
            const { product_id } = await seedProduct();
            const command = validRegimenCommand(product_id, {
                idempotency_key: "reg:race",
            });
            const results = await Promise.all([
                createSupplementRegimen(pool, command),
                createSupplementRegimen(pool, command),
            ]);
            expect(results[0]!.regimen.regimen_id).toBe(
                results[1]!.regimen.regimen_id,
            );
            expect(results.filter((r) => r.deduplicated).length).toBe(1);
            expect(await tableCount(pool, "supplement_regimens")).toBe(1);
        });

        test("an injected post-insert/pre-commit failure rolls back every row", async () => {
            const { product_id } = await seedProduct();
            await expect(
                createSupplementRegimen(pool, validRegimenCommand(product_id), {
                    beforeCommit: () =>
                        Promise.reject(new Error("injected rollback")),
                }),
            ).rejects.toThrow("injected rollback");
            expect(await tableCount(pool, "supplement_regimens")).toBe(0);
        });

        test("creating a regimen writes zero intake, snapshot, meal, or link rows", async () => {
            const { product_id } = await seedProduct();
            await createSupplementRegimen(
                pool,
                validRegimenCommand(product_id),
            );
            expect(await sliceFiveWriteTableCounts(pool)).toEqual(
                ZERO_SLICE_FIVE_WRITES,
            );
        });
    },
);
