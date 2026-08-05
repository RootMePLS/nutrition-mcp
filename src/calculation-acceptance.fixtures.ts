import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pool, type PoolClient } from "pg";
import { type CalculationCorrectionMetadata } from "./calculation-bundles.js";
import { registerTools } from "./mcp.js";
import {
    stableBundleFingerprint,
    type CalculationBundleInput,
} from "./nutrition-bundle-types.js";

// ---------------------------------------------------------------------------
// S2 test-only acceptance fixtures: shared event ids, seeders, scoped bundle
// builders, correction metadata, table-count helpers, and the real MCP
// transport harness used by calculation-acceptance.integration.test.ts.
// Nothing in this module is imported by production code.
// ---------------------------------------------------------------------------

export const EVENT = {
    concurrentBundles: "00000000-0000-4000-8000-000000000201",
    concurrentCorrections: "00000000-0000-4000-8000-000000000202",
    migrationRerun: "00000000-0000-4000-8000-000000000203",
    correctionRollback: "00000000-0000-4000-8000-000000000204",
    staleVersion: "00000000-0000-4000-8000-000000000205",
    crossUser: "00000000-0000-4000-8000-000000000206",
    mcpCorrection: "00000000-0000-4000-8000-000000000207",
    failedProvider: "00000000-0000-4000-8000-000000000208",
} as const;

export async function seedEvent(
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

export function scopedProvider(
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
export function makeScopedBundle(
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
export function makeScopedCorrection(
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

export function correctionMetadata(
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

export interface TableCounts {
    versions: string;
    results: string;
    canonical: string;
}

export async function eventTableCounts(
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

export interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

export async function withTools(
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
