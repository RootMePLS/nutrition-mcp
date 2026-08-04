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

export interface CalculationBundleCommitResult {
    event_id: string;
    version: number;
    fingerprint: string;
    deduplicated: boolean;
    canonical: ReturnType<typeof computeConsensus>;
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
        return {
            event_id: bundle.event_id,
            version: bundle.version,
            fingerprint: bundle.fingerprint,
            deduplicated: false,
            canonical,
        };
    });
}
