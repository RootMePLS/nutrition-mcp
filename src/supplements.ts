// ============================================================================
// SUPPLEMENT / SPORTS-NUTRITION PRODUCT CATALOGUE (Slice 2)
// ============================================================================
// Versioned, user-scoped product catalogue over the migration 006/007
// substrate. A product root owns immutable label versions; a revision inserts
// version N+1 and moves the root current pointer inside one transaction —
// historical versions, aliases, and nutrients are never updated.
//
// Boundaries honored here:
// - unknown nutrient = absent row (amount is NOT NULL); an explicitly
//   supplied numeric zero is real data and persists as 0;
// - every read/write is scoped by user_id; cross-user or deleted reads
//   resolve as "not found" so existence never leaks;
// - idempotent retries converge on the original readback; the same key with
//   a differing label identity is a stable conflict, never a second write.
//
// Concurrency: first-time create idempotency is enforced by the database,
// not just by lookup ordering. Migration 008's partial unique index
// (uniq_spv_user_create_idem) admits exactly one version-1 row per
// (user_id, idempotency key), so concurrent same-key creates serialize on
// the index: the winner commits, the loser's transaction aborts with a
// unique violation, and the loser retries as a deduplicated read or a
// stable idempotency_conflict. Revision idempotency is serialized by the
// root row lock.

import { Pool, type PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { createMealEvent } from "./meal-events.js";
import type { CreateMealEventCommand, Nutrients } from "./meal-types.js";
import { isStrictIsoTimestamp, sha256Hex } from "./meal-types.js";
import { escapeLikePattern } from "./search.js";
import {
    dateInTz,
    validateTz,
    zonedDayStartUtc,
    zonedNextDayStartUtc,
    zonedWallClockToUtc,
} from "./tz.js";
import {
    deriveRegimenOccurrences,
    deriveSupplementIntakeIdempotencyFingerprint,
    deriveSupplementRegimenIdempotencyFingerprint,
    combineNutrientContributions,
    FOOD_COMPATIBLE_NUTRIENT_KEYS,
    isFoodCompatibleNutrientKey,
    isSupplementProductCategory,
    normalizeSupplementAlias,
    projectIntakeVisibleState,
    reduceOccurrenceState,
    selectEffectiveDoneFacts,
    stableStringify,
    validateLabelNutrients,
    validateRegimenSchedule,
    type IntakeFactForContribution,
    type IntakeFactForProjection,
    type NutrientContributionAmount,
    type RegimenSchedule,
    type SupplementIntakeStateAction,
    type SupplementIntakeVisibleState,
    type SupplementLabelNutrientInput,
    type SupplementProductCategory,
} from "./supplement-types.js";

type Queryable = Pool | PoolClient;

// ---------------------------------------------------------------------------
// ERRORS (stable codes; the MCP layer maps code into the error message)
// ---------------------------------------------------------------------------

export class SupplementValidationError extends Error {
    readonly code = "supplement_validation_failed";
    constructor(messages: string[]) {
        super(`invalid supplement payload: ${messages.join("; ")}`);
        this.name = "SupplementValidationError";
    }
}

export class SupplementProductNotFoundError extends Error {
    readonly code = "supplement_product_not_found";
    constructor() {
        super("no supplement product with this id exists for this user");
        this.name = "SupplementProductNotFoundError";
    }
}

export class SupplementProductInactiveError extends Error {
    readonly code = "supplement_product_inactive";
    constructor() {
        super("supplement product is deleted and cannot be revised");
        this.name = "SupplementProductInactiveError";
    }
}

export class SupplementIdempotencyConflictError extends Error {
    readonly code = "idempotency_conflict";
    constructor() {
        super(
            "idempotency key was already used with a different label identity",
        );
        this.name = "SupplementIdempotencyConflictError";
    }
}

// Slice 5 errors (regimens/intakes). Same stable-code style as above.

export interface ResolvedProductCandidate {
    product_id: string;
    category: SupplementProductCategory;
    display_name: string;
    brand: string | null;
    form: string | null;
    current_version: number;
    matched_alias: string;
}

export class SupplementAliasAmbiguousError extends Error {
    readonly code = "supplement_alias_ambiguous";
    constructor(readonly candidates: ResolvedProductCandidate[]) {
        super(
            `supplement_alias_ambiguous: alias matches ${candidates.length} products; pass a direct product_id (candidates: ${candidates
                .map((c) => `${c.display_name} ${c.product_id}`)
                .join(", ")})`,
        );
        this.name = "SupplementAliasAmbiguousError";
    }
}

export class SupplementProductVersionNotFoundError extends Error {
    readonly code = "supplement_product_version_not_found";
    constructor() {
        super("this product has no such label version");
        this.name = "SupplementProductVersionNotFoundError";
    }
}

export class SupplementRegimenNotFoundError extends Error {
    readonly code = "supplement_regimen_not_found";
    constructor() {
        // Unknown id or another user's regimen: indistinguishable by design.
        super("no supplement regimen with this id exists for this user");
        this.name = "SupplementRegimenNotFoundError";
    }
}

export class SupplementRegimenInactiveError extends Error {
    readonly code = "supplement_regimen_inactive";
    constructor() {
        super("regimen is deactivated; reactivate it or log an ad-hoc intake");
        this.name = "SupplementRegimenInactiveError";
    }
}

// ---------------------------------------------------------------------------
// COMMANDS & READBACKS
// ---------------------------------------------------------------------------

export interface SupplementLabelLimitInput {
    nutrient_key: string;
    unit: string;
    maximum_amount: number;
    source_evidence?: Record<string, unknown>;
}

export interface SupplementLabelFields {
    display_name: string;
    short_name?: string | null;
    brand?: string | null;
    form?: string | null;
    serving_amount?: number | null;
    serving_unit?: string | null;
    serving_description?: string | null;
    aliases: string[];
    nutrients: SupplementLabelNutrientInput[];
    label_limits?: SupplementLabelLimitInput[];
    label_evidence: Record<string, unknown>;
    label_source_kind?: string | null;
}

export interface CreateSupplementProductCommand extends SupplementLabelFields {
    user_id: string;
    category: SupplementProductCategory;
    idempotency_key?: string | null;
    created_by: string;
}

export interface ReviseSupplementProductLabelCommand extends SupplementLabelFields {
    user_id: string;
    product_id: string;
    revision_idempotency_key?: string | null;
    created_by: string;
}

export interface SupplementNutrientReadback {
    nutrient_key: string;
    display_name: string | null;
    amount: number;
    unit: string;
    source_evidence: Record<string, unknown>;
}

export interface SupplementLabelLimitReadback {
    nutrient_key: string;
    unit: string;
    maximum_amount: number;
    source_evidence: Record<string, unknown>;
}

export interface SupplementProductVersionReadback {
    version: number;
    is_current: boolean;
    display_name: string;
    short_name: string | null;
    brand: string | null;
    form: string | null;
    serving_amount: number | null;
    serving_unit: string | null;
    serving_description: string | null;
    aliases: string[];
    nutrients: SupplementNutrientReadback[];
    label_limits: SupplementLabelLimitReadback[];
    label_evidence: Record<string, unknown>;
    label_source_kind: string | null;
    created_at: string;
}

export interface SupplementProductReadback {
    product_id: string;
    category: SupplementProductCategory;
    status: "active" | "deleted";
    current_version: number;
    created_at: string;
    updated_at: string;
    version: SupplementProductVersionReadback;
}

export interface SupplementProductSummary {
    product_id: string;
    category: SupplementProductCategory;
    status: "active" | "deleted";
    current_version: number;
    display_name: string;
    short_name: string | null;
    brand: string | null;
    form: string | null;
    aliases: string[];
    created_at: string;
    updated_at: string;
}

export interface CreateSupplementProductResult {
    product: SupplementProductReadback;
    deduplicated: boolean;
}

export interface ReviseSupplementProductLabelResult {
    product: SupplementProductReadback;
    previous_version: number;
    deduplicated: boolean;
}

// ---------------------------------------------------------------------------
// VALIDATION & IDENTITY
// ---------------------------------------------------------------------------

interface NormalizedAlias {
    raw: string;
    normalized: string;
}

interface NormalizedLabel {
    display_name: string;
    short_name: string | null;
    brand: string | null;
    form: string | null;
    serving_amount: number | null;
    serving_unit: string | null;
    serving_description: string | null;
    aliases: NormalizedAlias[];
    nutrients: Required<SupplementLabelNutrientInput>[];
    label_limits: Required<SupplementLabelLimitInput>[];
    label_evidence: Record<string, unknown>;
    label_source_kind: string | null;
}

function optionalText(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

function validateLabelFields(fields: SupplementLabelFields): NormalizedLabel {
    const errors: string[] = [];

    const displayName =
        typeof fields.display_name === "string"
            ? fields.display_name.trim()
            : "";
    if (displayName === "") {
        errors.push("display_name must be a non-empty string");
    }

    const servingAmount = fields.serving_amount ?? null;
    const servingUnit = optionalText(fields.serving_unit);
    if (servingAmount !== null) {
        if (
            typeof servingAmount !== "number" ||
            !Number.isFinite(servingAmount) ||
            servingAmount <= 0
        ) {
            errors.push("serving_amount must be a finite positive number");
        }
        if (servingUnit === null) {
            errors.push("serving_amount requires serving_unit");
        }
    } else if (servingUnit !== null) {
        errors.push("serving_unit requires serving_amount");
    }

    const aliases: NormalizedAlias[] = [];
    const seenAliases = new Set<string>();
    if (!Array.isArray(fields.aliases)) {
        errors.push("aliases must be an array");
    } else {
        for (const entry of fields.aliases) {
            if (typeof entry !== "string") {
                errors.push("each alias must be a string");
                continue;
            }
            const raw = entry.trim();
            const normalized = normalizeSupplementAlias(entry);
            if (normalized === null) {
                errors.push("aliases must not be empty");
                continue;
            }
            if (seenAliases.has(normalized)) {
                errors.push(
                    "duplicate alias within one label version (after normalization)",
                );
                continue;
            }
            seenAliases.add(normalized);
            aliases.push({ raw, normalized });
        }
    }

    const nutrientErrors = validateLabelNutrients(fields.nutrients);
    errors.push(...nutrientErrors);
    if (Array.isArray(fields.nutrients) && fields.nutrients.length === 0) {
        errors.push("a label must supply at least one nutrient");
    }

    const labelLimits = fields.label_limits ?? [];
    const seenLimits = new Map<string, Set<string>>();
    if (!Array.isArray(labelLimits)) {
        errors.push("label_limits must be an array");
    } else {
        for (const limit of labelLimits) {
            if (limit === null || typeof limit !== "object") {
                errors.push("each label limit must be an object");
                continue;
            }
            const key =
                typeof limit.nutrient_key === "string"
                    ? limit.nutrient_key.trim()
                    : "";
            const unit =
                typeof limit.unit === "string" ? limit.unit.trim() : "";
            if (key === "" || unit === "") {
                errors.push(
                    "label limit nutrient_key and unit must be non-empty",
                );
                continue;
            }
            if (
                typeof limit.maximum_amount !== "number" ||
                !Number.isFinite(limit.maximum_amount) ||
                limit.maximum_amount <= 0
            ) {
                errors.push(
                    "label limit maximum_amount must be a finite positive number",
                );
            }
            const units = seenLimits.get(key) ?? new Set<string>();
            if (units.has(unit)) {
                errors.push(
                    "duplicate label limit identity (nutrient_key + unit)",
                );
            }
            units.add(unit);
            seenLimits.set(key, units);
        }
    }

    if (
        fields.label_evidence === null ||
        typeof fields.label_evidence !== "object" ||
        Array.isArray(fields.label_evidence)
    ) {
        errors.push("label_evidence must be an object");
    }

    if (errors.length > 0) {
        throw new SupplementValidationError(errors);
    }

    return {
        display_name: displayName,
        short_name: optionalText(fields.short_name),
        brand: optionalText(fields.brand),
        form: optionalText(fields.form),
        serving_amount: servingAmount,
        serving_unit: servingUnit,
        serving_description: optionalText(fields.serving_description),
        aliases,
        nutrients: (fields.nutrients as SupplementLabelNutrientInput[]).map(
            (n) => ({
                nutrient_key: n.nutrient_key.trim(),
                display_name: optionalText(n.display_name),
                amount: n.amount,
                unit: n.unit.trim(),
                source_evidence: n.source_evidence ?? {},
            }),
        ),
        label_limits: labelLimits.map((l) => ({
            nutrient_key: l.nutrient_key.trim(),
            unit: l.unit.trim(),
            maximum_amount: l.maximum_amount,
            source_evidence: l.source_evidence ?? {},
        })),
        label_evidence: fields.label_evidence,
        label_source_kind: optionalText(fields.label_source_kind),
    };
}

interface LabelIdentitySource {
    display_name: string;
    short_name: string | null;
    brand: string | null;
    form: string | null;
    serving_amount: number | null;
    serving_unit: string | null;
    serving_description: string | null;
    aliases: string[];
    nutrients: SupplementNutrientReadback[];
    label_limits: SupplementLabelLimitReadback[];
    label_evidence: Record<string, unknown>;
    label_source_kind: string | null;
}

function labelIdentityFingerprint(
    category: SupplementProductCategory | null,
    label: LabelIdentitySource,
): string {
    const identity = {
        category,
        display_name: label.display_name,
        short_name: label.short_name,
        brand: label.brand,
        form: label.form,
        serving_amount: label.serving_amount,
        serving_unit: label.serving_unit,
        serving_description: label.serving_description,
        aliases: label.aliases.map((a) => normalizeSupplementAlias(a)).sort(),
        nutrients: label.nutrients
            .map((n) => ({
                nutrient_key: n.nutrient_key,
                display_name: n.display_name,
                amount: Number(n.amount),
                unit: n.unit,
                source_evidence: n.source_evidence,
            }))
            .sort((a, b) =>
                `${a.nutrient_key}${a.unit}` < `${b.nutrient_key}${b.unit}`
                    ? -1
                    : 1,
            ),
        label_limits: label.label_limits
            .map((l) => ({
                nutrient_key: l.nutrient_key,
                unit: l.unit,
                maximum_amount: Number(l.maximum_amount),
                source_evidence: l.source_evidence,
            }))
            .sort((a, b) =>
                `${a.nutrient_key}${a.unit}` < `${b.nutrient_key}${b.unit}`
                    ? -1
                    : 1,
            ),
        label_evidence: label.label_evidence,
        label_source_kind: label.label_source_kind,
    };
    return `supplement-label:${sha256Hex([stableStringify(identity)])}`;
}

// ---------------------------------------------------------------------------
// ROW MAPPING & READBACK ASSEMBLY
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function iso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

interface ProductRootRow {
    id: string;
    user_id: string;
    category: SupplementProductCategory;
    status: "active" | "deleted";
    current_version: number;
    created_at: Date | string;
    updated_at: Date | string;
}

async function readProductRoot(
    q: Queryable,
    productId: string,
): Promise<ProductRootRow | null> {
    const { rows } = await q.query(
        `SELECT id, user_id, category, status, current_version, created_at, updated_at
         FROM supplement_products WHERE id = $1`,
        [productId],
    );
    return (rows[0] as ProductRootRow | undefined) ?? null;
}

async function assembleReadback(
    q: Queryable,
    root: ProductRootRow,
    version: number,
): Promise<SupplementProductReadback | null> {
    const { rows: versionRows } = await q.query(
        `SELECT version, display_name, short_name, brand, form,
                serving_amount, serving_unit, serving_description,
                label_evidence, label_source_kind, created_at
         FROM supplement_product_versions
         WHERE product_id = $1 AND version = $2`,
        [root.id, version],
    );
    const v = versionRows[0] as Record<string, unknown> | undefined;
    if (!v) return null;

    const { rows: aliasRows } = await q.query(
        `SELECT alias FROM supplement_product_aliases
         WHERE product_id = $1 AND version = $2 ORDER BY lower(alias), alias`,
        [root.id, version],
    );
    const { rows: nutrientRows } = await q.query(
        `SELECT nutrient_key, display_name, amount, unit, source_evidence
         FROM supplement_product_nutrients
         WHERE product_id = $1 AND version = $2
         ORDER BY nutrient_key, unit`,
        [root.id, version],
    );
    const { rows: limitRows } = await q.query(
        `SELECT nutrient_key, unit, maximum_amount, source_evidence
         FROM supplement_product_label_limits
         WHERE product_id = $1 AND version = $2
         ORDER BY nutrient_key, unit`,
        [root.id, version],
    );

    return {
        product_id: root.id,
        category: root.category,
        status: root.status,
        current_version: root.current_version,
        created_at: iso(root.created_at),
        updated_at: iso(root.updated_at),
        version: {
            version,
            is_current: version === root.current_version,
            display_name: v.display_name as string,
            short_name: (v.short_name as string | null) ?? null,
            brand: (v.brand as string | null) ?? null,
            form: (v.form as string | null) ?? null,
            serving_amount: num(v.serving_amount),
            serving_unit: (v.serving_unit as string | null) ?? null,
            serving_description:
                (v.serving_description as string | null) ?? null,
            aliases: aliasRows.map((r) => r.alias as string),
            nutrients: nutrientRows.map((r) => ({
                nutrient_key: r.nutrient_key as string,
                display_name: (r.display_name as string | null) ?? null,
                amount: num(r.amount) as number,
                unit: r.unit as string,
                source_evidence:
                    (r.source_evidence as Record<string, unknown>) ?? {},
            })),
            label_limits: limitRows.map((r) => ({
                nutrient_key: r.nutrient_key as string,
                unit: r.unit as string,
                maximum_amount: num(r.maximum_amount) as number,
                source_evidence:
                    (r.source_evidence as Record<string, unknown>) ?? {},
            })),
            label_evidence: (v.label_evidence as Record<string, unknown>) ?? {},
            label_source_kind: (v.label_source_kind as string | null) ?? null,
            created_at: iso(v.created_at),
        },
    };
}

async function insertLabelChildren(
    client: PoolClient,
    root: { id: string; user_id: string },
    version: number,
    label: NormalizedLabel,
): Promise<void> {
    for (const alias of label.aliases) {
        await client.query(
            `INSERT INTO supplement_product_aliases
                (product_id, version, user_id, alias, normalized_alias)
             VALUES ($1, $2, $3, $4, $5)`,
            [root.id, version, root.user_id, alias.raw, alias.normalized],
        );
    }
    for (const nutrient of label.nutrients) {
        await client.query(
            `INSERT INTO supplement_product_nutrients
                (product_id, version, nutrient_key, display_name, amount, unit, source_evidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                root.id,
                version,
                nutrient.nutrient_key,
                nutrient.display_name,
                nutrient.amount,
                nutrient.unit,
                JSON.stringify(nutrient.source_evidence),
            ],
        );
    }
    for (const limit of label.label_limits) {
        await client.query(
            `INSERT INTO supplement_product_label_limits
                (product_id, version, nutrient_key, unit, maximum_amount, source_evidence)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                root.id,
                version,
                limit.nutrient_key,
                limit.unit,
                limit.maximum_amount,
                JSON.stringify(limit.source_evidence),
            ],
        );
    }
}

// ---------------------------------------------------------------------------
// PUBLIC REPOSITORY API
// ---------------------------------------------------------------------------

// A pg DatabaseError for a unique violation (SQLSTATE 23505) on a specific
// named idempotency index. Matching the index name keeps unrelated unique
// violations (duplicate alias/nutrient rows, revision-key collisions)
// fail-fast instead of silently retried.
function isKeyRaceViolation(err: unknown, constraint: string): boolean {
    const e = err as { code?: string; constraint?: string } | null;
    return e?.code === "23505" && e.constraint === constraint;
}

// Migration 008's product create-key index.
function isCreateKeyRaceViolation(err: unknown): boolean {
    return isKeyRaceViolation(err, "uniq_spv_user_create_idem");
}

export async function createSupplementProduct(
    pool: Pool,
    command: CreateSupplementProductCommand,
): Promise<CreateSupplementProductResult> {
    if (!isSupplementProductCategory(command.category)) {
        throw new SupplementValidationError([
            "category must be 'supplement' or 'sports_nutrition'",
        ]);
    }
    const label = validateLabelFields(command);
    const idempotencyKey = optionalText(command.idempotency_key);
    const fingerprint = labelIdentityFingerprint(command.category, {
        ...label,
        aliases: label.aliases.map((a) => a.raw),
    });

    // Concurrent first-time creates with the same key serialize on migration
    // 008's uniq_spv_user_create_idem partial unique index: the loser blocks
    // on the index until the winner commits or aborts. A committed winner
    // makes the loser's version-1 insert fail with a unique violation; the
    // loser retries here, finds the winner's row on the convergence lookup
    // below, and returns the deduplicated readback or a stable conflict —
    // never a second root. If the winner aborted instead, the retry inserts
    // cleanly. One retry always suffices after a committed winner; the bound
    // only guards against repeated aborts under churn.
    const MAX_CREATE_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
        try {
            return await withTransaction(pool, async (client) => {
                if (idempotencyKey !== null) {
                    // Retry convergence: a version-1 row with this user's key means
                    // the original create already committed. Migration 008's partial
                    // unique index guarantees at most one such row can ever exist.
                    const { rows } = await client.query(
                        `SELECT product_id FROM supplement_product_versions
                 WHERE user_id = $1 AND version = 1 AND revision_idempotency_key = $2`,
                        [command.user_id, idempotencyKey],
                    );
                    const existing = rows[0] as
                        { product_id: string } | undefined;
                    if (existing) {
                        const root = await readProductRoot(
                            client,
                            existing.product_id,
                        );
                        const readback = root
                            ? await assembleReadback(client, root, 1)
                            : null;
                        if (!readback) {
                            throw new SupplementIdempotencyConflictError();
                        }
                        const existingFingerprint = labelIdentityFingerprint(
                            readback.category,
                            readback.version,
                        );
                        if (existingFingerprint !== fingerprint) {
                            throw new SupplementIdempotencyConflictError();
                        }
                        return { product: readback, deduplicated: true };
                    }
                }

                const { rows: rootRows } = await client.query(
                    `INSERT INTO supplement_products (user_id, category)
             VALUES ($1, $2)
             RETURNING id, user_id, category, status, current_version, created_at, updated_at`,
                    [command.user_id, command.category],
                );
                const root = rootRows[0] as ProductRootRow;

                await client.query(
                    `INSERT INTO supplement_product_versions
                (product_id, version, user_id, revision_idempotency_key,
                 display_name, short_name, brand, form,
                 serving_amount, serving_unit, serving_description,
                 label_evidence, label_source_kind, created_by, prior_version)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL)`,
                    [
                        root.id,
                        command.user_id,
                        idempotencyKey,
                        label.display_name,
                        label.short_name,
                        label.brand,
                        label.form,
                        label.serving_amount,
                        label.serving_unit,
                        label.serving_description,
                        JSON.stringify(label.label_evidence),
                        label.label_source_kind,
                        command.created_by,
                    ],
                );
                await insertLabelChildren(client, root, 1, label);

                const readback = await assembleReadback(client, root, 1);
                if (!readback)
                    throw new Error("failed to read created product");
                return { product: readback, deduplicated: false };
            });
        } catch (err) {
            if (
                idempotencyKey !== null &&
                attempt < MAX_CREATE_ATTEMPTS &&
                isCreateKeyRaceViolation(err)
            ) {
                continue;
            }
            throw err;
        }
    }
}

export async function reviseSupplementProductLabel(
    pool: Pool,
    command: ReviseSupplementProductLabelCommand,
): Promise<ReviseSupplementProductLabelResult> {
    const label = validateLabelFields(command);
    const idempotencyKey = optionalText(command.revision_idempotency_key);
    // Revision identity is label-only: the category is immutable root data.
    const fingerprint = labelIdentityFingerprint(null, {
        ...label,
        aliases: label.aliases.map((a) => a.raw),
    });

    return withTransaction(pool, async (client) => {
        // Lock the authoritative root before any child work so concurrent
        // revisions of the same product serialize here.
        const { rows: rootRows } = await client.query(
            `SELECT id, user_id, category, status, current_version, created_at, updated_at
             FROM supplement_products
             WHERE id = $1 AND user_id = $2
             FOR UPDATE`,
            [command.product_id, command.user_id],
        );
        const root = rootRows[0] as ProductRootRow | undefined;
        if (!root) {
            // Unknown id or another user's product: identical response so
            // existence never leaks across users.
            throw new SupplementProductNotFoundError();
        }
        if (root.status !== "active") {
            throw new SupplementProductInactiveError();
        }

        if (idempotencyKey !== null) {
            const { rows } = await client.query(
                `SELECT version FROM supplement_product_versions
                 WHERE product_id = $1 AND revision_idempotency_key = $2`,
                [root.id, idempotencyKey],
            );
            const existing = rows[0] as { version: number } | undefined;
            if (existing) {
                const readback = await assembleReadback(
                    client,
                    root,
                    existing.version,
                );
                if (!readback) {
                    throw new SupplementIdempotencyConflictError();
                }
                const existingFingerprint = labelIdentityFingerprint(
                    null,
                    readback.version,
                );
                if (existingFingerprint !== fingerprint) {
                    throw new SupplementIdempotencyConflictError();
                }
                return {
                    product: readback,
                    previous_version:
                        existing.version === 1 ? 0 : existing.version - 1,
                    deduplicated: true,
                };
            }
        }

        const previousVersion = root.current_version;
        const nextVersion = previousVersion + 1;
        await client.query(
            `INSERT INTO supplement_product_versions
                (product_id, version, user_id, revision_idempotency_key,
                 display_name, short_name, brand, form,
                 serving_amount, serving_unit, serving_description,
                 label_evidence, label_source_kind, created_by, prior_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
                root.id,
                nextVersion,
                command.user_id,
                idempotencyKey,
                label.display_name,
                label.short_name,
                label.brand,
                label.form,
                label.serving_amount,
                label.serving_unit,
                label.serving_description,
                JSON.stringify(label.label_evidence),
                label.label_source_kind,
                command.created_by,
                previousVersion,
            ],
        );
        await insertLabelChildren(client, root, nextVersion, label);

        const { rows: updatedRows } = await client.query(
            `UPDATE supplement_products
             SET current_version = $2, updated_at = now()
             WHERE id = $1
             RETURNING id, user_id, category, status, current_version, created_at, updated_at`,
            [root.id, nextVersion],
        );
        const updatedRoot = updatedRows[0] as ProductRootRow;
        const readback = await assembleReadback(
            client,
            updatedRoot,
            nextVersion,
        );
        if (!readback) throw new Error("failed to read revised product");
        return {
            product: readback,
            previous_version: previousVersion,
            deduplicated: false,
        };
    });
}

export async function getSupplementProduct(
    pool: Queryable,
    userId: string,
    productId: string,
    version?: number,
): Promise<SupplementProductReadback | null> {
    const root = await readProductRoot(pool, productId);
    // Deleted products and other users' products both resolve as not found.
    if (!root || root.user_id !== userId || root.status !== "active") {
        return null;
    }
    return assembleReadback(pool, root, version ?? root.current_version);
}

interface SummaryRow {
    id: string;
    category: SupplementProductCategory;
    status: "active" | "deleted";
    current_version: number;
    display_name: string;
    short_name: string | null;
    brand: string | null;
    form: string | null;
    created_at: Date | string;
    updated_at: Date | string;
}

async function summariesFromRows(
    q: Queryable,
    rows: SummaryRow[],
): Promise<SupplementProductSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const { rows: aliasRows } = await q.query(
        `SELECT a.product_id, a.alias
         FROM supplement_product_aliases a
         JOIN supplement_products p ON p.id = a.product_id AND p.current_version = a.version
         WHERE a.product_id = ANY($1::uuid[])
         ORDER BY lower(a.alias), a.alias`,
        [ids],
    );
    const aliasesByProduct = new Map<string, string[]>();
    for (const row of aliasRows) {
        const list = aliasesByProduct.get(row.product_id as string) ?? [];
        list.push(row.alias as string);
        aliasesByProduct.set(row.product_id as string, list);
    }
    return rows.map((r) => ({
        product_id: r.id,
        category: r.category,
        status: r.status,
        current_version: r.current_version,
        display_name: r.display_name,
        short_name: r.short_name,
        brand: r.brand,
        form: r.form,
        aliases: aliasesByProduct.get(r.id) ?? [],
        created_at: iso(r.created_at),
        updated_at: iso(r.updated_at),
    }));
}

export async function listSupplementProducts(
    pool: Queryable,
    userId: string,
    options: { includeDeleted?: boolean; limit?: number } = {},
): Promise<SupplementProductSummary[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const { rows } = await pool.query(
        `SELECT p.id, p.category, p.status, p.current_version, p.created_at, p.updated_at,
                v.display_name, v.short_name, v.brand, v.form
         FROM supplement_products p
         JOIN supplement_product_versions v
           ON v.product_id = p.id AND v.version = p.current_version
         WHERE p.user_id = $1 ${options.includeDeleted ? "" : "AND p.status = 'active'"}
         ORDER BY lower(v.display_name), p.id
         LIMIT $2`,
        [userId, limit],
    );
    return summariesFromRows(pool, rows as SummaryRow[]);
}

export async function searchSupplementProducts(
    pool: Queryable,
    userId: string,
    query: string,
    options: { limit?: number } = {},
): Promise<SupplementProductSummary[]> {
    const trimmed = query.trim();
    if (trimmed === "") return [];
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    // Lexical case-insensitive substring matching over the CURRENT version's
    // display/short name and aliases. Historical-version aliases do not
    // match: search reflects what the label says now.
    const pattern = `%${escapeLikePattern(trimmed)}%`;
    const { rows } = await pool.query(
        `SELECT p.id, p.category, p.status, p.current_version, p.created_at, p.updated_at,
                v.display_name, v.short_name, v.brand, v.form
         FROM supplement_products p
         JOIN supplement_product_versions v
           ON v.product_id = p.id AND v.version = p.current_version
         WHERE p.user_id = $1 AND p.status = 'active' AND (
             v.display_name ILIKE $2 ESCAPE '\\'
             OR v.short_name ILIKE $2 ESCAPE '\\'
             OR EXISTS (
                 SELECT 1 FROM supplement_product_aliases a
                 WHERE a.product_id = p.id AND a.version = p.current_version
                   AND a.normalized_alias ILIKE $2 ESCAPE '\\'
             )
         )
         ORDER BY lower(v.display_name), p.id
         LIMIT $3`,
        [userId, pattern, limit],
    );
    return summariesFromRows(pool, rows as SummaryRow[]);
}

// ===========================================================================
// SUPPLEMENT REGIMENS (Slice 5)
// ===========================================================================
// A regimen is declarative intent bound to one immutable product version:
// creating, listing, or reading one never writes an intake fact, a meal
// event, a scheduler job, or a reminder. Create idempotency is enforced by
// migration 010's partial unique index (uniq_supplement_regimens_user_idem),
// not by lookup ordering — concurrent same-key creates serialize at the
// database and the loser converges as a deduplicated read or a stable
// idempotency_conflict, exactly like product creation under 008.

export interface CreateSupplementRegimenCommand {
    user_id: string;
    product_id: string;
    /** Defaults to the product's current version at create time. */
    product_version?: number | null;
    dose_servings: number;
    schedule: RegimenSchedule;
    /** YYYY-MM-DD. */
    starts_on: string;
    /** YYYY-MM-DD on or after starts_on, or null for open-ended. */
    ends_on?: string | null;
    idempotency_key?: string | null;
    created_by: string;
}

export interface SupplementRegimenReadback {
    regimen_id: string;
    product_id: string;
    product_version: number;
    /** Display name of the BOUND version, not the current one. */
    product_display_name: string;
    category: SupplementProductCategory;
    dose_servings: number;
    schedule: RegimenSchedule;
    starts_on: string;
    ends_on: string | null;
    active: boolean;
    created_at: string;
    updated_at: string;
    deactivated_at: string | null;
}

export interface CreateSupplementRegimenResult {
    regimen: SupplementRegimenReadback;
    deduplicated: boolean;
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isLocalDateString(value: unknown): value is string {
    if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value)) {
        return false;
    }
    const [y, m, d] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(y!, m! - 1, d!));
    return (
        parsed.getUTCFullYear() === y &&
        parsed.getUTCMonth() === m! - 1 &&
        parsed.getUTCDate() === d
    );
}

interface NormalizedRegimenFields {
    dose_servings: number;
    schedule: RegimenSchedule;
    starts_on: string;
    ends_on: string | null;
}

function validateRegimenFields(
    command: CreateSupplementRegimenCommand,
): NormalizedRegimenFields {
    const errors: string[] = [];
    if (
        typeof command.dose_servings !== "number" ||
        !Number.isFinite(command.dose_servings) ||
        command.dose_servings <= 0
    ) {
        errors.push("dose_servings must be a finite positive number");
    }
    errors.push(...validateRegimenSchedule(command.schedule));
    if (!isLocalDateString(command.starts_on)) {
        errors.push("starts_on must be a real YYYY-MM-DD date");
    }
    const endsOn = command.ends_on ?? null;
    if (endsOn !== null) {
        if (!isLocalDateString(endsOn)) {
            errors.push("ends_on must be a real YYYY-MM-DD date");
        } else if (
            isLocalDateString(command.starts_on) &&
            endsOn < command.starts_on
        ) {
            errors.push("ends_on must be on or after starts_on");
        }
    }
    if (
        command.product_version !== undefined &&
        command.product_version !== null
    ) {
        if (
            typeof command.product_version !== "number" ||
            !Number.isInteger(command.product_version) ||
            command.product_version < 1
        ) {
            errors.push("product_version must be a positive integer");
        }
    }
    if (errors.length > 0) {
        throw new SupplementValidationError(errors);
    }
    return {
        dose_servings: command.dose_servings,
        schedule: command.schedule,
        starts_on: command.starts_on,
        ends_on: endsOn,
    };
}

// Dates are read back through to_char so the pg DATE parser can never shift
// a local calendar date into a Date object.
const REGIMEN_SELECT = `
    SELECT id, user_id, product_id, product_version, dose_servings, schedule,
           timezone, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
           to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
           active, created_by, created_at, updated_at, deactivated_at,
           idempotency_key
    FROM supplement_regimens`;

interface RegimenRow {
    id: string;
    user_id: string;
    product_id: string;
    product_version: number;
    dose_servings: string | number;
    schedule: RegimenSchedule;
    timezone: string;
    starts_on: string;
    ends_on: string | null;
    active: boolean;
    created_by: string;
    created_at: Date | string;
    updated_at: Date | string;
    deactivated_at: Date | string | null;
    idempotency_key: string | null;
}

async function readRegimenRow(
    q: Queryable,
    regimenId: string,
): Promise<RegimenRow | null> {
    const { rows } = await q.query(`${REGIMEN_SELECT} WHERE id = $1`, [
        regimenId,
    ]);
    return (rows[0] as RegimenRow | undefined) ?? null;
}

async function assembleRegimenReadback(
    q: Queryable,
    row: RegimenRow,
): Promise<SupplementRegimenReadback> {
    const { rows } = await q.query(
        `SELECT v.display_name, p.category
         FROM supplement_product_versions v
         JOIN supplement_products p ON p.id = v.product_id
         WHERE v.product_id = $1 AND v.version = $2`,
        [row.product_id, row.product_version],
    );
    const product = rows[0] as
        | { display_name: string; category: SupplementProductCategory }
        | undefined;
    if (!product) throw new Error("regimen bound version row is missing");
    return {
        regimen_id: row.id,
        product_id: row.product_id,
        product_version: row.product_version,
        product_display_name: product.display_name,
        category: product.category,
        dose_servings: Number(row.dose_servings),
        schedule: row.schedule,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
        active: row.active,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        deactivated_at:
            row.deactivated_at === null ? null : iso(row.deactivated_at),
    };
}

function regimenIdentityFingerprint(
    row: RegimenRow,
    idempotencyKey: string,
): string {
    return deriveSupplementRegimenIdempotencyFingerprint({
        user_id: row.user_id,
        idempotency_key: idempotencyKey,
        product_id: row.product_id,
        product_version: row.product_version,
        dose_servings: Number(row.dose_servings),
        schedule: row.schedule,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
    });
}

export async function createSupplementRegimen(
    pool: Pool,
    command: CreateSupplementRegimenCommand,
    opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<CreateSupplementRegimenResult> {
    const fields = validateRegimenFields(command);
    const idempotencyKey = optionalText(command.idempotency_key);

    // Concurrent first-time creates with the same key serialize on migration
    // 010's uniq_supplement_regimens_user_idem partial unique index: the
    // loser's insert aborts with a unique violation once the winner commits,
    // and the retry below converges on the winner's row as a deduplicated
    // read or a stable idempotency_conflict — never a second regimen.
    const MAX_CREATE_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
        try {
            return await withTransaction(pool, async (client) => {
                // Lock the authoritative product root (user-scoped) before
                // resolving the version or inserting intent.
                const { rows: rootRows } = await client.query(
                    `SELECT id, user_id, category, status, current_version, created_at, updated_at
                     FROM supplement_products
                     WHERE id = $1 AND user_id = $2
                     FOR UPDATE`,
                    [command.product_id, command.user_id],
                );
                const root = rootRows[0] as ProductRootRow | undefined;
                // Unknown id, another user's product, or a deleted product:
                // one identical closed failure so existence never leaks.
                if (!root || root.status !== "active") {
                    throw new SupplementProductNotFoundError();
                }

                const version = command.product_version ?? root.current_version;
                const { rows: versionRows } = await client.query(
                    `SELECT 1 FROM supplement_product_versions
                     WHERE product_id = $1 AND version = $2 AND user_id = $3`,
                    [root.id, version, command.user_id],
                );
                if (versionRows.length === 0) {
                    throw new SupplementProductVersionNotFoundError();
                }

                if (idempotencyKey !== null) {
                    // Retry convergence: a regimen row with this user's key
                    // means the original create already committed. Migration
                    // 010 guarantees at most one such row can ever exist.
                    const { rows } = await client.query(
                        `${REGIMEN_SELECT} WHERE user_id = $1 AND idempotency_key = $2`,
                        [command.user_id, idempotencyKey],
                    );
                    const existing = rows[0] as RegimenRow | undefined;
                    if (existing) {
                        const fingerprint =
                            deriveSupplementRegimenIdempotencyFingerprint({
                                user_id: command.user_id,
                                idempotency_key: idempotencyKey,
                                product_id: root.id,
                                product_version: version,
                                dose_servings: fields.dose_servings,
                                schedule: fields.schedule,
                                starts_on: fields.starts_on,
                                ends_on: fields.ends_on,
                            });
                        if (
                            regimenIdentityFingerprint(
                                existing,
                                idempotencyKey,
                            ) !== fingerprint
                        ) {
                            throw new SupplementIdempotencyConflictError();
                        }
                        return {
                            regimen: await assembleRegimenReadback(
                                client,
                                existing,
                            ),
                            deduplicated: true,
                        };
                    }
                }

                const { rows: inserted } = await client.query(
                    `INSERT INTO supplement_regimens
                        (user_id, product_id, product_version, dose_servings,
                         schedule, timezone, starts_on, ends_on, created_by,
                         idempotency_key)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     RETURNING id`,
                    [
                        command.user_id,
                        root.id,
                        version,
                        fields.dose_servings,
                        JSON.stringify(fields.schedule),
                        fields.schedule.timezone,
                        fields.starts_on,
                        fields.ends_on,
                        command.created_by,
                        idempotencyKey,
                    ],
                );
                await opts.beforeCommit?.();
                const row = await readRegimenRow(
                    client,
                    (inserted[0] as { id: string }).id,
                );
                if (!row) throw new Error("failed to read created regimen");
                return {
                    regimen: await assembleRegimenReadback(client, row),
                    deduplicated: false,
                };
            });
        } catch (err) {
            if (
                idempotencyKey !== null &&
                attempt < MAX_CREATE_ATTEMPTS &&
                isKeyRaceViolation(err, "uniq_supplement_regimens_user_idem")
            ) {
                continue;
            }
            throw err;
        }
    }
}

export async function listSupplementRegimens(
    pool: Queryable,
    userId: string,
    options: {
        includeInactive?: boolean;
        productId?: string;
        limit?: number;
    } = {},
): Promise<SupplementRegimenReadback[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const params: unknown[] = [userId];
    let where = "WHERE user_id = $1";
    if (!options.includeInactive) {
        where += " AND active";
    }
    if (options.productId !== undefined) {
        params.push(options.productId);
        where += ` AND product_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `${REGIMEN_SELECT} ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
    );
    const readbacks: SupplementRegimenReadback[] = [];
    for (const row of rows as RegimenRow[]) {
        readbacks.push(await assembleRegimenReadback(pool, row));
    }
    return readbacks;
}

export async function setSupplementRegimenActive(
    pool: Pool,
    userId: string,
    regimenId: string,
    active: boolean,
): Promise<{ regimen: SupplementRegimenReadback; changed: boolean }> {
    return withTransaction(pool, async (client) => {
        // Lock the regimen row (user-scoped) so concurrent state flips
        // serialize here.
        const { rows } = await client.query(
            `${REGIMEN_SELECT} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [regimenId, userId],
        );
        const row = rows[0] as RegimenRow | undefined;
        if (!row) {
            // Unknown id or another user's regimen: identical closed failure.
            throw new SupplementRegimenNotFoundError();
        }
        if (row.active === active) {
            // Idempotent no-op: no timestamp is rewritten.
            return {
                regimen: await assembleRegimenReadback(client, row),
                changed: false,
            };
        }
        if (active) {
            // Reactivation requires the bound product to still be active.
            const { rows: productRows } = await client.query(
                `SELECT status FROM supplement_products
                 WHERE id = $1 AND user_id = $2`,
                [row.product_id, userId],
            );
            const product = productRows[0] as { status: string } | undefined;
            if (!product || product.status !== "active") {
                throw new SupplementProductNotFoundError();
            }
        }
        const { rows: updated } = await client.query(
            `UPDATE supplement_regimens
             SET active = $2,
                 deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END,
                 updated_at = now()
             WHERE id = $1
             RETURNING id`,
            [regimenId, active],
        );
        const updatedRow = await readRegimenRow(
            client,
            (updated[0] as { id: string }).id,
        );
        if (!updatedRow) throw new Error("failed to read updated regimen");
        return {
            regimen: await assembleRegimenReadback(client, updatedRow),
            changed: true,
        };
    });
}

// ===========================================================================
// PRODUCT RESOLUTION (Slice 5, read-only)
// ===========================================================================
// Exact, lexical, current-version-only matching: a normalized alias equals a
// stored normalized_alias, or the caller's normalized input equals the
// normalized display/short name. Never fuzzy, never a silent pick: zero
// matches is not_found, one is resolved, more than one is ambiguous with the
// full candidate list so the agent host can ask the user. Deleted products
// and other users' products are indistinguishable from nonexistent ones.

export interface ResolveSupplementProductResult {
    resolution_status: "resolved" | "ambiguous" | "not_found";
    candidates: ResolvedProductCandidate[];
}

interface ResolutionRow {
    id: string;
    category: SupplementProductCategory;
    current_version: number;
    display_name: string;
    short_name: string | null;
    brand: string | null;
    form: string | null;
    matched_alias: string | null;
}

async function matchProductsByAlias(
    q: Queryable,
    userId: string,
    normalized: string,
): Promise<ResolvedProductCandidate[]> {
    const { rows } = await q.query(
        `SELECT p.id, p.category, p.current_version,
                v.display_name, v.short_name, v.brand, v.form,
                (SELECT a.alias FROM supplement_product_aliases a
                  WHERE a.product_id = p.id AND a.version = p.current_version
                    AND a.normalized_alias = $2
                  ORDER BY lower(a.alias), a.alias LIMIT 1) AS matched_alias
         FROM supplement_products p
         JOIN supplement_product_versions v
           ON v.product_id = p.id AND v.version = p.current_version
         WHERE p.user_id = $1 AND p.status = 'active'
         ORDER BY lower(v.display_name), p.id`,
        [userId, normalized],
    );
    const candidates: ResolvedProductCandidate[] = [];
    for (const row of rows as ResolutionRow[]) {
        let matched = row.matched_alias;
        if (matched === null) {
            // Name fallback: normalized equality against the current
            // display/short name (NFKC + case folding happens here, not in
            // SQL, so it matches normalizeSupplementAlias exactly).
            if (normalizeSupplementAlias(row.display_name) === normalized) {
                matched = row.display_name;
            } else if (
                row.short_name !== null &&
                normalizeSupplementAlias(row.short_name) === normalized
            ) {
                matched = row.short_name;
            }
        }
        if (matched === null) continue;
        candidates.push({
            product_id: row.id,
            category: row.category,
            display_name: row.display_name,
            brand: row.brand,
            form: row.form,
            current_version: row.current_version,
            matched_alias: matched,
        });
    }
    return candidates;
}

export async function resolveSupplementProduct(
    pool: Queryable,
    userId: string,
    query: { product_id?: string; alias?: string },
): Promise<ResolveSupplementProductResult> {
    const hasId = query.product_id !== undefined;
    const hasAlias = query.alias !== undefined;
    if (hasId === hasAlias) {
        throw new SupplementValidationError([
            "exactly one of product_id or alias must be supplied",
        ]);
    }

    if (hasId) {
        const { rows } = await pool.query(
            `SELECT p.id, p.category, p.current_version,
                    v.display_name, v.brand, v.form
             FROM supplement_products p
             JOIN supplement_product_versions v
               ON v.product_id = p.id AND v.version = p.current_version
             WHERE p.id = $1 AND p.user_id = $2 AND p.status = 'active'`,
            [query.product_id, userId],
        );
        const row = rows[0] as
            | {
                  id: string;
                  category: SupplementProductCategory;
                  current_version: number;
                  display_name: string;
                  brand: string | null;
                  form: string | null;
              }
            | undefined;
        if (!row) {
            return { resolution_status: "not_found", candidates: [] };
        }
        return {
            resolution_status: "resolved",
            candidates: [
                {
                    product_id: row.id,
                    category: row.category,
                    display_name: row.display_name,
                    brand: row.brand,
                    form: row.form,
                    current_version: row.current_version,
                    matched_alias: row.display_name,
                },
            ],
        };
    }

    const normalized = normalizeSupplementAlias(query.alias!);
    if (normalized === null) {
        return { resolution_status: "not_found", candidates: [] };
    }
    const candidates = await matchProductsByAlias(pool, userId, normalized);
    if (candidates.length === 0) {
        return { resolution_status: "not_found", candidates: [] };
    }
    return {
        resolution_status: candidates.length === 1 ? "resolved" : "ambiguous",
        candidates,
    };
}

// ===========================================================================
// SUPPLEMENT INTAKE FACTS (Slice 5, append-only)
// ===========================================================================
// Facts are inserted, never updated or deleted: a correction appends a new
// fact carrying reason/actor/supersedes audit metadata. Snapshots — one row
// per label nutrient of the bound version, scaled by servings — are written
// only for `done` facts, atomically in the same transaction, and are never
// updated; a later label revision can never rewrite intake history.
//
// This slice performs NO caloric meal linkage: neither sports_nutrition nor
// supplement intakes touch meal_events or supplement_intake_meal_links (that
// bridge is Slice 6). Idempotency is serialized by the database on
// uniq_supplement_intake_user_idem; the unique index, not a lookup, anchors
// concurrent same-key races.

export interface LogSupplementIntakeCommand {
    user_id: string;
    /** Exactly one of product_id / alias / regimen_id. */
    product_id?: string | null;
    alias?: string | null;
    /** Only with product_id/alias; defaults to current at write time. */
    product_version?: number | null;
    /** Implies the regimen's bound product/version. */
    regimen_id?: string | null;
    servings: number;
    /** Strict ISO-8601 with explicit offset, at most 24h in the future. */
    occurred_at: string;
    state_action: SupplementIntakeStateAction;
    reason?: string | null;
    supersedes_intake_id?: string | null;
    idempotency_key: string;
    actor: string;
}

export interface SupplementIntakeSnapshotReadback {
    nutrient_key: string;
    unit: string;
    original_amount: number;
    scaled_amount: number;
}

export interface SupplementIntakeFactReadback {
    intake_id: string;
    product_id: string;
    product_version: number;
    /** Display name of the BOUND version, not the current one. */
    product_display_name: string;
    category: SupplementProductCategory;
    regimen_id: string | null;
    servings: number;
    occurred_at: string;
    /** Raw action (done|missed|cleared) — audit truth. */
    state_action: SupplementIntakeStateAction;
    /** Public projection of THIS fact: exactly undefined|done|missed. */
    visible_state: SupplementIntakeVisibleState;
    reason: string | null;
    actor: string;
    supersedes_intake_id: string | null;
    created_at: string;
    /** Empty for missed/cleared facts. */
    nutrient_snapshots: SupplementIntakeSnapshotReadback[];
}

export interface LogSupplementIntakeResult {
    intake: SupplementIntakeFactReadback;
    deduplicated: boolean;
    /** Present when a done sports_nutrition intake also created a snack event. */
    snack_event_id?: string;
    /** Present when a done sports_nutrition intake also created a snack event. */
    snack_version?: number;
}

const INTAKE_STATE_ACTIONS: readonly string[] = ["done", "missed", "cleared"];

/** Future sanity bound for occurred_at (mirrors meal-event conventions). */
const OCCURRED_AT_MAX_FUTURE_MS = 24 * 3600 * 1000;

interface NormalizedIntakeFields {
    servings: number;
    occurred_at: string;
    state_action: SupplementIntakeStateAction;
    reason: string | null;
    supersedes_intake_id: string | null;
    idempotency_key: string;
}

function validateIntakeFields(
    command: LogSupplementIntakeCommand,
): NormalizedIntakeFields {
    const errors: string[] = [];

    const productId = optionalText(command.product_id);
    const alias = optionalText(command.alias);
    const regimenId = optionalText(command.regimen_id);
    const selectors = [productId, alias, regimenId].filter(
        (s) => s !== null,
    ).length;
    if (selectors !== 1) {
        errors.push(
            "exactly one of product_id, alias, or regimen_id must be supplied",
        );
    }
    if (regimenId !== null && command.product_version != null) {
        errors.push(
            "product_version must not be combined with regimen_id (the regimen binds the version)",
        );
    }
    if (command.product_version != null) {
        if (
            typeof command.product_version !== "number" ||
            !Number.isInteger(command.product_version) ||
            command.product_version < 1
        ) {
            errors.push("product_version must be a positive integer");
        }
    }

    if (
        typeof command.servings !== "number" ||
        !Number.isFinite(command.servings) ||
        command.servings <= 0
    ) {
        errors.push("servings must be a finite positive number");
    }

    if (!isStrictIsoTimestamp(command.occurred_at)) {
        errors.push(
            "occurred_at must be a strict ISO-8601 timestamp with an explicit offset",
        );
    } else if (
        Date.parse(command.occurred_at) >
        Date.now() + OCCURRED_AT_MAX_FUTURE_MS
    ) {
        errors.push("occurred_at must not be more than 24h in the future");
    }

    if (!INTAKE_STATE_ACTIONS.includes(command.state_action)) {
        errors.push("state_action must be 'done', 'missed', or 'cleared'");
    }

    const idempotencyKey = optionalText(command.idempotency_key);
    if (idempotencyKey === null) {
        errors.push("idempotency_key must be a non-empty string");
    }
    if (optionalText(command.actor) === null) {
        errors.push("actor must be a non-empty string");
    }

    if (errors.length > 0) {
        throw new SupplementValidationError(errors);
    }
    return {
        servings: command.servings,
        occurred_at: command.occurred_at,
        state_action: command.state_action,
        reason: optionalText(command.reason),
        supersedes_intake_id: optionalText(command.supersedes_intake_id),
        idempotency_key: idempotencyKey!,
    };
}

interface IntakeFactRow {
    id: string;
    user_id: string;
    product_id: string;
    product_version: number;
    regimen_id: string | null;
    servings: string | number;
    occurred_at: Date | string;
    state_action: SupplementIntakeStateAction;
    reason: string | null;
    actor: string;
    supersedes_intake_id: string | null;
    idempotency_key: string;
    created_at: Date | string;
}

const INTAKE_SELECT = `
    SELECT id, user_id, product_id, product_version, regimen_id, servings,
           occurred_at, state_action, reason, actor, supersedes_intake_id,
           idempotency_key, created_at
    FROM supplement_intake_events`;

async function assembleIntakeReadback(
    q: Queryable,
    row: IntakeFactRow,
): Promise<SupplementIntakeFactReadback> {
    const { rows: productRows } = await q.query(
        `SELECT v.display_name, p.category
         FROM supplement_product_versions v
         JOIN supplement_products p ON p.id = v.product_id
         WHERE v.product_id = $1 AND v.version = $2`,
        [row.product_id, row.product_version],
    );
    const product = productRows[0] as
        | { display_name: string; category: SupplementProductCategory }
        | undefined;
    if (!product) throw new Error("intake bound version row is missing");
    const { rows: snapshotRows } = await q.query(
        `SELECT nutrient_key, unit, original_amount, scaled_amount
         FROM supplement_intake_nutrient_snapshots
         WHERE intake_id = $1
         ORDER BY nutrient_key, unit`,
        [row.id],
    );
    return {
        intake_id: row.id,
        product_id: row.product_id,
        product_version: row.product_version,
        product_display_name: product.display_name,
        category: product.category,
        regimen_id: row.regimen_id,
        servings: Number(row.servings),
        occurred_at: iso(row.occurred_at),
        state_action: row.state_action,
        visible_state: projectIntakeVisibleState(row.state_action),
        reason: row.reason,
        actor: row.actor,
        supersedes_intake_id: row.supersedes_intake_id,
        created_at: iso(row.created_at),
        nutrient_snapshots: snapshotRows.map((s) => ({
            nutrient_key: s.nutrient_key as string,
            unit: s.unit as string,
            original_amount: Number(s.original_amount),
            scaled_amount: Number(s.scaled_amount),
        })),
    };
}

// Millisecond-normalized occurred_at for fingerprint identity: timestamptz
// round-trips lose string identity, so identity compares instants.
function intakeIdentityFingerprint(
    identity: {
        user_id: string;
        idempotency_key: string;
        product_id: string;
        product_version: number;
        servings: number;
        state_action: SupplementIntakeStateAction;
    },
    occurredAt: Date | string,
): string {
    const normalized =
        occurredAt instanceof Date
            ? occurredAt.toISOString()
            : new Date(Date.parse(occurredAt)).toISOString();
    return deriveSupplementIntakeIdempotencyFingerprint({
        ...identity,
        occurred_at: normalized,
    });
}

export async function logSupplementIntake(
    pool: Pool,
    command: LogSupplementIntakeCommand,
    opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<LogSupplementIntakeResult> {
    const fields = validateIntakeFields(command);
    const regimenId = optionalText(command.regimen_id);
    const directProductId = optionalText(command.product_id);
    const alias = optionalText(command.alias);

    // Concurrent same-key logs serialize on uniq_supplement_intake_user_idem:
    // the loser's fact insert aborts with a unique violation once the winner
    // commits, and the retry converges on the winner's fact as a deduplicated
    // readback or a stable idempotency_conflict — never a second fact.
    const MAX_LOG_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
        try {
            return await withTransaction(pool, async (client) => {
                // Resolve the product selection: direct id | unique alias |
                // regimen binding. An ambiguous alias fails before any write.
                let productId: string;
                let version: number | null = command.product_version ?? null;
                if (regimenId !== null) {
                    const { rows: regimenRows } = await client.query(
                        `${REGIMEN_SELECT} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                        [regimenId, command.user_id],
                    );
                    const regimen = regimenRows[0] as RegimenRow | undefined;
                    if (!regimen) {
                        throw new SupplementRegimenNotFoundError();
                    }
                    if (!regimen.active) {
                        throw new SupplementRegimenInactiveError();
                    }
                    productId = regimen.product_id;
                    version = regimen.product_version;
                } else if (directProductId !== null) {
                    productId = directProductId;
                } else {
                    const normalized = normalizeSupplementAlias(alias!);
                    if (normalized === null) {
                        throw new SupplementValidationError([
                            "alias must not be empty",
                        ]);
                    }
                    const candidates = await matchProductsByAlias(
                        client,
                        command.user_id,
                        normalized,
                    );
                    if (candidates.length === 0) {
                        throw new SupplementProductNotFoundError();
                    }
                    if (candidates.length > 1) {
                        throw new SupplementAliasAmbiguousError(candidates);
                    }
                    productId = candidates[0]!.product_id;
                }

                // Lock the product root (user-scoped) and verify active.
                const { rows: rootRows } = await client.query(
                    `SELECT id, user_id, category, status, current_version, created_at, updated_at
                     FROM supplement_products
                     WHERE id = $1 AND user_id = $2
                     FOR UPDATE`,
                    [productId, command.user_id],
                );
                const root = rootRows[0] as ProductRootRow | undefined;
                if (!root || root.status !== "active") {
                    throw new SupplementProductNotFoundError();
                }

                const boundVersion = version ?? root.current_version;
                const { rows: versionRows } = await client.query(
                    `SELECT 1 FROM supplement_product_versions
                     WHERE product_id = $1 AND version = $2 AND user_id = $3`,
                    [root.id, boundVersion, command.user_id],
                );
                if (versionRows.length === 0) {
                    throw new SupplementProductVersionNotFoundError();
                }

                // Supersession is audit metadata: the target must be an
                // existing same-user fact for the same product (any version).
                if (fields.supersedes_intake_id !== null) {
                    const { rows: targetRows } = await client.query(
                        `SELECT product_id FROM supplement_intake_events
                         WHERE id = $1 AND user_id = $2`,
                        [fields.supersedes_intake_id, command.user_id],
                    );
                    const target = targetRows[0] as
                        { product_id: string } | undefined;
                    if (!target) {
                        throw new SupplementValidationError([
                            "supersedes_intake_id must reference an existing intake fact",
                        ]);
                    }
                    if (target.product_id !== root.id) {
                        throw new SupplementValidationError([
                            "supersedes_intake_id must reference a fact for the same product",
                        ]);
                    }
                }

                const identity = {
                    user_id: command.user_id,
                    idempotency_key: fields.idempotency_key,
                    product_id: root.id,
                    product_version: boundVersion,
                    servings: fields.servings,
                    state_action: fields.state_action,
                };
                const fingerprint = intakeIdentityFingerprint(
                    identity,
                    fields.occurred_at,
                );

                // Retry convergence on (user_id, idempotency_key).
                const { rows: existingRows } = await client.query(
                    `${INTAKE_SELECT} WHERE user_id = $1 AND idempotency_key = $2`,
                    [command.user_id, fields.idempotency_key],
                );
                const existing = existingRows[0] as IntakeFactRow | undefined;
                if (existing) {
                    const existingFingerprint = intakeIdentityFingerprint(
                        {
                            user_id: existing.user_id,
                            idempotency_key: existing.idempotency_key,
                            product_id: existing.product_id,
                            product_version: existing.product_version,
                            servings: Number(existing.servings),
                            state_action: existing.state_action,
                        },
                        existing.occurred_at,
                    );
                    if (existingFingerprint !== fingerprint) {
                        throw new SupplementIdempotencyConflictError();
                    }
                    const dedupResult: LogSupplementIntakeResult = {
                        intake: await assembleIntakeReadback(client, existing),
                        deduplicated: true,
                    };
                    // Re-read the link if one exists for this intake (retry convergence).
                    const { rows: linkRows } = await client.query(
                        `SELECT event_id, version FROM supplement_intake_meal_links
                         WHERE intake_id = $1`,
                        [existing.id],
                    );
                    if (linkRows.length > 0) {
                        const link = linkRows[0] as {
                            event_id: string;
                            version: number;
                        };
                        dedupResult.snack_event_id = link.event_id;
                        dedupResult.snack_version = link.version;
                    }
                    return dedupResult;
                }

                const { rows: inserted } = await client.query(
                    `INSERT INTO supplement_intake_events
                        (user_id, product_id, product_version, regimen_id,
                         servings, occurred_at, state_action, reason, actor,
                         supersedes_intake_id, idempotency_key)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     RETURNING id`,
                    [
                        command.user_id,
                        root.id,
                        boundVersion,
                        regimenId,
                        fields.servings,
                        fields.occurred_at,
                        fields.state_action,
                        fields.reason,
                        optionalText(command.actor),
                        fields.supersedes_intake_id,
                        fields.idempotency_key,
                    ],
                );
                const intakeId = (inserted[0] as { id: string }).id;

                // Snapshots pin the consumed label truth: one row per label
                // nutrient of the bound version, scaled in PostgreSQL
                // numeric arithmetic, only for `done` facts.
                if (fields.state_action === "done") {
                    await client.query(
                        `INSERT INTO supplement_intake_nutrient_snapshots
                            (intake_id, user_id, product_id, product_version,
                             nutrient_key, unit, original_amount, scaled_amount,
                             source_evidence)
                         SELECT $1, $2, $3, $4, nutrient_key, unit, amount,
                                amount * $5::numeric, source_evidence
                         FROM supplement_product_nutrients
                         WHERE product_id = $3 AND version = $4`,
                        [
                            intakeId,
                            command.user_id,
                            root.id,
                            boundVersion,
                            fields.servings,
                        ],
                    );
                }

                // ---------------------------------------------------------------------------
                // Slice 6: caloric sports-nutrition done intake → snack meal-event link
                // ---------------------------------------------------------------------------
                let snackEventId: string | undefined;
                let snackVersion: number | undefined;

                if (
                    fields.state_action === "done" &&
                    root.category === "sports_nutrition"
                ) {
                    // 1. Fetch the bound version's display_name for the snack description.
                    const { rows: labelRows } = await client.query(
                        `SELECT display_name FROM supplement_product_versions
                         WHERE product_id = $1 AND version = $2`,
                        [root.id, boundVersion],
                    );
                    const boundLabel = labelRows[0] as
                        { display_name: string } | undefined;
                    // display_name is NOT NULL and the version row was verified
                    // above; a missing row here is corruption, not a formatting
                    // case. Fail closed rather than fabricating a label.
                    if (!boundLabel) {
                        throw new Error(
                            "snack linkage could not read the bound label version display_name",
                        );
                    }
                    const description = boundLabel.display_name;

                    // 2. Fetch the scaled snapshot nutrients that were just inserted
                    //    (visible inside the same transaction).
                    const { rows: snapRows } = await client.query(
                        `SELECT nutrient_key, scaled_amount
                         FROM supplement_intake_nutrient_snapshots
                         WHERE intake_id = $1
                           AND nutrient_key = ANY($2::text[])
                         ORDER BY nutrient_key`,
                        [intakeId, FOOD_COMPATIBLE_NUTRIENT_KEYS],
                    );

                    // 3. Build the "own" nutrient payload with FOOD_COMPATIBLE_NUTRIENT_KEYS only.
                    const ownNutrients: Partial<Nutrients> = {};
                    for (const snap of snapRows as Array<{
                        nutrient_key: string;
                        scaled_amount: string | number;
                    }>) {
                        // pg returns numeric as string; convert explicitly and
                        // fail closed on any non-finite value or non-food key
                        // instead of narrowing silently.
                        if (!isFoodCompatibleNutrientKey(snap.nutrient_key)) {
                            throw new Error(
                                `snack linkage read a non-food nutrient key: ${snap.nutrient_key}`,
                            );
                        }
                        const scaled = Number(snap.scaled_amount);
                        if (!Number.isFinite(scaled)) {
                            throw new Error(
                                `snack linkage read a non-numeric scaled amount for ${snap.nutrient_key}`,
                            );
                        }
                        ownNutrients[snap.nutrient_key] = scaled;
                    }

                    // 4. Build CreateMealEventCommand with label-specific provenance.
                    const snackIdempotencyKey = `snack:suppl-intake:${intakeId}`;
                    const cmd: CreateMealEventCommand = {
                        user_id: command.user_id,
                        idempotency_key: snackIdempotencyKey,
                        reported_at: fields.occurred_at,
                        consumed_at: fields.occurred_at,
                        meal_type: "snack",
                        items: [
                            {
                                ordinal: 0,
                                raw_item_text: description,
                                normalized_name: description,
                            },
                        ],
                        inputs: [
                            {
                                source_kind: "photo_ocr",
                                content: `Supplement label nutrients from product ${root.id} v${boundVersion}`,
                                metadata: {
                                    intake_id: intakeId,
                                    product_id: root.id,
                                    product_version: boundVersion,
                                },
                            },
                        ],
                        media: [],
                        provider_results: [
                            {
                                provider: "own",
                                status: "succeeded",
                                request_fingerprint: `suppl-snack:${intakeId}`,
                                algorithm_version: "label-compat-v1",
                                source_id: `suppl-snack:${intakeId}`,
                                nutrients: ownNutrients,
                                // Label-derived transparent provenance: the exact
                                // historical label version this snack was
                                // computed from. No external provider call.
                                provenance: {
                                    kind: "supplement_label",
                                    intake_id: intakeId,
                                    product_id: root.id,
                                    product_version: boundVersion,
                                    servings: fields.servings,
                                },
                                raw_payload: {
                                    source: "supplement_intake_nutrient_snapshots",
                                    scaled_by_servings: fields.servings,
                                    nutrients: ownNutrients,
                                },
                                basis: "per_meal",
                                units: "g_and_kcal",
                            },
                        ],
                        parser_policy_version: "label-compat-v1",
                        created_by: "supplement-log",
                    };

                    const snackResult = await createMealEvent(
                        pool,
                        cmd,
                        client,
                    );
                    snackEventId = snackResult.event_id;
                    snackVersion = snackResult.version;

                    // 5. Insert the bidirectional link row.
                    const linkFingerprint = `suppl-meal:${sha256Hex([
                        intakeId,
                        snackEventId,
                        String(snackVersion),
                    ])}`;
                    await client.query(
                        `INSERT INTO supplement_intake_meal_links
                            (user_id, intake_id, event_id, version, product_id,
                             product_version, idempotency_fingerprint)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (intake_id) DO NOTHING`,
                        [
                            command.user_id,
                            intakeId,
                            snackEventId,
                            snackVersion,
                            root.id,
                            boundVersion,
                            linkFingerprint,
                        ],
                    );
                }

                await opts.beforeCommit?.();

                const { rows: factRows } = await client.query(
                    `${INTAKE_SELECT} WHERE id = $1`,
                    [intakeId],
                );
                const fact = factRows[0] as IntakeFactRow | undefined;
                if (!fact) throw new Error("failed to read logged intake");
                return {
                    intake: await assembleIntakeReadback(client, fact),
                    deduplicated: false,
                    snack_event_id: snackEventId,
                    snack_version: snackVersion,
                };
            });
        } catch (err) {
            if (
                attempt < MAX_LOG_ATTEMPTS &&
                isKeyRaceViolation(err, "uniq_supplement_intake_user_idem")
            ) {
                continue;
            }
            throw err;
        }
    }
}

// ===========================================================================
// INTAKE HISTORY & REGIMEN STATUS READS (Slice 5, read-only)
// ===========================================================================
// Both reads are pure queries: they derive, never persist. "Unmarked" is a
// derived `undefined` occurrence in the result — never a stored row — and
// nothing here marks, schedules, or reminds.

export async function getSupplementIntakes(
    pool: Queryable,
    userId: string,
    options: {
        productId?: string;
        regimenId?: string;
        from?: string;
        to?: string;
        limit?: number;
    } = {},
): Promise<SupplementIntakeFactReadback[]> {
    const errors: string[] = [];
    if (options.from !== undefined && !isStrictIsoTimestamp(options.from)) {
        errors.push("from must be a strict ISO-8601 timestamp");
    }
    if (options.to !== undefined && !isStrictIsoTimestamp(options.to)) {
        errors.push("to must be a strict ISO-8601 timestamp");
    }
    if (errors.length > 0) {
        throw new SupplementValidationError(errors);
    }

    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const params: unknown[] = [userId];
    let where = "WHERE user_id = $1";
    if (options.productId !== undefined) {
        params.push(options.productId);
        where += ` AND product_id = $${params.length}`;
    }
    if (options.regimenId !== undefined) {
        params.push(options.regimenId);
        where += ` AND regimen_id = $${params.length}`;
    }
    if (options.from !== undefined) {
        params.push(options.from);
        where += ` AND occurred_at >= $${params.length}`;
    }
    if (options.to !== undefined) {
        params.push(options.to);
        where += ` AND occurred_at <= $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `${INTAKE_SELECT} ${where}
         ORDER BY occurred_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
    );
    const readbacks: SupplementIntakeFactReadback[] = [];
    for (const row of rows as IntakeFactRow[]) {
        readbacks.push(await assembleIntakeReadback(pool, row));
    }
    return readbacks;
}

export interface RegimenOccurrenceStatus {
    local_date: string;
    local_time: string;
    /** Exactly undefined|done|missed — never a stored row. */
    visible_state: SupplementIntakeVisibleState;
    latest_intake_id: string | null;
}

export interface SupplementRegimenStatusReadback {
    regimen: SupplementRegimenReadback;
    occurrences: RegimenOccurrenceStatus[];
}

/** Bounded status/reporting windows: at most 92 inclusive days. */
export const REGIMEN_STATUS_MAX_WINDOW_DAYS = 92;

/**
 * The shared bounded-window validation surface (Slice 7): real YYYY-MM-DD
 * dates, from <= to, span at most REGIMEN_STATUS_MAX_WINDOW_DAYS inclusive
 * days, and — when supplied — a valid IANA timezone. Both Release-2
 * reporting reads validate through this; the regimen-status read delegates
 * to it unchanged.
 */
export function validateBoundedWindow(window: {
    from_date: string;
    to_date: string;
    timezone?: string;
}): void {
    const errors: string[] = [];
    if (!isLocalDateString(window.from_date)) {
        errors.push("from_date must be a real YYYY-MM-DD date");
    }
    if (!isLocalDateString(window.to_date)) {
        errors.push("to_date must be a real YYYY-MM-DD date");
    }
    if (errors.length === 0) {
        if (window.to_date < window.from_date) {
            errors.push("to_date must be on or after from_date");
        } else {
            const days =
                (Date.parse(`${window.to_date}T00:00:00Z`) -
                    Date.parse(`${window.from_date}T00:00:00Z`)) /
                    86400000 +
                1;
            if (days > REGIMEN_STATUS_MAX_WINDOW_DAYS) {
                errors.push(
                    `the window must be at most ${REGIMEN_STATUS_MAX_WINDOW_DAYS} days`,
                );
            }
        }
    }
    if (window.timezone !== undefined && !validateTz(window.timezone)) {
        errors.push("timezone must be a valid IANA timezone name");
    }
    if (errors.length > 0) {
        throw new SupplementValidationError(errors);
    }
}

function validateStatusWindow(window: {
    from_date: string;
    to_date: string;
}): void {
    validateBoundedWindow(window);
}

export async function getSupplementRegimenStatus(
    pool: Queryable,
    userId: string,
    regimenId: string,
    window: { from_date: string; to_date: string },
): Promise<SupplementRegimenStatusReadback> {
    validateStatusWindow(window);
    const row = await readRegimenRow(pool, regimenId);
    // Unknown id or another user's regimen: identical closed failure.
    if (!row || row.user_id !== userId) {
        throw new SupplementRegimenNotFoundError();
    }

    const occurrences = deriveRegimenOccurrences(
        row.schedule,
        row.starts_on,
        row.ends_on,
        window.from_date,
        window.to_date,
    );

    // Facts claim an occurrence only via regimen binding + local date in the
    // regimen's timezone. Ad-hoc facts (regimen_id NULL) never claim one.
    const { rows: factRows } = await pool.query(
        `SELECT id, regimen_id, occurred_at, state_action, created_at
         FROM supplement_intake_events
         WHERE regimen_id = $1 AND user_id = $2
         ORDER BY created_at, id`,
        [regimenId, userId],
    );
    const factsByLocalDate = new Map<string, IntakeFactForProjection[]>();
    for (const fact of factRows as IntakeFactForProjection[]) {
        const localDate = dateInTz(fact.occurred_at, row.schedule.timezone);
        const list = factsByLocalDate.get(localDate) ?? [];
        list.push(fact);
        factsByLocalDate.set(localDate, list);
    }

    return {
        regimen: await assembleRegimenReadback(pool, row),
        occurrences: occurrences.map((occurrence) => {
            const facts = factsByLocalDate.get(occurrence.local_date) ?? [];
            const ordered = [...facts].sort((a, b) => {
                const at =
                    a.created_at instanceof Date
                        ? a.created_at.getTime()
                        : Date.parse(a.created_at);
                const bt =
                    b.created_at instanceof Date
                        ? b.created_at.getTime()
                        : Date.parse(b.created_at);
                if (at !== bt) return at - bt;
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            });
            return {
                local_date: occurrence.local_date,
                local_time: occurrence.local_time,
                visible_state: reduceOccurrenceState(facts),
                latest_intake_id:
                    ordered.length === 0
                        ? null
                        : ordered[ordered.length - 1]!.id,
            };
        }),
    };
}

// ===========================================================================
// NUTRITION SUMMARY READ (Slice 7, read-only)
// ===========================================================================
// Bounded date-range summary in an explicit IANA timezone separating the food
// contribution (meal events, excluding supplement-linked snack events so
// nothing is counted twice), the supplement/sports contribution (immutable
// done-intake label snapshots, correction-aware), and a combined total —
// grouped strictly by exact nutrient key + unit with no unit conversion.
// Absent values stay absent; an explicit stored zero stays 0. Purely derived:
// reads nothing but projections of stored facts and writes nothing.

export interface SummaryNutrientRow {
    nutrient_key: string;
    unit: string;
    amount: number;
    events_with_value: number;
}

export interface SummarySupplementNutrientRow {
    nutrient_key: string;
    unit: string;
    amount: number;
    intakes_with_value: number;
}

export interface SummaryCombinedRow {
    nutrient_key: string;
    unit: string;
    food_amount: number | null;
    supplement_amount: number | null;
    total: number;
}

export interface SupplementNutritionSummary {
    from_date: string;
    to_date: string;
    timezone: string;
    food: {
        meal_event_count: number;
        linked_snack_event_count_excluded: number;
        nutrients: SummaryNutrientRow[];
    };
    supplements: {
        intake_fact_count_in_range: number;
        effective_done_intake_count: number;
        excluded_by_correction_count: number;
        nutrients: SummarySupplementNutrientRow[];
    };
    combined: SummaryCombinedRow[];
}

export interface SummaryWindow {
    from_date: string;
    to_date: string;
    timezone: string;
}

/** Exact UTC range of the validated inclusive local-date window (DST-safe). */
function boundedWindowUtcRange(window: SummaryWindow): {
    startUtc: Date;
    endUtc: Date;
} {
    return {
        startUtc: zonedDayStartUtc(window.from_date, window.timezone),
        endUtc: zonedNextDayStartUtc(window.to_date, window.timezone),
    };
}

/** Fail-closed numeric read: pg numerics arrive as strings; never coerce junk. */
function finiteNumeric(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        throw new Error(`non-finite numeric value read from the database`);
    }
    return n;
}

function compareNutrientIdentity(
    a: { nutrient_key: string; unit: string },
    b: { nutrient_key: string; unit: string },
): number {
    if (a.nutrient_key !== b.nutrient_key) {
        return a.nutrient_key < b.nutrient_key ? -1 : 1;
    }
    return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
}

/**
 * Food-side nutrient identities are fixed by the canonical model: calories
 * are kcal, the six gram fields are grams. A supplement snapshot combines
 * with food only when its stored (key, unit) matches exactly.
 */
const FOOD_CANONICAL_NUTRIENT_FIELDS = FOOD_COMPATIBLE_NUTRIENT_KEYS;

const FOOD_FIELD_IDENTITY: Record<
    string,
    { nutrient_key: string; unit: string }
> = Object.fromEntries(
    FOOD_CANONICAL_NUTRIENT_FIELDS.map((field) => [
        field,
        { nutrient_key: field, unit: field === "calories" ? "kcal" : "g" },
    ]),
);

/**
 * Candidate facts are fetched over a ±48 h widened UTC window: occurrence
 * identity uses the regimen timezone while the request window uses the
 * request timezone, so a fact just outside the exact window can still decide
 * which in-window fact is effective. Only effective done facts whose
 * occurred_at lies in the exact requested window contribute.
 */
const WINDOW_WIDEN_MS = 48 * 3600 * 1000;

interface EffectiveDoneFactsInWindow {
    /** All facts whose occurred_at lies in the exact requested UTC window. */
    factsInRange: IntakeFactForContribution[];
    /** Effective done facts in the exact window, in append order. */
    effectiveDone: IntakeFactForContribution[];
    /** Done facts in the exact window excluded by a later correction. */
    excludedByCorrection: number;
}

async function effectiveDoneFactsInWindow(
    pool: Queryable,
    userId: string,
    startUtc: Date,
    endUtc: Date,
): Promise<EffectiveDoneFactsInWindow> {
    const widenedStart = new Date(startUtc.getTime() - WINDOW_WIDEN_MS);
    const widenedEnd = new Date(endUtc.getTime() + WINDOW_WIDEN_MS);
    const { rows: factRows } = await pool.query(
        `SELECT id, product_id, regimen_id, occurred_at, state_action,
                supersedes_intake_id, created_at
         FROM supplement_intake_events
         WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
         ORDER BY created_at, id`,
        [userId, widenedStart.toISOString(), widenedEnd.toISOString()],
    );
    const facts = factRows as IntakeFactForContribution[];

    const regimenIds = [
        ...new Set(
            facts
                .map((f) => f.regimen_id)
                .filter((id): id is string => id !== null),
        ),
    ];
    const regimenTimezones = new Map<string, string>();
    if (regimenIds.length > 0) {
        const { rows: tzRows } = await pool.query(
            `SELECT id, timezone FROM supplement_regimens
             WHERE user_id = $1 AND id = ANY($2)`,
            [userId, regimenIds],
        );
        for (const row of tzRows as { id: string; timezone: string }[]) {
            regimenTimezones.set(row.id, row.timezone);
        }
    }

    const selection = selectEffectiveDoneFacts(facts, regimenTimezones);
    const startMs = startUtc.getTime();
    const endMs = endUtc.getTime();
    const inExactWindow = (fact: IntakeFactForContribution): boolean => {
        const t =
            fact.occurred_at instanceof Date
                ? fact.occurred_at.getTime()
                : Date.parse(fact.occurred_at);
        return t >= startMs && t < endMs;
    };
    const factsInRange = facts.filter(inExactWindow);
    const effectiveDone = selection.included.filter(inExactWindow);
    const effectiveIds = new Set(effectiveDone.map((f) => f.id));
    const excludedByCorrection = factsInRange.filter(
        (f) => f.state_action === "done" && !effectiveIds.has(f.id),
    ).length;
    return { factsInRange, effectiveDone, excludedByCorrection };
}

export async function getSupplementNutritionSummary(
    pool: Queryable,
    userId: string,
    window: SummaryWindow,
): Promise<SupplementNutritionSummary> {
    validateBoundedWindow(window);
    const { startUtc, endUtc } = boundedWindowUtcRange(window);

    // Food side: current-version canonical event-scope rows of active events
    // in range, excluding supplement-linked snack events so a sports intake
    // is never counted on both sides. SQL SUM/COUNT ignore NULLs, which is
    // exactly the presence semantics needed: canonical NULL contributes
    // nothing and is not counted present; an explicit 0 sums as 0 and counts.
    const { rows: foodRows } = await pool.query(
        `SELECT count(*)::int AS meal_event_count,
                SUM(c.calories) AS calories_sum, COUNT(c.calories)::int AS calories_count,
                SUM(c.protein_g) AS protein_g_sum, COUNT(c.protein_g)::int AS protein_g_count,
                SUM(c.carbs_g) AS carbs_g_sum, COUNT(c.carbs_g)::int AS carbs_g_count,
                SUM(c.fat_g) AS fat_g_sum, COUNT(c.fat_g)::int AS fat_g_count,
                SUM(c.fiber_g) AS fiber_g_sum, COUNT(c.fiber_g)::int AS fiber_g_count,
                SUM(c.sugar_g) AS sugar_g_sum, COUNT(c.sugar_g)::int AS sugar_g_count,
                SUM(c.alcohol_g) AS alcohol_g_sum, COUNT(c.alcohol_g)::int AS alcohol_g_count
         FROM meal_events e
         JOIN meal_event_versions v
             ON v.event_id = e.id AND v.version = e.current_version
         LEFT JOIN meal_event_canonical_results c
             ON c.event_id = v.event_id AND c.version = v.version
                AND c.ordinal IS NULL
         WHERE e.user_id = $1 AND e.status = 'active'
           AND e.consumed_at >= $2 AND e.consumed_at < $3
           AND NOT EXISTS (
               SELECT 1 FROM supplement_intake_meal_links l
               WHERE l.event_id = e.id AND l.user_id = $1
           )`,
        [userId, startUtc.toISOString(), endUtc.toISOString()],
    );
    const { rows: excludedRows } = await pool.query(
        `SELECT count(*)::int AS n
         FROM meal_events e
         WHERE e.user_id = $1 AND e.status = 'active'
           AND e.consumed_at >= $2 AND e.consumed_at < $3
           AND EXISTS (
               SELECT 1 FROM supplement_intake_meal_links l
               WHERE l.event_id = e.id AND l.user_id = $1
           )`,
        [userId, startUtc.toISOString(), endUtc.toISOString()],
    );

    const foodRow = foodRows[0] as Record<string, unknown>;
    const foodNutrients: SummaryNutrientRow[] = [];
    const foodAmounts: NutrientContributionAmount[] = [];
    for (const field of FOOD_CANONICAL_NUTRIENT_FIELDS) {
        const eventsWithValue = Number(foodRow[`${field}_count`]);
        if (eventsWithValue === 0) continue;
        const amount = finiteNumeric(foodRow[`${field}_sum`]);
        const { nutrient_key, unit } = FOOD_FIELD_IDENTITY[field]!;
        foodNutrients.push({
            nutrient_key,
            unit,
            amount,
            events_with_value: eventsWithValue,
        });
        foodAmounts.push({ nutrient_key, unit, amount });
    }

    // Supplement side: correction-aware effective done facts in the exact
    // window, then their immutable scaled snapshots aggregated per exact
    // (nutrient_key, unit) identity.
    const effective = await effectiveDoneFactsInWindow(
        pool,
        userId,
        startUtc,
        endUtc,
    );
    const supplementNutrients: SummarySupplementNutrientRow[] = [];
    const supplementAmounts: NutrientContributionAmount[] = [];
    if (effective.effectiveDone.length > 0) {
        const { rows: snapshotRows } = await pool.query(
            `SELECT intake_id, nutrient_key, unit, scaled_amount
             FROM supplement_intake_nutrient_snapshots
             WHERE user_id = $1 AND intake_id = ANY($2)`,
            [userId, effective.effectiveDone.map((f) => f.id)],
        );
        interface Aggregate {
            amount: number;
            intakeIds: Set<string>;
        }
        const byIdentity = new Map<string, Map<string, Aggregate>>();
        for (const row of snapshotRows as {
            intake_id: string;
            nutrient_key: string;
            unit: string;
            scaled_amount: unknown;
        }[]) {
            let byUnit = byIdentity.get(row.nutrient_key);
            if (byUnit === undefined) {
                byUnit = new Map();
                byIdentity.set(row.nutrient_key, byUnit);
            }
            let aggregate = byUnit.get(row.unit);
            if (aggregate === undefined) {
                aggregate = { amount: 0, intakeIds: new Set() };
                byUnit.set(row.unit, aggregate);
            }
            aggregate.amount += finiteNumeric(row.scaled_amount);
            aggregate.intakeIds.add(row.intake_id);
        }
        for (const [nutrient_key, byUnit] of byIdentity) {
            for (const [unit, aggregate] of byUnit) {
                supplementNutrients.push({
                    nutrient_key,
                    unit,
                    amount: aggregate.amount,
                    intakes_with_value: aggregate.intakeIds.size,
                });
                supplementAmounts.push({
                    nutrient_key,
                    unit,
                    amount: aggregate.amount,
                });
            }
        }
        supplementNutrients.sort(compareNutrientIdentity);
    }

    return {
        from_date: window.from_date,
        to_date: window.to_date,
        timezone: window.timezone,
        food: {
            meal_event_count: Number(foodRow.meal_event_count),
            linked_snack_event_count_excluded: Number(
                (excludedRows[0] as { n: number }).n,
            ),
            nutrients: foodNutrients,
        },
        supplements: {
            intake_fact_count_in_range: effective.factsInRange.length,
            effective_done_intake_count: effective.effectiveDone.length,
            excluded_by_correction_count: effective.excludedByCorrection,
            nutrients: supplementNutrients,
        },
        combined: combineNutrientContributions(foodAmounts, supplementAmounts),
    };
}

// ===========================================================================
// SUPPLEMENT DATA FLAGS READ (Slice 7, read-only)
// ===========================================================================
// Transparent, data-only flags over a bounded window in an explicit timezone:
// (1) the same nutrient key + unit recorded from two or more distinct
// products, (2) recorded daily totals compared against a product label's own
// explicitly stored maximum where one exists, (3) derived past-due
// occurrences of active regimens with no recorded state. These are
// recorded-data facts with no interpretation: no advice, no thresholds beyond
// what the label itself stores, and nothing is written — ever.

export interface DuplicateNutrientExposure {
    nutrient_key: string;
    unit: string;
    product_count: number;
    products: {
        product_id: string;
        display_name: string;
        recorded_amount: number;
    }[];
}

export interface LabelLimitComparison {
    product_id: string;
    product_version: number;
    display_name: string;
    nutrient_key: string;
    unit: string;
    local_date: string;
    recorded_total: number;
    label_limit_maximum: number;
    exceeds_label_limit: boolean;
}

export interface UnmarkedRegimenOccurrence {
    regimen_id: string;
    product_id: string;
    product_display_name: string;
    local_date: string;
    local_time: string;
    timezone: string;
}

export interface SupplementDataFlags {
    from_date: string;
    to_date: string;
    timezone: string;
    as_of: string;
    duplicate_nutrient_exposures: DuplicateNutrientExposure[];
    label_limit_comparisons: LabelLimitComparison[];
    unmarked_active_regimen_occurrences: UnmarkedRegimenOccurrence[];
}

export interface DataFlagsWindow {
    from_date: string;
    to_date: string;
    timezone: string;
    /** Strict ISO-8601; defaults to server now when absent. */
    as_of?: string;
}

export async function getSupplementDataFlags(
    pool: Queryable,
    userId: string,
    window: DataFlagsWindow,
): Promise<SupplementDataFlags> {
    validateBoundedWindow(window);
    if (window.as_of !== undefined && !isStrictIsoTimestamp(window.as_of)) {
        throw new SupplementValidationError([
            "as_of must be a strict ISO-8601 timestamp with an explicit offset",
        ]);
    }
    const asOf = window.as_of ?? new Date().toISOString();
    const { startUtc, endUtc } = boundedWindowUtcRange(window);

    const effective = await effectiveDoneFactsInWindow(
        pool,
        userId,
        startUtc,
        endUtc,
    );

    const duplicateExposures: DuplicateNutrientExposure[] = [];
    const limitComparisons: LabelLimitComparison[] = [];
    if (effective.effectiveDone.length > 0) {
        // Snapshots of the effective done facts, joined to the bound
        // version's display name and — only where one exists — the label's
        // own explicitly stored maximum. No limit row means no comparison,
        // never a fabricated threshold.
        const { rows } = await pool.query(
            `SELECT s.intake_id, s.product_id, s.product_version,
                    s.nutrient_key, s.unit, s.scaled_amount,
                    e.occurred_at, v.display_name, l.maximum_amount
             FROM supplement_intake_nutrient_snapshots s
             JOIN supplement_intake_events e
                 ON e.id = s.intake_id AND e.user_id = s.user_id
             JOIN supplement_product_versions v
                 ON v.product_id = s.product_id AND v.version = s.product_version
             LEFT JOIN supplement_product_label_limits l
                 ON l.product_id = s.product_id AND l.version = s.product_version
                AND l.nutrient_key = s.nutrient_key AND l.unit = s.unit
             WHERE s.user_id = $1 AND s.intake_id = ANY($2)`,
            [userId, effective.effectiveDone.map((f) => f.id)],
        );

        interface SnapshotRow {
            intake_id: string;
            product_id: string;
            product_version: number;
            nutrient_key: string;
            unit: string;
            scaled_amount: unknown;
            occurred_at: Date | string;
            display_name: string;
            maximum_amount: unknown;
        }

        // (1) Duplicate recorded exposure: same (key, unit) delivered by
        // effective done intakes of two or more DISTINCT products.
        interface ProductContribution {
            display_name: string;
            amount: number;
        }
        const exposureByIdentity = new Map<
            string,
            Map<string, Map<string, ProductContribution>>
        >();
        for (const row of rows as SnapshotRow[]) {
            let byUnit = exposureByIdentity.get(row.nutrient_key);
            if (byUnit === undefined) {
                byUnit = new Map();
                exposureByIdentity.set(row.nutrient_key, byUnit);
            }
            let byProduct = byUnit.get(row.unit);
            if (byProduct === undefined) {
                byProduct = new Map();
                byUnit.set(row.unit, byProduct);
            }
            const contribution = byProduct.get(row.product_id) ?? {
                display_name: row.display_name,
                amount: 0,
            };
            contribution.amount += finiteNumeric(row.scaled_amount);
            byProduct.set(row.product_id, contribution);
        }
        for (const [nutrient_key, byUnit] of exposureByIdentity) {
            for (const [unit, byProduct] of byUnit) {
                if (byProduct.size < 2) continue;
                const products = [...byProduct.entries()]
                    .map(([product_id, contribution]) => ({
                        product_id,
                        display_name: contribution.display_name,
                        recorded_amount: contribution.amount,
                    }))
                    .sort((a, b) => a.product_id.localeCompare(b.product_id));
                duplicateExposures.push({
                    nutrient_key,
                    unit,
                    product_count: products.length,
                    products,
                });
            }
        }
        duplicateExposures.sort(compareNutrientIdentity);

        // (2) Recorded daily totals vs the bound version's explicit label
        // limit, grouped by (product, version, key, unit, local date in the
        // REQUEST timezone). Facts, not alarms: every limit-bearing recorded
        // day is reported, whether or not it exceeds.
        interface LimitGroup {
            product_id: string;
            product_version: number;
            display_name: string;
            nutrient_key: string;
            unit: string;
            local_date: string;
            recorded_total: number;
            label_limit_maximum: number;
        }
        const limitGroups = new Map<string, LimitGroup>();
        for (const row of rows as SnapshotRow[]) {
            if (row.maximum_amount === null) continue;
            const localDate = dateInTz(row.occurred_at, window.timezone);
            const groupId = [
                row.product_id,
                row.product_version,
                row.nutrient_key,
                row.unit,
                localDate,
            ].join("");
            let group = limitGroups.get(groupId);
            if (group === undefined) {
                group = {
                    product_id: row.product_id,
                    product_version: row.product_version,
                    display_name: row.display_name,
                    nutrient_key: row.nutrient_key,
                    unit: row.unit,
                    local_date: localDate,
                    recorded_total: 0,
                    label_limit_maximum: finiteNumeric(row.maximum_amount),
                };
                limitGroups.set(groupId, group);
            }
            group.recorded_total += finiteNumeric(row.scaled_amount);
        }
        for (const group of limitGroups.values()) {
            limitComparisons.push({
                product_id: group.product_id,
                product_version: group.product_version,
                display_name: group.display_name,
                nutrient_key: group.nutrient_key,
                unit: group.unit,
                local_date: group.local_date,
                recorded_total: group.recorded_total,
                label_limit_maximum: group.label_limit_maximum,
                exceeds_label_limit:
                    group.recorded_total > group.label_limit_maximum,
            });
        }
        limitComparisons.sort((a, b) => {
            if (a.local_date !== b.local_date) {
                return a.local_date < b.local_date ? -1 : 1;
            }
            if (a.product_id !== b.product_id) {
                return a.product_id.localeCompare(b.product_id);
            }
            if (a.product_version !== b.product_version) {
                return a.product_version - b.product_version;
            }
            return compareNutrientIdentity(a, b);
        });
    }

    // (3) Derived past-due occurrences of ACTIVE regimens with no recorded
    // state. Occurrences are derived in each regimen's own timezone via the
    // same pure helpers regimen status uses; state is reduced from the same
    // fact bucketing. Nothing is materialized, scheduled, or marked.
    const { rows: regimenRows } = await pool.query(
        `SELECT r.id, r.product_id, r.product_version, r.schedule,
                to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
                to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on,
                v.display_name
         FROM supplement_regimens r
         JOIN supplement_product_versions v
             ON v.product_id = r.product_id AND v.version = r.product_version
         WHERE r.user_id = $1 AND r.active
         ORDER BY r.created_at, r.id`,
        [userId],
    );
    interface ActiveRegimenRow {
        id: string;
        product_id: string;
        product_version: number;
        schedule: RegimenSchedule;
        starts_on: string;
        ends_on: string | null;
        display_name: string;
    }
    const activeRegimens = regimenRows as ActiveRegimenRow[];
    const unmarkedOccurrences: UnmarkedRegimenOccurrence[] = [];
    if (activeRegimens.length > 0) {
        const { rows: factRows } = await pool.query(
            `SELECT id, regimen_id, occurred_at, state_action, created_at
             FROM supplement_intake_events
             WHERE user_id = $1 AND regimen_id = ANY($2)
             ORDER BY created_at, id`,
            [userId, activeRegimens.map((r) => r.id)],
        );
        const facts = factRows as IntakeFactForProjection[];
        const asOfMs = Date.parse(asOf);
        for (const regimen of activeRegimens) {
            const occurrences = deriveRegimenOccurrences(
                regimen.schedule,
                regimen.starts_on,
                regimen.ends_on,
                window.from_date,
                window.to_date,
            );
            if (occurrences.length === 0) continue;
            const factsByLocalDate = new Map<
                string,
                IntakeFactForProjection[]
            >();
            for (const fact of facts) {
                if (fact.regimen_id !== regimen.id) continue;
                const localDate = dateInTz(
                    fact.occurred_at,
                    regimen.schedule.timezone,
                );
                const list = factsByLocalDate.get(localDate) ?? [];
                list.push(fact);
                factsByLocalDate.set(localDate, list);
            }
            for (const occurrence of occurrences) {
                const state = reduceOccurrenceState(
                    factsByLocalDate.get(occurrence.local_date) ?? [],
                );
                if (state !== "undefined") continue;
                const [y, mo, d] = occurrence.local_date.split("-").map(Number);
                const [hh, mi] = occurrence.local_time.split(":").map(Number);
                const due = zonedWallClockToUtc(
                    y!,
                    mo!,
                    d!,
                    hh!,
                    mi!,
                    0,
                    regimen.schedule.timezone,
                ).instant;
                // Past-due boundary: exactly as_of counts, later does not.
                if (due.getTime() > asOfMs) continue;
                unmarkedOccurrences.push({
                    regimen_id: regimen.id,
                    product_id: regimen.product_id,
                    product_display_name: regimen.display_name,
                    local_date: occurrence.local_date,
                    local_time: occurrence.local_time,
                    timezone: regimen.schedule.timezone,
                });
            }
        }
        unmarkedOccurrences.sort((a, b) => {
            if (a.local_date !== b.local_date) {
                return a.local_date < b.local_date ? -1 : 1;
            }
            if (a.local_time !== b.local_time) {
                return a.local_time < b.local_time ? -1 : 1;
            }
            return a.regimen_id.localeCompare(b.regimen_id);
        });
    }

    return {
        from_date: window.from_date,
        to_date: window.to_date,
        timezone: window.timezone,
        as_of: asOf,
        duplicate_nutrient_exposures: duplicateExposures,
        label_limit_comparisons: limitComparisons,
        unmarked_active_regimen_occurrences: unmarkedOccurrences,
    };
}
