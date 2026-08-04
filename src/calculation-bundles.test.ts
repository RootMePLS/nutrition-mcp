import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { computeConsensus } from "./meal-consensus.js";
import {
    stableBundleFingerprint,
    validateCalculationBundle,
    type CalculationBundleInput,
} from "./nutrition-bundle-types.js";
import { commitCalculationBundle } from "./calculation-bundles.js";
import { registerTools } from "./mcp.js";

describe("calculation bundle commit seam", () => {
    test("discovers additive commit tool and rejects malformed bundles", async () => {
        const server = new McpServer(
            { name: "test", version: "0.0.0" },
            { capabilities: { tools: {}, resources: {} } },
        );
        registerTools(server, "u1", false, null, {
            mealEventsPool: { connect: async () => ({}) } as never,
        });
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "0.0.0" });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        try {
            const listed = await client.listTools();
            expect(listed.tools.map((tool) => tool.name)).toContain(
                "commit_calculation_bundle",
            );
            const result = await client.callTool({
                name: "commit_calculation_bundle",
                arguments: { bundle: null },
            });
            expect(result.isError).toBe(true);
        } finally {
            await client.close();
            await server.close();
        }
    });

    test("calls the commit tool through MCP and returns idempotent retries", async () => {
        const bundle = makeBundle();
        bundle.event_id = "00000000-0000-4000-8000-000000000001";
        bundle.fingerprint = stableBundleFingerprint(bundle);
        let committed = false;
        const clientImpl = {
            query: async (sql: string) => {
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return {
                        rows: [
                            {
                                calculation_bundle_fingerprint: committed
                                    ? bundle.fingerprint
                                    : null,
                            },
                        ],
                    };
                if (sql.includes("SELECT status, consensus_status"))
                    return {
                        rows: [
                            {
                                status: "ready",
                                consensus_status: "all_agree",
                                calories: "505",
                                protein_g: null,
                                carbs_g: null,
                                fat_g: null,
                                fiber_g: null,
                                sugar_g: null,
                                alcohol_g: null,
                                eligible_providers: ["nutrition-local", "own"],
                                outlier_providers: [],
                                threshold_percent: "10",
                                policy_version: "consensus-10pct-v1",
                            },
                        ],
                    };
                if (sql.includes("UPDATE meal_event_versions"))
                    committed = true;
                return { rows: [] };
            },
            release: () => undefined,
        };
        const server = new McpServer(
            { name: "test", version: "0.0.0" },
            { capabilities: { tools: {}, resources: {} } },
        );
        registerTools(server, "u1", false, null, {
            mealEventsPool: { connect: async () => clientImpl } as never,
        });
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "0.0.0" });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        try {
            const first = await client.callTool({
                name: "commit_calculation_bundle",
                arguments: { bundle },
            });
            const second = await client.callTool({
                name: "commit_calculation_bundle",
                arguments: { bundle },
            });
            expect(first.isError).not.toBe(true);
            expect(second.isError).not.toBe(true);
            const firstText = (first.content as { text: string }[])[0]!.text;
            const secondText = (second.content as { text: string }[])[0]!.text;
            expect(JSON.parse(firstText).deduplicated).toBe(false);
            expect(JSON.parse(secondText).deduplicated).toBe(true);
        } finally {
            await client.close();
            await server.close();
        }
    });

    test("fails closed for malformed runtime results without throwing", () => {
        const malformedResults = [
            null,
            1,
            "result",
            {},
            { provider: "nutrition-local", status: "succeeded" },
            {
                provider: "nutrition-local",
                status: "succeeded",
                scope: null,
            },
            {
                provider: "nutrition-local",
                status: "succeeded",
                scope: {},
                nutrients: { calories: "not-a-number" },
                raw_payload: null,
            },
        ];
        for (const result of malformedResults) {
            expect(() =>
                validateCalculationBundle({
                    ...makeBundle(),
                    results: [result] as never,
                } as never),
            ).not.toThrow();
            expect(
                validateCalculationBundle({
                    ...makeBundle(),
                    results: [result] as never,
                } as never),
            ).toEqual(expect.arrayContaining([expect.any(String)]));
        }
    });

    test("recomputes canonical and persists source IDs and raw provenance atomically", async () => {
        const calls: string[] = [];
        const client = {
            query: async (sql: string) => {
                calls.push(sql);
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return { rows: [{ calculation_bundle_fingerprint: null }] };
                if (sql.includes("SELECT id FROM meal_event_nutrition_results"))
                    return { rows: [] };
                if (sql.includes("SELECT status, consensus_status"))
                    return {
                        rows: [
                            {
                                status: "ready",
                                consensus_status: "all_agree",
                                calories: "505",
                                protein_g: null,
                                carbs_g: null,
                                fat_g: null,
                                fiber_g: null,
                                sugar_g: null,
                                alcohol_g: null,
                                eligible_providers: ["nutrition-local", "own"],
                                outlier_providers: [],
                                threshold_percent: "10",
                                policy_version: "consensus-10pct-v1",
                            },
                        ],
                    };
                return { rows: [] };
            },
            release: () => undefined,
        };
        const pool = { connect: async () => client } as never;
        const bundle = makeBundle();
        const result = await commitCalculationBundle(pool, bundle);
        expect(result.canonical.nutrients.calories).toBe(505);
        expect(result.canonical.nutrients.calories).not.toBe(9999);
    });

    test("rejects tampered content before persistence", async () => {
        const calls: string[] = [];
        const client = {
            query: async (sql: string) => {
                calls.push(sql);
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return { rows: [{ calculation_bundle_fingerprint: null }] };
                if (sql.includes("SELECT id FROM meal_event_nutrition_results"))
                    return { rows: [] };
                if (sql.includes("SELECT status, consensus_status"))
                    return {
                        rows: [
                            {
                                status: "ready",
                                consensus_status: "all_agree",
                                calories: "505",
                                protein_g: null,
                                carbs_g: null,
                                fat_g: null,
                                fiber_g: null,
                                sugar_g: null,
                                alcohol_g: null,
                                eligible_providers: ["nutrition-local", "own"],
                                outlier_providers: [],
                                threshold_percent: "10",
                                policy_version: "consensus-10pct-v1",
                            },
                        ],
                    };
                return { rows: [] };
            },
            release: () => undefined,
        };
        const pool = { connect: async () => client } as never;
        const bundle = makeBundle();
        bundle.results[0]!.source_id = "tampered";
        await expect(commitCalculationBundle(pool, bundle)).rejects.toThrow(
            /fingerprint/,
        );
    });
});

function makeBundle(): CalculationBundleInput {
    const input = {
        event_id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        resolved_input: { items: [], inputs: [] },
        results: [
            provider("nutrition-local", "local-source", 500),
            provider("own", "own-source", 510),
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
        raw_payload: { source_id, calories },
    };
}
