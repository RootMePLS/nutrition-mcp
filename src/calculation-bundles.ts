import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { computeConsensus } from "./meal-consensus.js";
import { NUTRIENT_FIELDS, type NutrientField } from "./meal-types.js";
import {
    stableBundleFingerprint,
    validateCalculationBundle,
    type CalculationBundleInput,
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
    return issues;
}

function nutrientValues(
    nutrients: Partial<Record<NutrientField, number | null>>,
) {
    return NUTRIENT_FIELDS.map((field) => nutrients[field] ?? null);
}

export function recomputeCalculationBundle(bundle: CalculationBundleInput) {
    return computeConsensus(
        bundle.results.map((result) => ({
            provider: result.provider,
            status: result.status,
            nutrients: result.nutrients,
        })),
    );
}

async function readCanonical(
    client: PoolClient,
    eventId: string,
    version: number,
) {
    const { rows } = await client.query(
        `SELECT status, consensus_status, ${NUTRIENT_FIELDS.join(", ")},
                eligible_providers, outlier_providers, threshold_percent, policy_version
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
    } as ReturnType<typeof computeConsensus>;
}

export async function commitCalculationBundle(
    pool: Pool,
    bundle: CalculationBundleInput,
    options: CalculationBundleCommitOptions = {},
): Promise<CalculationBundleCommitResult> {
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
    const canonical = recomputeCalculationBundle(bundle);

    return withTransaction(pool, async (client) => {
        const version = await client.query(
            `SELECT calculation_bundle_fingerprint FROM meal_event_versions
              WHERE event_id = $1 AND version = $2 FOR UPDATE`,
            [bundle.event_id, bundle.version],
        );
        if (!version.rows[0]) throw new Error("meal event version not found");
        const existing = version.rows[0].calculation_bundle_fingerprint as
            string | null;
        if (existing && existing !== bundle.fingerprint)
            throw new CalculationBundleValidationError([
                "calculation bundle content conflicts with committed version",
            ]);
        if (existing) {
            return {
                event_id: bundle.event_id,
                version: bundle.version,
                fingerprint: existing,
                deduplicated: true,
                canonical: await readCanonical(
                    client,
                    bundle.event_id,
                    bundle.version,
                ),
            };
        }
        for (const result of bundle.results) {
            const scope = result.scope.ordinal ?? null;
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
                    result.source_id,
                    result.status,
                    result.request_fingerprint,
                    result.algorithm_version,
                    JSON.stringify(result.raw_payload),
                    JSON.stringify({
                        source_id: result.source_id,
                        capture_id: bundle.capture_id,
                    }),
                    result.basis,
                    result.units,
                    ...nutrientValues(result.nutrients),
                    result.error_code ?? null,
                    result.error_message ?? null,
                ],
            );
        }
        const ids = await client.query(
            `SELECT id FROM meal_event_nutrition_results WHERE event_id = $1 AND version = $2 AND ordinal IS NULL AND status = 'succeeded' ORDER BY provider`,
            [bundle.event_id, bundle.version],
        );
        await client.query(
            `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status, ${NUTRIENT_FIELDS.join(", ")},
                 eligible_providers, outlier_providers, threshold_percent, policy_version, source_result_ids)
             VALUES ($1,$2,NULL,$3,$4,${NUTRIENT_FIELDS.map((_, i) => `$${5 + i}`).join(",")},$${5 + NUTRIENT_FIELDS.length},$${6 + NUTRIENT_FIELDS.length},$${7 + NUTRIENT_FIELDS.length},$${8 + NUTRIENT_FIELDS.length},$${9 + NUTRIENT_FIELDS.length})`,
            [
                bundle.event_id,
                bundle.version,
                canonical.status,
                canonical.consensus_status,
                ...nutrientValues(canonical.nutrients),
                canonical.eligible_providers,
                canonical.outlier_providers,
                canonical.threshold_percent,
                canonical.policy_version,
                ids.rows.map((row) => row.id),
            ],
        );
        await client.query(
            `UPDATE meal_event_versions SET calculation_bundle_fingerprint = $3 WHERE event_id = $1 AND version = $2`,
            [bundle.event_id, bundle.version, bundle.fingerprint],
        );
        await options.beforeCommit?.();
        return {
            event_id: bundle.event_id,
            version: bundle.version,
            fingerprint: bundle.fingerprint,
            deduplicated: false,
            canonical,
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
    const canonical = recomputeCalculationBundle(bundle);
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
            return {
                event_id: bundle.event_id,
                version,
                fingerprint: bundle.fingerprint,
                deduplicated: true,
                canonical: await readCanonical(
                    client,
                    bundle.event_id,
                    version,
                ),
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
                canonical.policy_version,
                metadata.correction_author,
                bundle.fingerprint,
            ],
        );
        const ids: string[] = [];
        for (const result of bundle.results) {
            const inserted = await client.query(
                `INSERT INTO meal_event_nutrition_results
                 (event_id,version,ordinal,provider,source_id,status,request_fingerprint,algorithm_version,raw_payload,provenance,basis,units,${NUTRIENT_FIELDS.join(",")},error_code,error_message)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${NUTRIENT_FIELDS.map((_, i) => `$${13 + i}`).join(",")},$${13 + NUTRIENT_FIELDS.length},$${14 + NUTRIENT_FIELDS.length}) RETURNING id`,
                [
                    bundle.event_id,
                    bundle.version,
                    result.scope.ordinal,
                    result.provider,
                    result.source_id,
                    result.status,
                    result.request_fingerprint,
                    result.algorithm_version,
                    JSON.stringify(result.raw_payload),
                    JSON.stringify({
                        source_id: result.source_id,
                        correction_idempotency_key:
                            metadata.correction_idempotency_key,
                    }),
                    result.basis,
                    result.units,
                    ...nutrientValues(result.nutrients),
                    result.error_code ?? null,
                    result.error_message ?? null,
                ],
            );
            if (result.status === "succeeded")
                ids.push(inserted.rows[0].id as string);
        }
        await client.query(
            `INSERT INTO meal_event_canonical_results
             (event_id,version,ordinal,status,consensus_status,${NUTRIENT_FIELDS.join(",")},eligible_providers,outlier_providers,threshold_percent,policy_version,source_result_ids,audit_evidence,algorithm_version)
             VALUES ($1,$2,NULL,$3,$4,${NUTRIENT_FIELDS.map((_, i) => `$${5 + i}`).join(",")},$${5 + NUTRIENT_FIELDS.length},$${6 + NUTRIENT_FIELDS.length},$${7 + NUTRIENT_FIELDS.length},$${8 + NUTRIENT_FIELDS.length},$${9 + NUTRIENT_FIELDS.length},$${10 + NUTRIENT_FIELDS.length},$${11 + NUTRIENT_FIELDS.length})`,
            [
                bundle.event_id,
                bundle.version,
                canonical.status,
                canonical.consensus_status,
                ...nutrientValues(canonical.nutrients),
                canonical.eligible_providers,
                canonical.outlier_providers,
                canonical.threshold_percent,
                canonical.policy_version,
                ids,
                JSON.stringify({
                    correction_reason: metadata.correction_reason,
                    prior_version: prior,
                    consensus_status: canonical.consensus_status,
                    outlier_providers: canonical.outlier_providers,
                    insufficient_provider:
                        canonical.consensus_status === "insufficient_data",
                }),
                canonical.policy_version,
            ],
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
        return {
            event_id: bundle.event_id,
            version: bundle.version,
            fingerprint: bundle.fingerprint,
            deduplicated: false,
            canonical,
        };
    });
}
