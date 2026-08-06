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
import { sha256Hex } from "./meal-types.js";
import { escapeLikePattern } from "./search.js";
import {
    deriveSupplementRegimenIdempotencyFingerprint,
    isSupplementProductCategory,
    normalizeSupplementAlias,
    stableStringify,
    validateLabelNutrients,
    validateRegimenSchedule,
    type RegimenSchedule,
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
