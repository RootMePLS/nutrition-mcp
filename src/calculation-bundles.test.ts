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
import {
    commitCalculationBundle,
    recomputeCalculationBundle,
} from "./calculation-bundles.js";
import {
    validateCalculationCorrection,
    CALCULATION_CORRECTION_OUTPUT_SCHEMA,
    type CalculationCorrectionMetadata,
} from "./calculation-bundles.js";
import { registerTools } from "./mcp.js";

describe("calculation bundle commit seam", () => {
    test("requires explicit confirmation and complete correction provenance", () => {
        const base: CalculationCorrectionMetadata = {
            correction_idempotency_key: "corr-1",
            correction_reason: "portion clarified",
            correction_author: "hermes",
            source_timestamp: "2026-08-05T12:00:00.000Z",
            confirmed: false,
            external_write_authorized: false,
            user_id: "u1",
        };
        expect(validateCalculationCorrection(base)).toContain(
            "explicit confirmation is required",
        );
        expect(
            validateCalculationCorrection({
                ...base,
                confirmed: true,
                correction_reason: "",
            }),
        ).toContain("correction reason is required");
        expect(
            validateCalculationCorrection({
                ...base,
                confirmed: true,
            }),
        ).toEqual([]);
        expect(
            validateCalculationCorrection({
                ...base,
                confirmed: true,
                user_id: undefined,
            }),
        ).toContain("user id is required");
    });

    test("correction output contract is strict and exposes durable result fields", () => {
        expect(CALCULATION_CORRECTION_OUTPUT_SCHEMA).toBeDefined();
        expect(
            CALCULATION_CORRECTION_OUTPUT_SCHEMA.parse({
                event_id: "00000000-0000-4000-8000-000000000001",
                version: 2,
                fingerprint: "fp",
                deduplicated: false,
                provenance_status: "ready",
                compatibility: false,
                is_current: true,
                canonical: {
                    status: "ready",
                    consensus_status: "all_agree",
                    nutrients: {
                        calories: 1,
                        protein_g: null,
                        carbs_g: null,
                        fat_g: null,
                        fiber_g: null,
                        sugar_g: null,
                        alcohol_g: null,
                    },
                    eligible_providers: [],
                    outlier_providers: [],
                    threshold_percent: 10,
                    policy_version: "p",
                    source_result_ids: ["source-1"],
                    audit_evidence: { fingerprint: "fp" },
                    algorithm_version: "p",
                },
                provider_results: [],
                item_canonicals: [],
                external_sync: "not_authorized",
            }),
        ).toMatchObject({ version: 2 });
        expect(() => CALCULATION_CORRECTION_OUTPUT_SCHEMA.parse({})).toThrow();
    });
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

    test("discovers provenance readback and correction tools", async () => {
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
            expect(listed.tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                    "get_calculation_provenance",
                    "commit_calculation_correction",
                ]),
            );
            const invalid = await client.callTool({
                name: "get_calculation_provenance",
                arguments: { event_id: "not-a-uuid" },
            });
            expect(invalid.isError).toBe(true);
        } finally {
            await client.close();
            await server.close();
        }
    });
    test("rejects calculation bundle scopes with unknown keys through MCP", async () => {
        const bundle = makeBundle();
        bundle.event_id = "00000000-0000-4000-8000-000000000001";
        bundle.fingerprint = stableBundleFingerprint(bundle);
        bundle.results[0]!.scope = { ordinal: null, unexpected: true } as never;
        const server = new McpServer(
            { name: "test", version: "0.0.0" },
            { capabilities: { tools: {}, resources: {} } },
        );
        registerTools(server, "u1", false, null, {
            mealEventsPool: {
                connect: async () => ({
                    release: () => undefined,
                }),
            } as never,
        });
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "0.0.0" });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        try {
            const result = await client.callTool({
                name: "commit_calculation_bundle",
                arguments: { bundle },
            });
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("unexpected");
        } finally {
            await client.close();
            await server.close();
        }
    });

    test("fails closed through MCP when scoped durable readback is absent", async () => {
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
                if (sql.includes("status, consensus_status"))
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
            expect(first.isError).toBe(true);
            expect(second.isError).toBe(true);
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
        let persistedFingerprint: string | null = null;
        const client = {
            query: async (sql: string, params: unknown[] = []) => {
                calls.push(sql);
                if (sql.includes("UPDATE meal_event_versions")) {
                    persistedFingerprint = String(params[2]);
                    return { rows: [] };
                }
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return {
                        rows: [
                            {
                                calculation_bundle_fingerprint:
                                    persistedFingerprint,
                            },
                        ],
                    };
                if (sql.includes("SELECT id FROM meal_event_nutrition_results"))
                    return { rows: [] };
                if (sql.includes("status, consensus_status"))
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

    test("recomputeCalculationBundle groups consensus per scope", () => {
        const input = {
            event_id: "00000000-0000-4000-8000-000000000001",
            version: 1,
            resolved_input: { items: [], inputs: [] },
            results: [
                provider("nutrition-local", "local-event", 500),
                provider("own", "own-event", 510),
                scopedProvider("nutrition-local", "local-item0", 0, 300),
                scopedProvider("own", "own-item0", 0, 306),
                scopedProvider("nutrition-local", "local-item1", 1, 200),
            ],
        } satisfies Omit<CalculationBundleInput, "fingerprint">;
        const bundle: CalculationBundleInput = {
            ...input,
            fingerprint: stableBundleFingerprint(input),
        };
        const out = recomputeCalculationBundle(bundle);
        // Event scope is computed from event-scope providers only.
        expect(out.event.nutrients.calories).toBe(505);
        expect(out.items.get(0)!.nutrients.calories).toBe(303);
        expect(out.items.get(1)!.nutrients.calories).toBe(200);
        // Item scopes never leak into the event scope and vice versa.
        expect(out.event.eligible_providers).not.toContain("myfitnesspal");
        expect(out.items.size).toBe(2);
    });

    test("rejects tampered content before persistence", async () => {
        const calls: string[] = [];
        let persistedFingerprint: string | null = null;
        const client = {
            query: async (sql: string, params: unknown[] = []) => {
                calls.push(sql);
                if (sql.includes("UPDATE meal_event_versions")) {
                    persistedFingerprint = String(params[2]);
                    return { rows: [] };
                }
                if (sql.includes("SELECT calculation_bundle_fingerprint"))
                    return {
                        rows: [
                            {
                                calculation_bundle_fingerprint:
                                    persistedFingerprint,
                            },
                        ],
                    };
                if (sql.includes("SELECT id FROM meal_event_nutrition_results"))
                    return { rows: [] };
                if (sql.includes("status, consensus_status"))
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
        raw_payload: { source_id, calories },
    };
}
