import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { commitCalculationBundle } from "./calculation-bundles.js";
import { correctMealEvent, createMealEvent } from "./meal-events.js";
import { registerTools } from "./mcp.js";
import type { MealEventItemInput, MealType } from "./meal-types.js";
import {
    stableBundleFingerprint,
    type CalculationBundleInput,
    type ProviderCalculationResult,
} from "./nutrition-bundle-types.js";

// ---------------------------------------------------------------------------
// Slice 3 test-only fixtures: seed reusable-meal discovery corpora through the
// REAL write paths (createMealEvent / correctMealEvent / commitCalculationBundle)
// so persisted truth is never hand-forged. Nothing in this module is imported
// by production code.
// ---------------------------------------------------------------------------

export interface SeedMealOptions {
    idempotencyKey: string;
    /** ISO timestamp; also used as reported_at. */
    consumedAt: string;
    items: MealEventItemInput[];
    mealType?: MealType | null;
}

/** Plain meal event with no bundle: provenance derives as pending. */
export async function seedMealEvent(
    pool: Pool,
    userId: string,
    opts: SeedMealOptions,
): Promise<string> {
    const result = await createMealEvent(pool, {
        user_id: userId,
        idempotency_key: opts.idempotencyKey,
        reported_at: opts.consumedAt,
        consumed_at: opts.consumedAt,
        meal_type: opts.mealType ?? "breakfast",
        items: opts.items,
        inputs: [
            {
                source_kind: "user_text",
                content: opts.items
                    .map((item) => item.raw_item_text)
                    .join(", "),
            },
        ],
        media: [],
        provider_results: [],
        parser_policy_version: "reuse-fixture",
        created_by: "reuse-fixture",
    });
    return result.event_id;
}

function bundleProvider(
    provider: "nutrition-local" | "own" | "myfitnesspal",
    sourceId: string,
    calories: number,
    // Slice 7: optional full nutrient override so canonical rows can carry
    // explicit zeros and absent (NULL) fields instead of the default set.
    nutrientsOverride?: Record<string, number | null>,
): ProviderCalculationResult {
    const nutrients = nutrientsOverride ?? {
        calories,
        protein_g: 20,
        carbs_g: 60,
        fat_g: 15,
    };
    return {
        provider,
        status: "succeeded",
        scope: { ordinal: null },
        source_id: sourceId,
        request_fingerprint: `${provider}-request-${sourceId}`,
        algorithm_version: "v1",
        basis: "per_meal",
        units: "g_and_kcal",
        nutrients,
        raw_payload: { provider, source_id: sourceId, calories },
        provenance: { provider, retrieved_at: "2026-08-05T12:00:00Z" },
    };
}

/**
 * All three expected providers succeeded at event scope with agreeing
 * nutrients: the committed version derives provenance_status "ready".
 */
export function readyBundle(
    eventId: string,
    version: number,
    nutrientsOverride?: Record<string, number | null>,
): CalculationBundleInput {
    const input = {
        event_id: eventId,
        version,
        resolved_input: {
            items: [{ ordinal: 0, raw_item_text: "seeded item" }],
            inputs: [],
        },
        results: [
            bundleProvider(
                "nutrition-local",
                `local-${eventId.slice(0, 8)}`,
                500,
                nutrientsOverride,
            ),
            bundleProvider(
                "own",
                `own-${eventId.slice(0, 8)}`,
                500,
                nutrientsOverride,
            ),
            bundleProvider(
                "myfitnesspal",
                `mfp-${eventId.slice(0, 8)}`,
                500,
                nutrientsOverride,
            ),
        ],
    };
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

/** Same recipe with one provider unavailable: provenance "unavailable". */
export function unavailableBundle(
    eventId: string,
    version: number,
): CalculationBundleInput {
    const input = {
        event_id: eventId,
        version,
        resolved_input: {
            items: [{ ordinal: 0, raw_item_text: "seeded item" }],
            inputs: [],
        },
        results: [
            bundleProvider(
                "nutrition-local",
                `local-${eventId.slice(0, 8)}`,
                500,
            ),
            bundleProvider("own", `own-${eventId.slice(0, 8)}`, 500),
            {
                provider: "myfitnesspal" as const,
                status: "unavailable" as const,
                scope: { ordinal: null },
                source_id: `mfp-${eventId.slice(0, 8)}`,
                request_fingerprint: `myfitnesspal-request-mfp-${eventId.slice(0, 8)}`,
                algorithm_version: "v1",
                basis: "per_meal" as const,
                units: "g_and_kcal" as const,
                nutrients: {},
                raw_payload: { provider: "myfitnesspal" },
                provenance: {
                    provider: "myfitnesspal",
                    retrieved_at: "2026-08-05T12:00:00Z",
                },
                error_code: "upstream_503",
                error_message: "provider unavailable",
            },
        ],
    };
    return { ...input, fingerprint: stableBundleFingerprint(input) };
}

export async function commitBundle(
    pool: Pool,
    userId: string,
    bundle: CalculationBundleInput,
): Promise<void> {
    await commitCalculationBundle(pool, bundle, { user_id: userId });
}

/** Correction creating version 2 with replacement items. */
export async function correctMeal(
    pool: Pool,
    userId: string,
    eventId: string,
    opts: {
        correctionKey: string;
        items: MealEventItemInput[];
        consumedAt?: string;
    },
): Promise<void> {
    await correctMealEvent(pool, {
        event_id: eventId,
        user_id: userId,
        correction_idempotency_key: opts.correctionKey,
        correction_reason: "slice 3 fixture correction",
        items: opts.items,
        inputs: [
            {
                source_kind: "user_text",
                content: opts.items
                    .map((item) => item.raw_item_text)
                    .join(", "),
            },
        ],
        media: [],
        provider_results: [],
        consumed_at: opts.consumedAt ?? null,
        parser_policy_version: "reuse-fixture",
        created_by: "reuse-fixture",
    });
}

/** Shipped deleteMeal semantics: status tombstone, rows retained. */
export async function deleteMealEvent(
    pool: Pool,
    userId: string,
    eventId: string,
): Promise<void> {
    await pool.query(
        `UPDATE meal_events SET status = 'deleted', deleted_at = now()
         WHERE id = $1 AND user_id = $2`,
        [eventId, userId],
    );
}

/** Seed `count` identical-description events spread dayStart..dayEnd days before `now`. */
export async function seedVariationCorpus(
    pool: Pool,
    userId: string,
    args: {
        keyPrefix: string;
        itemText: string;
        count: number;
        now: string;
        dayStart: number;
        dayEnd: number;
    },
): Promise<string[]> {
    const ids: string[] = [];
    const nowMs = Date.parse(args.now);
    const span = args.dayEnd - args.dayStart;
    for (let i = 0; i < args.count; i++) {
        const daysAgo =
            args.dayStart +
            (args.count === 1 ? 0 : (span * i) / (args.count - 1));
        const consumedAt = new Date(
            nowMs - daysAgo * 24 * 60 * 60 * 1000,
        ).toISOString();
        ids.push(
            await seedMealEvent(pool, userId, {
                idempotencyKey: `${args.keyPrefix}-${i}`,
                consumedAt,
                items: [
                    {
                        ordinal: 0,
                        raw_item_text: args.itemText,
                        normalized_name: args.itemText,
                    },
                ],
            }),
        );
    }
    return ids;
}

// Domain tables a read-only discovery path must never write (D8). Telemetry
// (tool_analytics) is intentionally excluded.
export const REUSE_DOMAIN_TABLES = [
    "meal_events",
    "meal_event_versions",
    "meal_event_items",
    "meal_event_nutrition_results",
    "meal_event_canonical_results",
    "meal_event_reuse_sources",
    "meal_event_reuse_provider_sources",
    "supplement_products",
    "supplement_product_versions",
    "supplement_product_aliases",
    "supplement_product_nutrients",
    "supplement_product_label_limits",
    "supplement_regimens",
    "supplement_intake_events",
    "supplement_intake_nutrient_snapshots",
    "supplement_intake_meal_links",
] as const;

export async function domainTableCounts(
    pool: Pool,
): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of REUSE_DOMAIN_TABLES) {
        const { rows } = await pool.query(
            `SELECT count(*)::int AS count FROM ${table}`,
        );
        counts[table] = Number(rows[0]!.count);
    }
    return counts;
}

export interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

export interface ListedTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
}

export interface ToolContext {
    call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
    listTools: () => Promise<ListedTool[]>;
}

// Clone of the proven InMemoryTransport harness (mcp-supplements), with the
// registered user as a parameter so u1/u2 isolation is tested through the
// public path.
export async function withReuseTools(
    pool: Pool,
    userId: string,
    run: (ctx: ToolContext) => Promise<void>,
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-reuse-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, userId, false, null, { mealEventsPool: pool });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({
        name: "reuse-test-client",
        version: "0.0.0",
    });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        await run({
            call: (name, args = {}) =>
                client.callTool({
                    name,
                    arguments: args,
                }) as Promise<ToolResult>,
            listTools: async () =>
                (await client.listTools()).tools as ListedTool[],
        });
    } finally {
        await client.close();
        await server.close();
    }
}

// ---------------------------------------------------------------------------
// Slice 4 test-only fixtures: full-row source snapshots (byte-identical
// before/after proofs) and reuse command builders.
// ---------------------------------------------------------------------------

import type { ReuseMealCalculationCommand } from "./meal-reuse.js";

/** Full-row snapshot of one persisted aggregate for mutation-freedom proofs. */
export async function snapshotAggregate(
    pool: Pool,
    eventId: string,
    version: number,
): Promise<{
    root: Record<string, unknown> | null;
    version: Record<string, unknown> | null;
    items: Record<string, unknown>[];
    provider_results: Record<string, unknown>[];
    canonical_results: Record<string, unknown>[];
    inputs: Record<string, unknown>[];
    media: Record<string, unknown>[];
}> {
    const root = await pool.query(`SELECT * FROM meal_events WHERE id = $1`, [
        eventId,
    ]);
    const versionRow = await pool.query(
        `SELECT * FROM meal_event_versions WHERE event_id = $1 AND version = $2`,
        [eventId, version],
    );
    const items = await pool.query(
        `SELECT * FROM meal_event_items
         WHERE event_id = $1 AND version = $2 ORDER BY ordinal`,
        [eventId, version],
    );
    const providers = await pool.query(
        `SELECT * FROM meal_event_nutrition_results
         WHERE event_id = $1 AND version = $2 ORDER BY provider, ordinal`,
        [eventId, version],
    );
    const canonicals = await pool.query(
        `SELECT * FROM meal_event_canonical_results
         WHERE event_id = $1 AND version = $2 ORDER BY ordinal`,
        [eventId, version],
    );
    const inputs = await pool.query(
        `SELECT * FROM meal_event_inputs
         WHERE event_id = $1 AND version = $2 ORDER BY precedence`,
        [eventId, version],
    );
    const media = await pool.query(
        `SELECT * FROM meal_event_media WHERE event_id = $1 AND version = $2`,
        [eventId, version],
    );
    return {
        root: root.rows[0] ?? null,
        version: versionRow.rows[0] ?? null,
        items: items.rows,
        provider_results: providers.rows,
        canonical_results: canonicals.rows,
        inputs: inputs.rows,
        media: media.rows,
    };
}

/** Reuse command builder with deterministic fresh occurrence timestamps. */
export function reuseCommand(
    overrides: Partial<ReuseMealCalculationCommand> &
        Pick<ReuseMealCalculationCommand, "source_event_id">,
): ReuseMealCalculationCommand {
    return {
        user_id: "u1",
        source_version: 1,
        reported_at: "2026-08-06T13:00:00.000Z",
        consumed_at: "2026-08-06T12:30:00.000Z",
        idempotency_key: "reuse-key-1",
        created_by: "reuse_meal_calculation",
        ...overrides,
    };
}
