// ============================================================================
// FOOD-TRACKING DOMAIN CONTRACTS
// ============================================================================
// Shared branded/domain types and enums for the append-only meal-event model.
// Pure TypeScript: no database, no network, no Telegram/vision SDK types.
// Raw payloads stay unknown/JSON-compatible so external pipelines can be added
// later without changing these contracts.

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export type MealEventStatus = "active" | "deleted";

export type InputSourceKind =
    | "user_text"
    | "audio_transcript"
    | "photo_ocr"
    | "photo_vision"
    | "model_assumption";

// Precedence contract: lower integer wins. Explicit user text always outranks
// photo/OCR/vision-derived evidence; lower-precedence inputs are retained,
// never silently discarded.
export const INPUT_PRECEDENCE: Record<InputSourceKind, number> = {
    user_text: 10,
    audio_transcript: 20,
    photo_ocr: 30,
    photo_vision: 40,
    model_assumption: 50,
};

export type NutritionProvider = "nutrition-local" | "own" | "myfitnesspal";

const NUTRITION_PROVIDERS: readonly string[] = [
    "nutrition-local",
    "own",
    "myfitnesspal",
];

export function isNutritionProvider(value: string): value is NutritionProvider {
    return NUTRITION_PROVIDERS.includes(value);
}

export type ProviderResultStatus = "succeeded" | "failed" | "unavailable";

const PROVIDER_RESULT_STATUSES: readonly string[] = [
    "succeeded",
    "failed",
    "unavailable",
];

export function isProviderResultStatus(
    value: string,
): value is ProviderResultStatus {
    return PROVIDER_RESULT_STATUSES.includes(value);
}

export type CanonicalStatus = "pending" | "ready" | "low_confidence";

export type ConsensusStatus =
    | "two_agree_one_outlier"
    | "all_agree"
    | "no_consensus"
    | "insufficient_data";

export type SyncJournalState =
    "pending" | "in_flight" | "succeeded" | "failed" | "dead_letter";

export type AuthorizationSource = "explicit_add_intent";

export type MediaKind = "photo" | "audio";

export type BackupKind = "postgres" | "media";

export type RetentionClass = "daily" | "monthly";

// ---------------------------------------------------------------------------
// NUTRIENTS
// ---------------------------------------------------------------------------
// Missing values are NULL and are never converted to zero for consensus.

export const NUTRIENT_FIELDS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
] as const;

export type NutrientField = (typeof NUTRIENT_FIELDS)[number];

export type Nutrients = Record<NutrientField, number | null>;

export function emptyNutrients(): Nutrients {
    return {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        sugar_g: null,
        alcohol_g: null,
    };
}

// ---------------------------------------------------------------------------
// COMMANDS
// ---------------------------------------------------------------------------

export interface MealEventItemInput {
    ordinal: number;
    raw_item_text: string;
    normalized_name?: string | null;
    quantity?: number | null;
    portion_value?: number | null;
    portion_unit?: string | null;
    notes?: string | null;
}

export interface MealEventInputEvidence {
    source_kind: InputSourceKind;
    content: string;
    metadata?: Record<string, unknown>;
}

export interface MealEventMediaInput {
    kind: MediaKind;
    storage_key: string;
    mime_type: string;
    byte_size: number;
    sha256: string;
    duration_ms?: number | null;
    width?: number | null;
    height?: number | null;
    metadata?: Record<string, unknown>;
}

export interface ProviderResultInput {
    provider: NutritionProvider;
    status: ProviderResultStatus;
    request_fingerprint: string;
    algorithm_version: string;
    source_id?: string | null;
    ordinal?: number | null;
    nutrients?: Partial<Nutrients>;
    error_code?: string | null;
    error_message?: string | null;
    raw_payload?: Record<string, unknown>;
    /** Complete caller-supplied provenance; persisted without normalization. */
    provenance?: Record<string, unknown>;
    basis?: "per_item" | "per_meal" | "per_100g" | "serving" | null;
    units?: "g_and_kcal" | null;
}

export interface CreateMealEventCommand {
    user_id: string;
    idempotency_key: string;
    reported_at: Date | string;
    consumed_at?: Date | string;
    meal_type?: MealType | null;
    external_write_authorized?: boolean;
    items: MealEventItemInput[];
    inputs: MealEventInputEvidence[];
    media: MealEventMediaInput[];
    provider_results: ProviderResultInput[];
    parser_policy_version: string;
    created_by: string;
    enforce_media_identity?: boolean;
}

export interface CorrectMealEventCommand {
    event_id: string;
    user_id: string;
    correction_idempotency_key: string;
    correction_reason?: string | null;
    items: MealEventItemInput[];
    inputs: MealEventInputEvidence[];
    media: MealEventMediaInput[];
    provider_results: ProviderResultInput[];
    raw_text_snapshot?: string | null;
    consumed_at?: Date | string | null;
    meal_type?: MealType | null;
    parser_policy_version: string;
    created_by: string;
}

// ---------------------------------------------------------------------------
// VALIDATION HELPERS
// ---------------------------------------------------------------------------

// `consumed_at` defaults to the same instant as `reported_at`; both are stored
// explicitly — user-supplied timestamps are never silently defaulted.
export function resolveConsumedAt(
    reportedAt: Date | string,
    consumedAt: Date | string | null | undefined,
): Date {
    const reported =
        reportedAt instanceof Date ? reportedAt : new Date(reportedAt);
    if (Number.isNaN(reported.getTime())) {
        throw new Error(`invalid reported_at: ${String(reportedAt)}`);
    }
    if (consumedAt === undefined || consumedAt === null) return reported;
    const consumed =
        consumedAt instanceof Date ? consumedAt : new Date(consumedAt);
    if (Number.isNaN(consumed.getTime())) {
        throw new Error(`invalid consumed_at: ${String(consumedAt)}`);
    }
    return consumed;
}

// Returns a new array ordered by documented precedence (text first). Inputs
// are never filtered out — lower-precedence evidence is retained.
export function sortInputsByPrecedence(
    inputs: MealEventInputEvidence[],
): MealEventInputEvidence[] {
    return [...inputs].sort(
        (a, b) =>
            INPUT_PRECEDENCE[a.source_kind] - INPUT_PRECEDENCE[b.source_kind],
    );
}

function validateCreateMealEventCommandUnsafe(
    command: CreateMealEventCommand,
): string[] {
    const errors: string[] = [];
    const items = safeArraySnapshot(command.items);
    const inputs = safeArraySnapshot(command.inputs);
    const media = safeArraySnapshot(command.media);
    if (!items) errors.push("items must be an array");
    if (!inputs) errors.push("inputs must be an array");
    if (!media) errors.push("media must be an array");
    const safeItems = (items ?? []) as MealEventItemInput[];
    const safeMedia = (media ?? []) as MealEventMediaInput[];
    if (safeItems.length === 0 && items) errors.push("items must not be empty");
    const ordinals = new Set<number>();
    for (const item of safeItems) {
        if (!Number.isInteger(item.ordinal) || item.ordinal < 0) {
            errors.push("item ordinals must be non-negative integers");
            break;
        }
        ordinals.add(item.ordinal);
    }
    if (ordinals.size !== safeItems.length) {
        errors.push("item ordinals must be unique");
    }
    for (const item of safeItems) {
        if (item.raw_item_text.trim() === "") {
            errors.push("item raw_item_text must not be empty");
            break;
        }
    }
    for (const media of safeMedia) {
        if (!Number.isFinite(media.byte_size) || media.byte_size < 0) {
            errors.push("media byte_size must be a non-negative number");
            break;
        }
    }
    return errors;
}

export function validateCreateMealEventCommand(
    command: CreateMealEventCommand,
): string[] {
    try {
        return validateCreateMealEventCommandUnsafe(command);
    } catch {
        return ["command must be a readable object"];
    }
}

function safeArraySnapshot(value: unknown): unknown[] | null {
    try {
        if (!Array.isArray(value)) return null;
        const array = value as unknown[];
        array.length;
        array.map;
        array.some;
        array.every;
        array[0];
        return Array.from(array);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// FINGERPRINTS
// ---------------------------------------------------------------------------
// Fingerprints are deterministic content hashes. A correction fingerprint is
// always distinct from the initial create fingerprint because it binds the
// event id and correction idempotency key into the hash.

function sha256Hex(parts: (string | number | null | undefined)[]): string {
    return new Bun.CryptoHasher("sha256")
        .update(parts.map((p) => p ?? "").join("\u0000"))
        .digest("hex");
}

export { sha256Hex };

export function deriveCreateFingerprint(
    command: CreateMealEventCommand,
): string {
    return `create:${sha256Hex([
        command.user_id,
        command.idempotency_key,
        String(command.reported_at),
        ...command.items.map((i) => `${i.ordinal}:${i.raw_item_text}`),
    ])}`;
}

export function deriveCorrectionFingerprint(args: {
    event_id: string;
    correction_idempotency_key: string;
    command: CorrectMealEventCommand;
}): string {
    return `correction:${sha256Hex([
        args.event_id,
        args.correction_idempotency_key,
        ...args.command.items.map((i) => `${i.ordinal}:${i.raw_item_text}`),
    ])}`;
}

// A reuse identity binds the caller's reuse idempotency key to the exact
// source event/version and the new occurrence timestamps. Replaying the same
// key with the same identity converges on the original reused event; the same
// key with any differing source, version, or timestamp is a stable conflict,
// never a silent second reuse.
export interface ReuseIdempotencyIdentity {
    user_id: string;
    reuse_idempotency_key: string;
    source_event_id: string;
    source_version: number;
    reported_at: Date | string;
    consumed_at: Date | string;
}

export function deriveReuseIdempotencyFingerprint(
    identity: ReuseIdempotencyIdentity,
): string {
    return `reuse:${sha256Hex([
        identity.user_id,
        identity.reuse_idempotency_key,
        identity.source_event_id,
        identity.source_version,
        String(identity.reported_at),
        String(identity.consumed_at),
    ])}`;
}

// ---------------------------------------------------------------------------
// SYNC JOURNAL STATE MACHINE
// ---------------------------------------------------------------------------
// pending → in_flight → succeeded | failed; failed → in_flight (retry) or
// dead_letter (gave up). pending can never claim success; terminal states
// (succeeded, dead_letter) are final. in_flight never implies success.

const JOURNAL_TRANSITIONS: Record<
    SyncJournalState,
    readonly SyncJournalState[]
> = {
    pending: ["in_flight"],
    in_flight: ["succeeded", "failed"],
    failed: ["in_flight", "dead_letter"],
    succeeded: [],
    dead_letter: [],
};

export function canTransitionJournalState(
    from: SyncJournalState,
    to: SyncJournalState,
): boolean {
    return JOURNAL_TRANSITIONS[from].includes(to);
}

export function assertJournalTransition(
    from: SyncJournalState,
    to: SyncJournalState,
): void {
    if (!canTransitionJournalState(from, to)) {
        throw new Error(`illegal sync journal transition: ${from} -> ${to}`);
    }
}
