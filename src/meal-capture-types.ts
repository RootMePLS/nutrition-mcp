import type {
    CreateMealEventCommand,
    InputSourceKind,
    MealEventInputEvidence,
    MealEventItemInput,
    MealEventMediaInput,
} from "./meal-types.js";

export type CaptureState =
    "receiving" | "ready_to_confirm" | "confirmed" | "cancelled" | "expired";
export type CaptureMessageKind = "text" | "answer" | "photo" | "audio";

export interface CaptureMessageInput {
    external_message_id: string;
    kind: CaptureMessageKind;
    text?: string | null;
    raw_metadata?: Record<string, unknown>;
    received_at?: Date | string;
}

export interface CaptureMediaInput {
    kind: "photo" | "audio";
    storage_key: string;
    mime_type: string;
    byte_size: number;
    sha256: string;
    duration_ms?: number | null;
    width?: number | null;
    height?: number | null;
    metadata?: Record<string, unknown>;
}

export interface PreparedMealDraft {
    reported_at: Date | string;
    consumed_at?: Date | string | null;
    meal_type?: "breakfast" | "lunch" | "dinner" | "snack" | null;
    items: MealEventItemInput[];
    inputs: MealEventInputEvidence[];
    media: MealEventMediaInput[];
    provider_results?: CreateMealEventCommand["provider_results"];
    parser_policy_version: string;
    created_by: string;
}

export interface ClarificationAnswer {
    question: string;
    answer: string;
    message_id?: string | null;
    metadata?: Record<string, unknown>;
}

export interface StartCaptureCommand {
    user_id: string;
    conversation_key: string;
    idempotency_key: string;
    expires_at?: Date | string | null;
}

export interface ConfirmCaptureCommand {
    capture_id: string;
    confirmation: "добавь" | "add" | "confirm";
    event_idempotency_key?: string;
}

export interface CaptureResult {
    capture_id: string;
    state: CaptureState;
    event_id?: string;
    version?: number;
    deduplicated?: boolean;
}

const EVIDENCE_PRECEDENCE: Record<InputSourceKind, number> = {
    user_text: 10,
    audio_transcript: 20,
    photo_ocr: 30,
    photo_vision: 40,
    model_assumption: 50,
};

const EVIDENCE_KINDS = new Set(Object.keys(EVIDENCE_PRECEDENCE));
const MESSAGE_KINDS = new Set(["text", "answer", "photo", "audio"]);
const MEDIA_KINDS = new Set(["photo", "audio"]);

function isJsonMetadata(value: unknown, seen = new Set<object>()): boolean {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value))
        return value.every((item) => isJsonMetadata(item, seen));
    if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    )
        return false;
    return Object.entries(value as Record<string, unknown>).every(
        ([key, item]) => typeof key === "string" && isJsonMetadata(item, seen),
    );
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value: unknown): boolean {
    if (value == null) return true;
    if (!(typeof value === "string" || value instanceof Date)) return false;
    return !Number.isNaN(
        (value instanceof Date ? value : new Date(value)).getTime(),
    );
}

const MIME_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function isCompatibleMime(value: unknown, kind: unknown): boolean {
    if (typeof value !== "string") return false;
    const [type, subtype, ...rest] = value.split("/");
    if (
        rest.length > 0 ||
        !type ||
        !subtype ||
        !MIME_TOKEN.test(type) ||
        !MIME_TOKEN.test(subtype)
    )
        return false;
    return (
        (kind === "photo" && type.toLowerCase() === "image") ||
        (kind === "audio" && type.toLowerCase() === "audio")
    );
}

function contentSha256(content: string): string {
    return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function validateCaptureMessage(message: CaptureMessageInput): string[] {
    const errors: string[] = [];
    if (!isNonEmptyString(message?.external_message_id))
        errors.push("message external_message_id is required");
    if (!MESSAGE_KINDS.has(message?.kind as string))
        errors.push("message kind is unsupported");
    if (!isValidDate(message?.received_at))
        errors.push("message received_at must be a valid timestamp");
    if (
        message != null &&
        Object.prototype.hasOwnProperty.call(message, "raw_metadata") &&
        !isJsonMetadata(message?.raw_metadata)
    )
        errors.push("message raw_metadata must be JSON metadata");
    return errors;
}

export function validateCaptureMedia(media: CaptureMediaInput): string[] {
    const errors: string[] = [];
    if (!MEDIA_KINDS.has(media?.kind as string))
        errors.push("media kind is unsupported");
    if (!isNonEmptyString(media?.storage_key))
        errors.push("media storage_key is required");
    if (
        !Number.isFinite(media?.byte_size) ||
        !Number.isInteger(media?.byte_size) ||
        media?.byte_size < 0
    )
        errors.push("media byte_size must be a finite non-negative integer");
    if (
        !/^[0-9a-f]{64}$/.test(
            typeof media?.sha256 === "string" ? media.sha256 : "",
        )
    )
        errors.push("media sha256 must be a lowercase hexadecimal SHA-256");
    if (!isCompatibleMime(media?.mime_type, media?.kind))
        errors.push("media mime_type is invalid for media kind");
    if (
        Object.prototype.hasOwnProperty.call(media, "metadata") &&
        !isJsonMetadata(media?.metadata)
    )
        errors.push("media metadata must be JSON metadata");
    return errors;
}

export function normalizePreparedEvidence(
    inputs: MealEventInputEvidence[],
): MealEventInputEvidence[] {
    return inputs
        .map((input, index) => ({ input, index }))
        .sort(
            (a, b) =>
                (EVIDENCE_PRECEDENCE[a.input.source_kind] ?? Infinity) -
                    (EVIDENCE_PRECEDENCE[b.input.source_kind] ?? Infinity) ||
                a.index - b.index,
        )
        .map(({ input }) => input);
}

export function validatePreparedDraft(draft: PreparedMealDraft): string[] {
    const errors: string[] = [];
    if (!Array.isArray(draft?.items))
        errors.push("draft.items must be an array");
    if (!Array.isArray(draft?.inputs))
        errors.push("draft.inputs must be an array");
    if (!Array.isArray(draft?.media))
        errors.push("draft.media must be an array");
    const items = Array.isArray(draft?.items) ? draft.items : [];
    const inputs = Array.isArray(draft?.inputs) ? draft.inputs : [];
    const draftMedia = Array.isArray(draft?.media) ? draft.media : [];
    if (items.length === 0 && Array.isArray(draft?.items))
        errors.push("draft.items must not be empty");
    const ordinals = items.map((item) => item?.ordinal);
    if (new Set(ordinals).size !== ordinals.length)
        errors.push("draft item ordinals must be unique");
    if (
        items.some(
            (item) => !Number.isInteger(item?.ordinal) || item.ordinal < 0,
        )
    )
        errors.push("draft item ordinals must be non-negative integers");
    if (items.some((item) => !isNonEmptyString(item?.raw_item_text)))
        errors.push("draft item text must not be empty");
    if (draft?.reported_at == null || !isValidDate(draft.reported_at))
        errors.push("draft reported_at must be a valid timestamp");
    if (!isValidDate(draft.consumed_at))
        errors.push("draft consumed_at must be a valid timestamp");
    if (!isNonEmptyString(draft?.parser_policy_version))
        errors.push("draft parser_policy_version is required");
    if (!isNonEmptyString(draft?.created_by))
        errors.push("draft created_by is required");

    for (const input of inputs) {
        if (!EVIDENCE_KINDS.has(input?.source_kind))
            errors.push("evidence source_kind is unsupported");
        if (!isNonEmptyString(input?.content))
            errors.push("evidence content is required");
        const withHash = input as MealEventInputEvidence & {
            content_hash?: string;
        };
        if (
            withHash.content_hash !== undefined &&
            (typeof withHash.content_hash !== "string" ||
                !/^[0-9a-f]{64}$/.test(withHash.content_hash) ||
                withHash.content_hash !== contentSha256(input.content ?? ""))
        )
            errors.push(
                typeof withHash.content_hash === "string" &&
                    /^[0-9a-f]{64}$/.test(withHash.content_hash)
                    ? "evidence content_hash does not match content"
                    : "evidence content_hash must be a lowercase hexadecimal SHA-256",
            );
        if (
            Object.prototype.hasOwnProperty.call(input, "metadata") &&
            !isJsonMetadata(input?.metadata)
        )
            errors.push("evidence metadata must be JSON metadata");
    }
    for (const media of draftMedia) {
        errors.push(
            ...validateCaptureMedia(media as CaptureMediaInput).map((error) =>
                error.replace(/^media /, "draft media "),
            ),
        );
    }
    return errors;
}
