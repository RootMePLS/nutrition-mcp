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
    INPUT_PRECEDENCE,
    NUTRIENT_FIELDS,
    canTransitionJournalState,
    deriveCorrectionFingerprint,
    deriveCreateFingerprint,
    isNutritionProvider,
    isProviderResultStatus,
    resolveConsumedAt,
    sortInputsByPrecedence,
    validateCreateMealEventCommand,
    type CreateMealEventCommand,
    type MealEventInputEvidence,
} from "./meal-types.js";
import {
    correctMealEvent,
    createMealEvent,
    deliverJournalEntry,
    getJournalEntry,
    getMealEvent,
    getMealEventHistory,
    markJournalInFlight,
    recordJournalFailure,
    recordJournalSuccess,
    type ExternalWriter,
} from "./meal-events.js";

// ---------------------------------------------------------------------------
// Contract fixtures: pure domain types and validation helpers. No database,
// no network, no Telegram/vision SDK types.
// ---------------------------------------------------------------------------

function validCommand(
    overrides: Partial<CreateMealEventCommand> = {},
): CreateMealEventCommand {
    return {
        user_id: "u1",
        idempotency_key: "create:abc",
        reported_at: "2026-08-04T12:00:00.000Z",
        items: [
            { ordinal: 0, raw_item_text: "oatmeal 80g" },
            { ordinal: 1, raw_item_text: "banana" },
        ],
        inputs: [
            { source_kind: "user_text", content: "oatmeal 80g and a banana" },
        ],
        media: [],
        provider_results: [],
        parser_policy_version: "policy-1",
        created_by: "test",
        ...overrides,
    };
}

describe("meal event domain contracts", () => {
    test("one event accepts multiple ordered positions", () => {
        const command = validCommand();
        expect(validateCreateMealEventCommand(command)).toEqual([]);
        expect(command.items.map((i) => i.ordinal)).toEqual([0, 1]);
    });

    test("explicit reported_at and consumed_at are preserved as given", () => {
        const reported = new Date("2026-08-04T12:00:00.000Z");
        const consumed = new Date("2026-08-04T08:30:00.000Z");
        expect(resolveConsumedAt(reported, consumed).toISOString()).toBe(
            consumed.toISOString(),
        );
    });

    test("omitted consumed_at resolves to the same instant as reported_at", () => {
        const reported = new Date("2026-08-04T12:00:00.000Z");
        expect(resolveConsumedAt(reported, undefined).toISOString()).toBe(
            reported.toISOString(),
        );
    });

    test("input precedence: user text beats audio, photo-derived and assumptions", () => {
        const inputs: MealEventInputEvidence[] = [
            { source_kind: "model_assumption", content: "guess" },
            { source_kind: "photo_vision", content: "vision labels" },
            { source_kind: "photo_ocr", content: "ocr text" },
            { source_kind: "user_text", content: "explicit text" },
            { source_kind: "audio_transcript", content: "transcript" },
        ];
        const sorted = sortInputsByPrecedence(inputs);
        expect(sorted.map((i) => i.source_kind)).toEqual([
            "user_text",
            "audio_transcript",
            "photo_ocr",
            "photo_vision",
            "model_assumption",
        ]);
        expect(INPUT_PRECEDENCE.user_text).toBeLessThan(
            INPUT_PRECEDENCE.audio_transcript,
        );
        expect(INPUT_PRECEDENCE.audio_transcript).toBeLessThan(
            INPUT_PRECEDENCE.photo_ocr,
        );
        expect(INPUT_PRECEDENCE.photo_ocr).toBeLessThan(
            INPUT_PRECEDENCE.photo_vision,
        );
        expect(INPUT_PRECEDENCE.photo_vision).toBeLessThan(
            INPUT_PRECEDENCE.model_assumption,
        );
    });

    test("provider namespaces are exactly nutrition-local, own, myfitnesspal", () => {
        expect(isNutritionProvider("nutrition-local")).toBe(true);
        expect(isNutritionProvider("own")).toBe(true);
        expect(isNutritionProvider("myfitnesspal")).toBe(true);
        expect(isNutritionProvider("usda")).toBe(false);
    });

    test("provider statuses distinguish failed/unavailable from numeric results", () => {
        expect(isProviderResultStatus("succeeded")).toBe(true);
        expect(isProviderResultStatus("failed")).toBe(true);
        expect(isProviderResultStatus("unavailable")).toBe(true);
        expect(isProviderResultStatus("ok")).toBe(false);
        // Nutrient fields are the seven canonical names, all nullable —
        // a missing value is NULL, never a fabricated zero.
        expect(NUTRIENT_FIELDS).toEqual([
            "calories",
            "protein_g",
            "carbs_g",
            "fat_g",
            "fiber_g",
            "sugar_g",
            "alcohol_g",
        ]);
    });

    test("journal authorization and state transitions are explicit", () => {
        expect(canTransitionJournalState("pending", "in_flight")).toBe(true);
        expect(canTransitionJournalState("in_flight", "succeeded")).toBe(true);
        expect(canTransitionJournalState("in_flight", "failed")).toBe(true);
        expect(canTransitionJournalState("failed", "in_flight")).toBe(true);
        expect(canTransitionJournalState("failed", "dead_letter")).toBe(true);
        // Never legal: pending cannot claim success; terminal states are final.
        expect(canTransitionJournalState("pending", "succeeded")).toBe(false);
        expect(canTransitionJournalState("succeeded", "failed")).toBe(false);
        expect(canTransitionJournalState("dead_letter", "in_flight")).toBe(
            false,
        );
    });

    test("correction fingerprint is distinct from the initial create fingerprint", () => {
        const create = deriveCreateFingerprint(validCommand());
        const correction = deriveCorrectionFingerprint({
            event_id: "evt-1",
            correction_idempotency_key: "corr:1",
            command: {
                event_id: "evt-1",
                correction_idempotency_key: "corr:1",
                items: validCommand().items,
                inputs: validCommand().inputs,
                media: [],
                provider_results: [],
                parser_policy_version: "policy-1",
                created_by: "test",
            },
        });
        expect(create).not.toBe(correction);
        // Stable: same input, same fingerprint.
        expect(deriveCreateFingerprint(validCommand())).toBe(create);
    });

    test("validation rejects an empty item list and duplicate ordinals", () => {
        expect(
            validateCreateMealEventCommand(validCommand({ items: [] })),
        ).toContain("items must not be empty");
        expect(
            validateCreateMealEventCommand(
                validCommand({
                    items: [
                        { ordinal: 0, raw_item_text: "a" },
                        { ordinal: 0, raw_item_text: "b" },
                    ],
                }),
            ),
        ).toContain("item ordinals must be unique");
    });

    test("public event validation never throws for throwing array Proxy traps", () => {
        const throwingArray = (trap: string) =>
            new Proxy([] as unknown[], {
                get(target, property, receiver) {
                    if (property === trap) throw new Error(`${trap} trap`);
                    return Reflect.get(target, property, receiver);
                },
            });
        for (const field of ["items", "inputs", "media"] as const) {
            for (const trap of ["length", "map", "some", "every", "get"]) {
                const command = validCommand({
                    [field]: throwingArray(trap === "get" ? "0" : trap),
                } as Partial<CreateMealEventCommand>);
                expect(() =>
                    validateCreateMealEventCommand(command),
                ).not.toThrow(`${field}/${trap}`);
                expect(
                    validateCreateMealEventCommand(command).length,
                ).toBeGreaterThan(0);
            }
        }
    });
});

test("public event validation fails closed for throwing and revoked top-level Proxies", () => {
    const throwingTopLevel = (
        trap: "get" | "has" | "ownKeys" | "getPrototypeOf",
    ) =>
        new Proxy(
            {},
            {
                get() {
                    if (trap === "get") throw new Error("top-level get trap");
                    return undefined;
                },
                has() {
                    if (trap === "has") throw new Error("top-level has trap");
                    return false;
                },
                ownKeys() {
                    if (trap === "ownKeys")
                        throw new Error("top-level ownKeys trap");
                    return [];
                },
                getPrototypeOf() {
                    if (trap === "getPrototypeOf")
                        throw new Error("top-level getPrototypeOf trap");
                    return Object.prototype;
                },
            },
        );
    const values: unknown[] = (
        ["get", "has", "ownKeys", "getPrototypeOf"] as const
    ).map(throwingTopLevel);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    values.push(revocable.proxy);
    for (const value of values) {
        let first: string[] = [];
        let second: string[] = [];
        expect(() => {
            first = validateCreateMealEventCommand(value as never);
            second = validateCreateMealEventCommand(value as never);
        }).not.toThrow();
        expect(first.length).toBeGreaterThan(0);
        expect(second).toEqual(first);
    }
});

// ---------------------------------------------------------------------------
// Repository integration tests: real PostgreSQL only. Skipped loudly when
// DATABASE_URL_TEST is not set — never reported as success without a DB.
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/meal-events.test.ts: repository tests SKIPPED — " +
            "DATABASE_URL_TEST is not set",
    );
}

const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

const MIGRATION_001 = "db/migrations/001_initial_schema.sql";
const MIGRATION_002 = "db/migrations/002_food_tracking.sql";

async function prepareFreshDb(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        await client.query(await Bun.file(MIGRATION_001).text());
        await client.query(await Bun.file(MIGRATION_002).text());
    } finally {
        client.release();
    }
}

async function tableCount(pool: Pool, table: string): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*) AS n FROM ${table}`);
    return Number(rows[0]!.n);
}

describeDb("meal event repository (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await prepareFreshDb(pool);
    });

    test("create: persists event with two positions, evidence and media metadata in one transaction", async () => {
        const command = validCommand({
            consumed_at: "2026-08-04T08:30:00.000Z",
            media: [
                {
                    kind: "photo",
                    storage_key: "evt/1/photo-abc",
                    mime_type: "image/jpeg",
                    byte_size: 123,
                    sha256: "a".repeat(64),
                },
            ],
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
        });
        const result = await createMealEvent(pool, command);
        expect(result.deduplicated).toBe(false);

        const aggregate = await getMealEvent(pool, result.event_id);
        expect(aggregate).not.toBeNull();
        expect(aggregate!.event.user_id).toBe("u1");
        expect(aggregate!.event.current_version).toBe(1);
        expect(aggregate!.event.consumed_at).toBe("2026-08-04T08:30:00.000Z");
        expect(aggregate!.items.map((i) => i.ordinal)).toEqual([0, 1]);
        expect(aggregate!.inputs.length).toBe(1);
        expect(aggregate!.inputs[0]!.source_kind).toBe("user_text");
        expect(aggregate!.inputs[0]!.content_hash.length).toBeGreaterThan(0);
        expect(aggregate!.media.length).toBe(1);
        expect(aggregate!.media[0]!.sha256).toBe("a".repeat(64));
        expect(aggregate!.provider_results.length).toBe(2);
        // Canonical row derived from the two agreeing providers.
        expect(aggregate!.canonical).not.toBeNull();
        expect(aggregate!.canonical!.consensus_status).toBe("all_agree");
        expect(Number(aggregate!.canonical!.calories)).toBe(505);
    });

    test("create: omitted consumed_at is stored equal to reported_at", async () => {
        const result = await createMealEvent(pool, validCommand());
        const aggregate = await getMealEvent(pool, result.event_id);
        expect(aggregate!.event.consumed_at).toBe(aggregate!.event.reported_at);
    });

    test("create: same idempotency-key retry returns the original and creates no duplicates", async () => {
        const first = await createMealEvent(pool, validCommand());
        const second = await createMealEvent(pool, validCommand());
        expect(second.deduplicated).toBe(true);
        expect(second.event_id).toBe(first.event_id);
        expect(second.version).toBe(1);
        expect(await tableCount(pool, "meal_events")).toBe(1);
        expect(await tableCount(pool, "meal_event_versions")).toBe(1);
        expect(await tableCount(pool, "meal_event_items")).toBe(2);
        expect(await tableCount(pool, "meal_event_inputs")).toBe(1);
    });

    test("analyze-first then explicit add retry authorizes root and creates one journal", async () => {
        const analyzed = await createMealEvent(pool, validCommand());
        const add = await createMealEvent(
            pool,
            validCommand({ external_write_authorized: true }),
        );
        expect(add.event_id).toBe(analyzed.event_id);
        const aggregate = await getMealEvent(pool, analyzed.event_id);
        expect(aggregate!.event.external_write_authorized).toBe(true);
        expect(aggregate!.journal.length).toBe(1);
        expect(aggregate!.journal[0]!.state).toBe("pending");
        const replay = await createMealEvent(
            pool,
            validCommand({ external_write_authorized: true }),
        );
        expect(replay.deduplicated).toBe(true);
        expect(
            (await getMealEvent(pool, analyzed.event_id))!.journal.length,
        ).toBe(1);
    });

    test("concurrent explicit add retries after analyze create one journal", async () => {
        await createMealEvent(pool, validCommand());
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                createMealEvent(
                    pool,
                    validCommand({ external_write_authorized: true }),
                ),
            ),
        );
        expect(results.every((result) => result.deduplicated)).toBe(true);
        const aggregate = await getMealEvent(pool, results[0]!.event_id);
        expect(aggregate!.event.external_write_authorized).toBe(true);
        expect(aggregate!.journal.length).toBe(1);
    });
    test("create: concurrent same-key creates yield one aggregate", async () => {
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                createMealEvent(pool, validCommand()),
            ),
        );
        const ids = new Set(results.map((r) => r.event_id));
        expect(ids.size).toBe(1);
        expect(results.filter((r) => !r.deduplicated).length).toBe(1);
        expect(await tableCount(pool, "meal_events")).toBe(1);
        expect(await tableCount(pool, "meal_event_versions")).toBe(1);
        expect(await tableCount(pool, "meal_event_items")).toBe(2);
    });

    test("create: injected DB failure rolls back root, version, items, inputs, results and journal together", async () => {
        const command = validCommand({
            external_write_authorized: true,
            provider_results: [
                {
                    // CHECK violation at insert time, deep inside the
                    // transaction — the whole write must roll back.
                    provider: "usda" as never,
                    status: "succeeded",
                    request_fingerprint: "fp-bad",
                    algorithm_version: "v1",
                    nutrients: { calories: 1 },
                },
            ],
        });
        await expect(createMealEvent(pool, command)).rejects.toThrow();
        expect(await tableCount(pool, "meal_events")).toBe(0);
        expect(await tableCount(pool, "meal_event_versions")).toBe(0);
        expect(await tableCount(pool, "meal_event_items")).toBe(0);
        expect(await tableCount(pool, "meal_event_inputs")).toBe(0);
        expect(await tableCount(pool, "meal_event_nutrition_results")).toBe(0);
        expect(await tableCount(pool, "meal_event_canonical_results")).toBe(0);
        expect(await tableCount(pool, "meal_event_sync_journal")).toBe(0);
    });

    test("create: a failed provider is stored as a failed result; the raw event stays committed", async () => {
        const result = await createMealEvent(
            pool,
            validCommand({
                provider_results: [
                    {
                        provider: "nutrition-local",
                        status: "succeeded",
                        request_fingerprint: "fp-local",
                        algorithm_version: "v1",
                        nutrients: { calories: 500 },
                    },
                    {
                        provider: "myfitnesspal",
                        status: "failed",
                        request_fingerprint: "fp-mfp",
                        algorithm_version: "v1",
                        error_code: "HTTP_500",
                        error_message: "upstream exploded",
                    },
                ],
            }),
        );
        const aggregate = await getMealEvent(pool, result.event_id);
        expect(aggregate!.event.status).toBe("active");
        const failed = aggregate!.provider_results.find(
            (r) => r.provider === "myfitnesspal",
        );
        expect(failed!.status).toBe("failed");
        expect(failed!.error_code).toBe("HTTP_500");
        // The failed result is excluded from consensus, not read as zero.
        expect(Number(aggregate!.canonical!.calories)).toBe(500);
    });
});

describeDb("meal event corrections (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await prepareFreshDb(pool);
    });

    function correctionFor(eventId: string, key = "corr:1") {
        return {
            event_id: eventId,
            correction_idempotency_key: key,
            correction_reason: "portion was wrong",
            items: [
                { ordinal: 0, raw_item_text: "oatmeal 40g" },
                { ordinal: 1, raw_item_text: "banana" },
            ],
            inputs: [
                {
                    source_kind: "user_text" as const,
                    content: "actually oatmeal 40g and a banana",
                },
            ],
            media: [],
            provider_results: [],
            raw_text_snapshot: "actually oatmeal 40g and a banana",
            parser_policy_version: "policy-1",
            created_by: "test",
        };
    }

    test("correction: creates version 2 and advances current_version atomically", async () => {
        const created = await createMealEvent(pool, validCommand());
        const corrected = await correctMealEvent(
            pool,
            correctionFor(created.event_id),
        );
        expect(corrected.deduplicated).toBe(false);
        expect(corrected.version).toBe(2);

        const current = await getMealEvent(pool, created.event_id);
        expect(current!.event.current_version).toBe(2);
        expect(current!.version.version).toBe(2);
        expect(current!.items[0]!.raw_item_text).toBe("oatmeal 40g");
        expect(current!.version.correction_reason).toBe("portion was wrong");
    });

    test("correction: version 1 rows and raw inputs remain unchanged", async () => {
        const created = await createMealEvent(pool, validCommand());
        await correctMealEvent(pool, correctionFor(created.event_id));

        const v1 = await getMealEvent(pool, created.event_id, 1);
        expect(v1!.items.map((i) => i.raw_item_text)).toEqual([
            "oatmeal 80g",
            "banana",
        ]);
        expect(v1!.inputs[0]!.content).toBe("oatmeal 80g and a banana");
    });

    test("correction: reads default to current version; history returns both", async () => {
        const created = await createMealEvent(pool, validCommand());
        await correctMealEvent(pool, correctionFor(created.event_id));

        const current = await getMealEvent(pool, created.event_id);
        expect(current!.version.version).toBe(2);

        const history = await getMealEventHistory(pool, created.event_id);
        expect(history.map((v) => v.version)).toEqual([1, 2]);
        expect(history[1]!.correction_idempotency_key).toBe("corr:1");
    });

    test("correction: repeated correction fingerprint returns version 2, never version 3", async () => {
        const created = await createMealEvent(pool, validCommand());
        await correctMealEvent(pool, correctionFor(created.event_id));
        const repeated = await correctMealEvent(
            pool,
            correctionFor(created.event_id),
        );
        expect(repeated.deduplicated).toBe(true);
        expect(repeated.version).toBe(2);

        expect(await tableCount(pool, "meal_event_versions")).toBe(2);
        const current = await getMealEvent(pool, created.event_id);
        expect(current!.event.current_version).toBe(2);
    });

    test("correction: a failed correction leaves version 1 current with no partial version 2", async () => {
        const created = await createMealEvent(pool, validCommand());
        const broken = {
            ...correctionFor(created.event_id),
            provider_results: [
                {
                    provider: "usda" as never, // CHECK violation mid-transaction
                    status: "succeeded" as const,
                    request_fingerprint: "fp-bad",
                    algorithm_version: "v1",
                    nutrients: { calories: 1 },
                },
            ],
        };
        await expect(correctMealEvent(pool, broken)).rejects.toThrow();

        const current = await getMealEvent(pool, created.event_id);
        expect(current!.event.current_version).toBe(1);
        expect(await tableCount(pool, "meal_event_versions")).toBe(1);
        expect(await tableCount(pool, "meal_event_items")).toBe(2);
    });
});

describeDb("canonical persistence (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await prepareFreshDb(pool);
    });

    function providerResult(
        provider: "nutrition-local" | "own" | "myfitnesspal",
        calories: number,
        extra: Record<string, unknown> = {},
    ) {
        return {
            provider,
            status: "succeeded" as const,
            request_fingerprint: `fp-${provider}`,
            algorithm_version: "v1",
            nutrients: { calories },
            ...extra,
        };
    }

    test("two agree plus one outlier: canonical averages the pair and records the outlier", async () => {
        const result = await createMealEvent(
            pool,
            validCommand({
                provider_results: [
                    providerResult("nutrition-local", 500),
                    providerResult("own", 510),
                    providerResult("myfitnesspal", 900),
                ],
            }),
        );
        const aggregate = await getMealEvent(pool, result.event_id);
        const canonical = aggregate!.canonical!;
        expect(canonical.consensus_status).toBe("two_agree_one_outlier");
        expect(canonical.status).toBe("ready");
        expect(Number(canonical.calories)).toBe(505);
        expect(canonical.outlier_providers).toEqual(["myfitnesspal"]);
        expect(canonical.eligible_providers).toEqual([
            "nutrition-local",
            "own",
        ]);
    });

    test("no agreeing pair: canonical persists no_consensus with the mean of all eligible", async () => {
        const result = await createMealEvent(
            pool,
            validCommand({
                provider_results: [
                    providerResult("nutrition-local", 500),
                    providerResult("own", 700),
                    providerResult("myfitnesspal", 900),
                ],
            }),
        );
        const aggregate = await getMealEvent(pool, result.event_id);
        const canonical = aggregate!.canonical!;
        expect(canonical.consensus_status).toBe("no_consensus");
        expect(canonical.status).toBe("low_confidence");
        expect(Number(canonical.calories)).toBe(700);
        expect(canonical.outlier_providers).toEqual([]);
    });

    test("one usable provider: low_confidence, value as-is, missing nutrients stay NULL", async () => {
        const result = await createMealEvent(
            pool,
            validCommand({
                provider_results: [
                    providerResult("nutrition-local", 500),
                    {
                        provider: "own" as const,
                        status: "failed" as const,
                        request_fingerprint: "fp-own",
                        algorithm_version: "v1",
                        error_code: "HTTP_500",
                    },
                    {
                        provider: "myfitnesspal" as const,
                        status: "unavailable" as const,
                        request_fingerprint: "fp-mfp",
                        algorithm_version: "v1",
                    },
                ],
            }),
        );
        const aggregate = await getMealEvent(pool, result.event_id);
        const canonical = aggregate!.canonical!;
        expect(canonical.status).toBe("low_confidence");
        expect(canonical.consensus_status).toBe("insufficient_data");
        // The single real value is reported as-is — nothing is invented.
        expect(Number(canonical.calories)).toBe(500);
        // NULL is unavailable: missing nutrients are never persisted as zero.
        expect(canonical.protein_g).toBeNull();
        expect(canonical.carbs_g).toBeNull();
        expect(canonical.fat_g).toBeNull();
        expect(canonical.fiber_g).toBeNull();
        expect(canonical.sugar_g).toBeNull();
        expect(canonical.alcohol_g).toBeNull();
        // The persisted provider rows keep NULL too, not fabricated zeros.
        const { rows } = await pool.query(
            `SELECT protein_g FROM meal_event_nutrition_results
             WHERE event_id = $1 AND provider = 'nutrition-local'`,
            [result.event_id],
        );
        expect(rows[0]!.protein_g).toBeNull();
    });

    test("item scope: per-item provider results persist a per-item canonical row", async () => {
        const result = await createMealEvent(
            pool,
            validCommand({
                provider_results: [
                    // Event scope: aggregate across the whole meal.
                    providerResult("nutrition-local", 500),
                    providerResult("own", 510),
                    // Item scope (ordinal 0): the oatmeal alone.
                    providerResult("nutrition-local", 300, { ordinal: 0 }),
                    providerResult("own", 306, { ordinal: 0 }),
                ],
            }),
        );
        const { rows } = await pool.query(
            `SELECT ordinal, scope_key, status, consensus_status, calories
             FROM meal_event_canonical_results
             WHERE event_id = $1 ORDER BY scope_key`,
            [result.event_id],
        );
        expect(rows.length).toBe(2);
        const eventRow = rows.find((r) => r.scope_key === "event")!;
        const itemRow = rows.find((r) => r.scope_key === "item:0")!;
        expect(eventRow.ordinal).toBeNull();
        expect(Number(eventRow.calories)).toBe(505);
        expect(itemRow.ordinal).toBe(0);
        expect(itemRow.consensus_status).toBe("all_agree");
        expect(Number(itemRow.calories)).toBe(303);
    });
});

describeDb(
    "sync journal and add authorization (requires DATABASE_URL_TEST)",
    () => {
        let pool: Pool;

        beforeAll(() => {
            pool = new Pool({ connectionString: DATABASE_URL_TEST });
        });

        afterAll(async () => {
            await pool.end();
        });

        beforeEach(async () => {
            await prepareFreshDb(pool);
        });

        test("journal: authorized add intent inserts one pending row before any external call", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const aggregate = await getMealEvent(pool, created.event_id);
            expect(aggregate!.event.external_write_authorized).toBe(true);
            expect(aggregate!.journal.length).toBe(1);
            const entry = aggregate!.journal[0]!;
            expect(entry.system).toBe("myfitnesspal");
            expect(entry.operation).toBe("create_meal_event");
            expect(entry.state).toBe("pending");
            expect(entry.authorization_source).toBe("explicit_add_intent");
            expect(entry.attempts).toBe(0);
        });

        test("journal: absent authorization creates no external-write journal row", async () => {
            const created = await createMealEvent(pool, validCommand());
            const aggregate = await getMealEvent(pool, created.event_id);
            expect(aggregate!.journal.length).toBe(0);
            expect(await tableCount(pool, "meal_event_sync_journal")).toBe(0);
        });

        test("journal: replayed create with the same key never duplicates the journal row", async () => {
            const command = validCommand({ external_write_authorized: true });
            await createMealEvent(pool, command);
            const replay = await createMealEvent(pool, command);
            expect(replay.deduplicated).toBe(true);
            expect(await tableCount(pool, "meal_event_sync_journal")).toBe(1);
        });

        test("journal: injected external failure marks the row failed and keeps local state intact", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const aggregate = await getMealEvent(pool, created.event_id);
            const entry = aggregate!.journal[0]!;

            // No real network in this slice: a fake writer outcome is recorded
            // through the state machine, exactly as a future worker would.
            await markJournalInFlight(pool, entry.id);
            await recordJournalFailure(
                pool,
                entry.id,
                "simulated upstream 500",
            );

            const updated = await getJournalEntry(
                pool,
                entry.system,
                entry.operation,
                entry.request_fingerprint,
            );
            expect(updated!.state).toBe("failed");
            expect(updated!.attempts).toBe(1);
            expect(updated!.last_error).toBe("simulated upstream 500");

            // The local event, version and canonical result survive sync failure.
            const after = await getMealEvent(pool, created.event_id);
            expect(after!.event.status).toBe("active");
            expect(after!.version.version).toBe(1);
            expect(after!.canonical).not.toBeNull();
        });

        test("journal: retry increments attempts without a duplicate row", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const entry = (await getMealEvent(pool, created.event_id))!
                .journal[0]!;

            await markJournalInFlight(pool, entry.id);
            await recordJournalFailure(pool, entry.id, "first failure");
            await markJournalInFlight(pool, entry.id);
            await recordJournalFailure(pool, entry.id, "second failure");

            const updated = await getJournalEntry(
                pool,
                entry.system,
                entry.operation,
                entry.request_fingerprint,
            );
            expect(updated!.attempts).toBe(2);
            expect(updated!.state).toBe("failed");
            expect(await tableCount(pool, "meal_event_sync_journal")).toBe(1);
        });

        test("journal: illegal transitions are rejected; success records external id", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const entry = (await getMealEvent(pool, created.event_id))!
                .journal[0]!;

            // pending -> succeeded is never legal: pending cannot claim success.
            await expect(
                recordJournalSuccess(pool, entry.id, "ext-1"),
            ).rejects.toThrow(/illegal sync journal transition/);

            await markJournalInFlight(pool, entry.id);
            await recordJournalSuccess(pool, entry.id, "ext-1");
            const updated = await getJournalEntry(
                pool,
                entry.system,
                entry.operation,
                entry.request_fingerprint,
            );
            expect(updated!.state).toBe("succeeded");
            expect(updated!.external_id).toBe("ext-1");
            expect(updated!.attempts).toBe(1);
        });

        test("journal: delivery drives the injectable writer and records success", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const entry = (await getMealEvent(pool, created.event_id))!
                .journal[0]!;

            const sent: Record<string, unknown>[] = [];
            const writer: ExternalWriter = {
                async send(args) {
                    sent.push(args as Record<string, unknown>);
                    return { external_id: "mfp-row-1" };
                },
            };
            await deliverJournalEntry(pool, entry.id, writer, {
                meal: "payload",
            });

            // The writer saw exactly this journal row's identity and the payload.
            expect(sent.length).toBe(1);
            expect(sent[0]!.system).toBe("myfitnesspal");
            expect(sent[0]!.operation).toBe("create_meal_event");
            expect(sent[0]!.request_fingerprint).toBe(
                entry.request_fingerprint,
            );
            expect(sent[0]!.payload).toEqual({ meal: "payload" });

            const updated = await getJournalEntry(
                pool,
                entry.system,
                entry.operation,
                entry.request_fingerprint,
            );
            expect(updated!.state).toBe("succeeded");
            expect(updated!.external_id).toBe("mfp-row-1");
            expect(updated!.attempts).toBe(1);
        });

        test("journal: a throwing writer leaves the row failed and local state intact", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({
                    external_write_authorized: true,
                    provider_results: [
                        {
                            provider: "nutrition-local",
                            status: "succeeded",
                            request_fingerprint: "fp-local",
                            algorithm_version: "v1",
                            nutrients: { calories: 500 },
                        },
                    ],
                }),
            );
            const entry = (await getMealEvent(pool, created.event_id))!
                .journal[0]!;

            const writer: ExternalWriter = {
                async send() {
                    throw new Error("simulated upstream 500");
                },
            };
            await expect(
                deliverJournalEntry(pool, entry.id, writer, {}),
            ).rejects.toThrow("simulated upstream 500");

            const updated = await getJournalEntry(
                pool,
                entry.system,
                entry.operation,
                entry.request_fingerprint,
            );
            expect(updated!.state).toBe("failed");
            expect(updated!.attempts).toBe(1);
            expect(updated!.last_error).toBe("simulated upstream 500");

            // The local event, version and canonical result survive sync failure.
            const after = await getMealEvent(pool, created.event_id);
            expect(after!.event.status).toBe("active");
            expect(after!.canonical).not.toBeNull();
            expect(Number(after!.canonical!.calories)).toBe(500);
        });

        test("journal: retry after failure re-invokes the writer without a duplicate row", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const entry = (await getMealEvent(pool, created.event_id))!
                .journal[0]!;

            const failing: ExternalWriter = {
                async send() {
                    throw new Error("first failure");
                },
            };
            await expect(
                deliverJournalEntry(pool, entry.id, failing, {}),
            ).rejects.toThrow("first failure");

            const succeeding: ExternalWriter = {
                async send() {
                    return { external_id: "mfp-row-2" };
                },
            };
            await deliverJournalEntry(pool, entry.id, succeeding, {});

            const updated = await getJournalEntry(
                pool,
                entry.system,
                entry.operation,
                entry.request_fingerprint,
            );
            expect(updated!.state).toBe("succeeded");
            expect(updated!.external_id).toBe("mfp-row-2");
            expect(updated!.attempts).toBe(2);
            expect(await tableCount(pool, "meal_event_sync_journal")).toBe(1);
        });

        test("journal: delivering a succeeded entry is rejected, never re-sent", async () => {
            const created = await createMealEvent(
                pool,
                validCommand({ external_write_authorized: true }),
            );
            const entry = (await getMealEvent(pool, created.event_id))!
                .journal[0]!;

            let calls = 0;
            const writer: ExternalWriter = {
                async send() {
                    calls++;
                    return { external_id: "mfp-row-3" };
                },
            };
            await deliverJournalEntry(pool, entry.id, writer, {});
            // Terminal state: succeeded can never go back to in_flight.
            await expect(
                deliverJournalEntry(pool, entry.id, writer, {}),
            ).rejects.toThrow(/illegal sync journal transition/);
            expect(calls).toBe(1);
        });
    },
);
