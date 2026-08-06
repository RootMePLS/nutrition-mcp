import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "./db.js";
import { computeConsensus, type ConsensusOutcome } from "./meal-consensus.js";
import { readPersistedWriteStatus } from "./meal-events.js";
import { NUTRIENT_FIELDS, type NutrientField } from "./meal-types.js";
import {
    stableBundleFingerprint,
    validateCalculationBundle,
    type CalculationBundleInput,
    type ProviderCalculationResult,
} from "./nutrition-bundle-types.js";

export class CalculationBundleValidationError extends Error {
    constructor(public readonly issues: string[]) {
        super(`invalid calculation bundle: ${issues.join("; ")}`);
        this.name = "CalculationBundleValidationError";
    }
}

export interface CalculationBundleCommitOptions {
    /** Test-only seam for proving the bundle transaction remains atomic. */
    beforeCommit?: () => Promise<void>;
    /** Authenticated owner for public bundle commits. */
    user_id?: string;
}

export interface CalculationBundleCommitResult {
    event_id: string;
    version: number;
    fingerprint: string;
    deduplicated: boolean;
    canonical: ReturnType<typeof computeConsensus>;
}

export interface CalculationCorrectionMetadata {
    correction_idempotency_key: string;
    correction_reason: string;
    correction_author: string;
    source_timestamp: string;
    confirmed: boolean;
    external_write_authorized: boolean;
    user_id?: string;
}

const PROVIDER_OUTPUT_SCHEMA = z
    .object({
        id: z.string().uuid(),
        ordinal: z.number().int().min(0).nullable(),
        provider: z.enum(["nutrition-local", "own", "myfitnesspal"]),
        status: z.enum(["succeeded", "failed", "unavailable"]),
        source_id: z.string().min(1).nullable(),
        request_fingerprint: z.string().min(1),
        algorithm_version: z.string().min(1),
        raw_payload: z.record(z.string(), z.unknown()),
        provenance: z.record(z.string(), z.unknown()),
        basis: z
            .enum(["per_item", "per_meal", "per_100g", "serving"])
            .nullable(),
        units: z.literal("g_and_kcal").nullable(),
        nutrients: z
            .object(
                Object.fromEntries(
                    NUTRIENT_FIELDS.map((field) => [
                        field,
                        z.number().nullable(),
                    ]),
                ) as unknown as Record<NutrientField, z.ZodTypeAny>,
            )
            .strict(),
        error_code: z.string().nullable(),
        error_message: z.string().nullable(),
    })
    .strict();

const CANONICAL_OUTPUT_SCHEMA = z
    .object({
        status: z.enum(["pending", "ready", "low_confidence"]),
        consensus_status: z.enum([
            "two_agree_one_outlier",
            "all_agree",
            "no_consensus",
            "insufficient_data",
        ]),
        nutrients: z
            .object(
                Object.fromEntries(
                    NUTRIENT_FIELDS.map((field) => [
                        field,
                        z.number().nullable(),
                    ]),
                ) as unknown as Record<NutrientField, z.ZodTypeAny>,
            )
            .strict(),
        eligible_providers: z.array(
            z.enum(["nutrition-local", "own", "myfitnesspal"]),
        ),
        outlier_providers: z.array(
            z.enum(["nutrition-local", "own", "myfitnesspal"]),
        ),
        threshold_percent: z.number(),
        policy_version: z.string().min(1),
        source_result_ids: z.array(z.string().min(1)).nullable(),
        audit_evidence: z.record(z.string(), z.unknown()).nullable(),
        algorithm_version: z.string().min(1).nullable(),
    })
    .strict();

const ITEM_CANONICAL_OUTPUT_SCHEMA = CANONICAL_OUTPUT_SCHEMA.extend({
    ordinal: z.number().int().min(0),
});

export const CALCULATION_BUNDLE_OUTPUT_SCHEMA = z
    .object({
        event_id: z.string().uuid(),
        version: z.number().int().min(1),
        fingerprint: z.string().nullable(),
        deduplicated: z.boolean(),
        provenance_status: z.enum([
            "ready",
            "pending",
            "unavailable",
            "missing",
        ]),
        compatibility: z.boolean(),
        is_current: z.boolean(),
        provider_results: z.array(PROVIDER_OUTPUT_SCHEMA),
        canonical: CANONICAL_OUTPUT_SCHEMA.nullable(),
        item_canonicals: z.array(ITEM_CANONICAL_OUTPUT_SCHEMA),
        external_sync: z.enum(["not_authorized", "pending"]),
    })
    .strict();

export const CALCULATION_CORRECTION_OUTPUT_SCHEMA =
    CALCULATION_BUNDLE_OUTPUT_SCHEMA.extend({
        prior_version: z.number().int().min(1),
        correction_reason: z.string().min(1),
        correction_author: z.string().min(1),
    }).strict();

export const CALCULATION_PROVENANCE_OUTPUT_SCHEMA = z
    .object({
        event_id: z.string().uuid(),
        version: z.number().int().min(1),
        current_version: z.number().int().min(1),
        is_current: z.boolean(),
        provenance_status: z.enum([
            "ready",
            "pending",
            "unavailable",
            "missing",
        ]),
        compatibility: z.boolean(),
        bundle_fingerprint: z.string().nullable(),
        providers: z.array(
            CALCULATION_BUNDLE_OUTPUT_SCHEMA.shape.provider_results.element,
        ),
        canonical: CANONICAL_OUTPUT_SCHEMA.nullable(),
        item_canonicals: z.array(ITEM_CANONICAL_OUTPUT_SCHEMA),
    })
    .strict();

export type CalculationBundleOutput = z.infer<
    typeof CALCULATION_BUNDLE_OUTPUT_SCHEMA
>;

export function validateCalculationCorrection(
    metadata: CalculationCorrectionMetadata,
): string[] {
    const issues: string[] = [];
    if (!metadata.correction_idempotency_key?.trim())
        issues.push("correction idempotency key is required");
    if (!metadata.correction_reason?.trim())
        issues.push("correction reason is required");
    if (!metadata.correction_author?.trim())
        issues.push("correction author is required");
    if (
        !metadata.source_timestamp ||
        Number.isNaN(Date.parse(metadata.source_timestamp))
    )
        issues.push("source timestamp must be a valid date");
    if (metadata.confirmed !== true)
        issues.push("explicit confirmation is required");
    if (!metadata.user_id?.trim()) issues.push("user id is required");
    return issues;
}

function nutrientValues(
    nutrients: Partial<Record<NutrientField, number | null>>,
) {
    return NUTRIENT_FIELDS.map((field) => nutrients[field] ?? null);
}

export interface PerScopeConsensus {
    /** Consensus over event-scope (ordinal NULL) provider results only. */
    event: ConsensusOutcome;
    /** One consensus per item ordinal present in the bundle results. */
    items: Map<number, ConsensusOutcome>;
}

/**
 * Compute consensus independently for the event scope and each item ordinal.
 * Item values never enter the event consensus and vice versa.
 */
export function recomputeCalculationBundle(
    bundle: CalculationBundleInput,
): PerScopeConsensus {
    const scopes = new Map<number | null, ProviderCalculationResult[]>();
    for (const result of bundle.results) {
        const scope = result.scope.ordinal ?? null;
        const group = scopes.get(scope) ?? [];
        group.push(result);
        scopes.set(scope, group);
    }
    const toConsensus = (
        results: ProviderCalculationResult[] | undefined,
    ): ConsensusOutcome =>
        computeConsensus(
            (results ?? []).map((result) => ({
                provider: result.provider,
                status: result.status,
                nutrients: result.nutrients,
            })),
        );
    const items = new Map<number, ConsensusOutcome>();
    for (const [scope, results] of scopes) {
        if (scope !== null) items.set(scope, toConsensus(results));
    }
    return { event: toConsensus(scopes.get(null)), items };
}

/**
 * Persist one canonical row per scope (event + each item ordinal). Each row's
 * source_result_ids are selected only from succeeded provider rows of the
 * SAME scope (`ordinal IS NOT DISTINCT FROM $3`).
 */
async function persistCanonicalPerScope(
    client: PoolClient,
    eventId: string,
    version: number,
    perScope: PerScopeConsensus,
    auditEvidence: (
        scope: number | null,
        consensus: ConsensusOutcome,
        sourceResultIds: string[],
    ) => Record<string, unknown>,
): Promise<void> {
    const scopes: Array<[number | null, ConsensusOutcome]> = [
        [null, perScope.event],
        ...[...perScope.items.entries()].sort(([a], [b]) => a - b),
    ];
    for (const [scope, consensus] of scopes) {
        const ids = await client.query(
            `SELECT id FROM meal_event_nutrition_results
              WHERE event_id = $1 AND version = $2
                AND ordinal IS NOT DISTINCT FROM $3
                AND status = 'succeeded'
              ORDER BY provider`,
            [eventId, version, scope],
        );
        const sourceResultIds = ids.rows.map((row) => row.id as string);
        await client.query(
            `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status, ${NUTRIENT_FIELDS.join(", ")},
                 eligible_providers, outlier_providers, threshold_percent, policy_version, source_result_ids, audit_evidence, algorithm_version)
             VALUES ($1,$2,$3,$4,$5,${NUTRIENT_FIELDS.map((_, i) => `$${6 + i}`).join(",")},$${6 + NUTRIENT_FIELDS.length},$${7 + NUTRIENT_FIELDS.length},$${8 + NUTRIENT_FIELDS.length},$${9 + NUTRIENT_FIELDS.length},$${10 + NUTRIENT_FIELDS.length},$${11 + NUTRIENT_FIELDS.length},$${12 + NUTRIENT_FIELDS.length})`,
            [
                eventId,
                version,
                scope,
                consensus.status,
                consensus.consensus_status,
                ...nutrientValues(consensus.nutrients),
                consensus.eligible_providers,
                consensus.outlier_providers,
                consensus.threshold_percent,
                consensus.policy_version,
                sourceResultIds,
                JSON.stringify(
                    auditEvidence(scope, consensus, sourceResultIds),
                ),
                consensus.policy_version,
            ],
        );
    }
}

async function readCanonical(
    client: PoolClient,
    eventId: string,
    version: number,
) {
    const { rows } = await client.query(
        `SELECT status, consensus_status, ${NUTRIENT_FIELDS.join(", ")},
                eligible_providers, outlier_providers, threshold_percent, policy_version,
                source_result_ids, audit_evidence, algorithm_version
           FROM meal_event_canonical_results
          WHERE event_id = $1 AND version = $2 AND ordinal IS NULL`,
        [eventId, version],
    );
    const row = rows[0];
    if (!row)
        throw new Error(
            "calculation bundle canonical result was not persisted",
        );
    const nutrients = Object.fromEntries(
        NUTRIENT_FIELDS.map((field) => [
            field,
            row[field] === null ? null : Number(row[field]),
        ]),
    ) as ReturnType<typeof computeConsensus>["nutrients"];
    return {
        status: row.status,
        consensus_status: row.consensus_status,
        nutrients,
        per_nutrient: {} as ReturnType<typeof computeConsensus>["per_nutrient"],
        eligible_providers: row.eligible_providers,
        outlier_providers: row.outlier_providers,
        threshold_percent: Number(row.threshold_percent),
        policy_version: row.policy_version,
        source_result_ids: row.source_result_ids as string[] | null,
        audit_evidence: row.audit_evidence as Record<string, unknown> | null,
        algorithm_version: row.algorithm_version as string | null,
    } as ReturnType<typeof computeConsensus>;
}

export async function commitCalculationBundle(
    pool: Pool,
    bundle: CalculationBundleInput,
    options: CalculationBundleCommitOptions = {},
): Promise<CalculationBundleCommitResult> {
    if (bundle.fingerprint === undefined)
        bundle.fingerprint = stableBundleFingerprint({
            ...bundle,
            fingerprint: undefined,
        } as never);
    const issues = validateCalculationBundle(bundle);
    if (issues.length) throw new CalculationBundleValidationError(issues);
    const expected = stableBundleFingerprint({
        ...bundle,
        fingerprint: undefined,
    } as never);
    if (expected !== bundle.fingerprint)
        throw new CalculationBundleValidationError([
            "bundle fingerprint mismatch",
        ]);
    const perScope = recomputeCalculationBundle(bundle);

    return withTransaction(pool, async (client) => {
        const version = await client.query(
            `/* SELECT calculation_bundle_fingerprint */
             SELECT v.calculation_bundle_fingerprint FROM meal_event_versions v
               JOIN meal_events e ON e.id = v.event_id
              WHERE v.event_id = $1 AND v.version = $2
                AND e.status = 'active'
                AND ($3::text IS NULL OR e.user_id = $3)
              FOR UPDATE OF v`,
            [bundle.event_id, bundle.version, options.user_id ?? null],
        );
        if (!version.rows[0]) throw new Error("meal event version not found");
        const existing = version.rows[0].calculation_bundle_fingerprint as
            string | null;
        if (existing && existing !== bundle.fingerprint)
            throw new CalculationBundleValidationError([
                "calculation bundle content conflicts with committed version",
            ]);
        if (existing) {
            const persisted = await readPersistedWriteStatus(
                client,
                bundle.event_id,
                bundle.version,
            );
            if (!persisted.fingerprint)
                throw new Error(
                    "calculation bundle fingerprint readback missing",
                );
            return {
                event_id: bundle.event_id,
                version: bundle.version,
                fingerprint: persisted.fingerprint,
                deduplicated: true,
                canonical: persisted.canonical,
            };
        }
        // A compatibility write (log_meal / update_meal correction) leaves
        // placeholder provider rows (provenance {"compatibility": true}) and
        // canonical rows for this version with a NULL bundle fingerprint. The
        // explicit bundle is the authoritative provenance for the version:
        // replace the placeholders inside this same transaction, or the
        // canonical INSERT below hits UNIQUE (event_id, version, scope_key).
        // Reached only when calculation_bundle_fingerprint IS NULL (a non-NULL
        // fingerprint returned via the dedupe/conflict paths above), so every
        // row deleted here is a recomputable compatibility placeholder.
        await client.query(
            `DELETE FROM meal_event_nutrition_results
              WHERE event_id = $1 AND version = $2
                AND provenance @> '{"compatibility": true}'::jsonb`,
            [bundle.event_id, bundle.version],
        );
        await client.query(
            `DELETE FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2`,
            [bundle.event_id, bundle.version],
        );
        for (const result of bundle.results) {
            const scope = result.scope.ordinal ?? null;
            const sourceId = result.source_id;
            await client.query(
                `INSERT INTO meal_event_nutrition_results
                    (event_id, version, ordinal, provider, source_id, status,
                     request_fingerprint, algorithm_version, raw_payload, provenance,
                     basis, units, ${NUTRIENT_FIELDS.join(", ")}, error_code, error_message)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                         ${NUTRIENT_FIELDS.map((_, i) => `$${13 + i}`).join(",")},$${13 + NUTRIENT_FIELDS.length},$${14 + NUTRIENT_FIELDS.length})`,
                [
                    bundle.event_id,
                    bundle.version,
                    scope,
                    result.provider,
                    sourceId,
                    result.status,
                    result.request_fingerprint,
                    result.algorithm_version,
                    JSON.stringify(result.raw_payload),
                    result.provenance == null
                        ? JSON.stringify({ compatibility: true })
                        : JSON.stringify(result.provenance),
                    result.basis,
                    result.units,
                    ...nutrientValues(result.nutrients),
                    result.error_code ?? null,
                    result.error_message ?? null,
                ],
            );
        }
        await persistCanonicalPerScope(
            client,
            bundle.event_id,
            bundle.version,
            perScope,
            (_scope, consensus, sourceResultIds) => ({
                source_result_ids: sourceResultIds,
                policy_version: consensus.policy_version,
                fingerprint: bundle.fingerprint,
            }),
        );
        await client.query(
            `UPDATE meal_event_versions SET calculation_bundle_fingerprint = $3 WHERE event_id = $1 AND version = $2`,
            [bundle.event_id, bundle.version, bundle.fingerprint],
        );
        await options.beforeCommit?.();
        const persisted = await readPersistedWriteStatus(
            client,
            bundle.event_id,
            bundle.version,
        );
        if (!persisted.fingerprint)
            throw new Error("calculation bundle fingerprint readback missing");
        return {
            event_id: bundle.event_id,
            version: bundle.version,
            fingerprint: persisted.fingerprint,
            deduplicated: false,
            canonical: persisted.canonical,
        };
    });
}

export async function commitCalculationCorrection(
    pool: Pool,
    bundle: CalculationBundleInput,
    metadata: CalculationCorrectionMetadata,
): Promise<CalculationBundleCommitResult> {
    const issues = validateCalculationCorrection(metadata);
    if (issues.length) throw new CalculationBundleValidationError(issues);
    if (bundle.fingerprint === undefined)
        bundle.fingerprint = stableBundleFingerprint({
            ...bundle,
            fingerprint: undefined,
        } as never);
    const bundleIssues = validateCalculationBundle(bundle);
    if (bundleIssues.length)
        throw new CalculationBundleValidationError(bundleIssues);
    const expected = stableBundleFingerprint({
        ...bundle,
        fingerprint: undefined,
    } as never);
    if (expected !== bundle.fingerprint)
        throw new CalculationBundleValidationError([
            "bundle fingerprint mismatch",
        ]);
    const perScope = recomputeCalculationBundle(bundle);
    return withTransaction(pool, async (client) => {
        const root = await client.query(
            `SELECT user_id, current_version FROM meal_events WHERE id = $1 AND status = 'active' FOR UPDATE`,
            [bundle.event_id],
        );
        if (
            !root.rows[0] ||
            (metadata.user_id && root.rows[0].user_id !== metadata.user_id)
        )
            throw new CalculationBundleValidationError([
                "event is not owned by user",
            ]);
        const prior = Number(root.rows[0].current_version);
        const existing = await client.query(
            `SELECT version, calculation_bundle_fingerprint, correction_reason,
                    correction_author, source_timestamp, confirmation_received,
                    external_write_authorized
               FROM meal_event_versions
              WHERE event_id = $1 AND correction_idempotency_key = $2`,
            [bundle.event_id, metadata.correction_idempotency_key],
        );
        if (existing.rows[0]) {
            const persisted = existing.rows[0];
            const sameSourceTimestamp =
                persisted.source_timestamp instanceof Date
                    ? persisted.source_timestamp.getTime() ===
                      Date.parse(metadata.source_timestamp)
                    : String(persisted.source_timestamp) ===
                      metadata.source_timestamp;
            const sameIdentity =
                Number(persisted.version) === bundle.version &&
                persisted.calculation_bundle_fingerprint ===
                    bundle.fingerprint &&
                persisted.correction_reason === metadata.correction_reason &&
                persisted.correction_author === metadata.correction_author &&
                sameSourceTimestamp &&
                persisted.confirmation_received === metadata.confirmed &&
                persisted.external_write_authorized ===
                    metadata.external_write_authorized;
            if (!sameIdentity)
                throw new CalculationBundleValidationError([
                    "correction idempotency key conflicts with persisted correction identity",
                ]);
            const version = Number(persisted.version);
            const persistedStatus = await readPersistedWriteStatus(
                client,
                bundle.event_id,
                version,
            );
            if (!persistedStatus.fingerprint)
                throw new Error("correction fingerprint readback missing");
            return {
                event_id: bundle.event_id,
                version,
                fingerprint: persistedStatus.fingerprint,
                deduplicated: true,
                canonical: persistedStatus.canonical,
            };
        }
        if (bundle.version !== prior + 1)
            throw new CalculationBundleValidationError([
                "correction must append the current version",
            ]);
        await client.query(
            `INSERT INTO meal_event_versions
             (event_id, version, correction_idempotency_key, correction_reason, correction_author,
              source_timestamp, confirmation_received, external_write_authorized, prior_version,
              parser_policy_version, created_by, calculation_bundle_fingerprint)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                bundle.event_id,
                bundle.version,
                metadata.correction_idempotency_key,
                metadata.correction_reason,
                metadata.correction_author,
                metadata.source_timestamp,
                metadata.confirmed,
                metadata.external_write_authorized,
                prior,
                perScope.event.policy_version,
                metadata.correction_author,
                bundle.fingerprint,
            ],
        );
        for (const result of bundle.results) {
            const sourceId = result.source_id;
            await client.query(
                `INSERT INTO meal_event_nutrition_results
                 (event_id,version,ordinal,provider,source_id,status,request_fingerprint,algorithm_version,raw_payload,provenance,basis,units,${NUTRIENT_FIELDS.join(",")},error_code,error_message)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${NUTRIENT_FIELDS.map((_, i) => `$${13 + i}`).join(",")},$${13 + NUTRIENT_FIELDS.length},$${14 + NUTRIENT_FIELDS.length})`,
                [
                    bundle.event_id,
                    bundle.version,
                    result.scope.ordinal,
                    result.provider,
                    sourceId,
                    result.status,
                    result.request_fingerprint,
                    result.algorithm_version,
                    JSON.stringify(result.raw_payload),
                    result.provenance == null
                        ? JSON.stringify({ compatibility: true })
                        : JSON.stringify(result.provenance),
                    result.basis,
                    result.units,
                    ...nutrientValues(result.nutrients),
                    result.error_code ?? null,
                    result.error_message ?? null,
                ],
            );
        }
        await persistCanonicalPerScope(
            client,
            bundle.event_id,
            bundle.version,
            perScope,
            (_scope, consensus, sourceResultIds) => ({
                correction_reason: metadata.correction_reason,
                prior_version: prior,
                consensus_status: consensus.consensus_status,
                outlier_providers: consensus.outlier_providers,
                insufficient_provider:
                    consensus.consensus_status === "insufficient_data",
                source_result_ids: sourceResultIds,
                fingerprint: bundle.fingerprint,
            }),
        );
        await client.query(
            `UPDATE meal_events SET current_version = $2, external_write_authorized = external_write_authorized OR $3, updated_at = now() WHERE id = $1`,
            [
                bundle.event_id,
                bundle.version,
                metadata.external_write_authorized,
            ],
        );
        if (metadata.external_write_authorized)
            await client.query(
                `INSERT INTO meal_event_sync_journal (event_id,version,system,operation,request_fingerprint,authorization_source,state) VALUES ($1,$2,'myfitnesspal','correct_meal_event',$3,'explicit_correction_confirmation','pending') ON CONFLICT DO NOTHING`,
                [
                    bundle.event_id,
                    bundle.version,
                    `correction:${metadata.correction_idempotency_key}`,
                ],
            );
        const persistedStatus = await readPersistedWriteStatus(
            client,
            bundle.event_id,
            bundle.version,
        );
        if (!persistedStatus.fingerprint)
            throw new Error("correction fingerprint readback missing");
        return {
            event_id: bundle.event_id,
            version: bundle.version,
            fingerprint: persistedStatus.fingerprint,
            deduplicated: false,
            canonical: persistedStatus.canonical,
        };
    });
}
