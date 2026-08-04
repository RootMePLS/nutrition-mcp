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

function isJsonMetadata(value: unknown): boolean {
    try {
        JSON.stringify(value);
        return value !== undefined && !containsUndefined(value);
    } catch {
        return false;
    }
}

function containsUndefined(value: unknown): boolean {
    if (value === undefined) return true;
    if (Array.isArray(value)) return value.some(containsUndefined);
    if (value !== null && typeof value === "object") {
        return Object.values(value as Record<string, unknown>).some(
            containsUndefined,
        );
    }
    return false;
}

function isValidDate(value: Date | string | null | undefined): boolean {
    if (value == null) return true;
    return !Number.isNaN(
        (value instanceof Date ? value : new Date(value)).getTime(),
    );
}

function contentSha256(content: string): string {
    return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function validateCaptureMessage(message: CaptureMessageInput): string[] {
    const errors: string[] = [];
    if (!message.external_message_id?.trim())
        errors.push("message external_message_id is required");
    if (!MESSAGE_KINDS.has(message.kind as string))
        errors.push("message kind is unsupported");
    if (!isValidDate(message.received_at))
        errors.push("message received_at must be a valid timestamp");
    if (
        message.raw_metadata !== undefined &&
        !isJsonMetadata(message.raw_metadata)
    )
        errors.push("message raw_metadata must be JSON metadata");
    return errors;
}

export function validateCaptureMedia(media: CaptureMediaInput): string[] {
    const errors: string[] = [];
    if (!MEDIA_KINDS.has(media.kind as string))
        errors.push("media kind is unsupported");
    if (!media.storage_key?.trim())
        errors.push("media storage_key is required");
    if (
        !Number.isFinite(media.byte_size) ||
        !Number.isInteger(media.byte_size) ||
        media.byte_size < 0
    )
        errors.push("media byte_size must be a finite non-negative integer");
    if (!/^[0-9a-f]{64}$/.test(media.sha256))
        errors.push("media sha256 must be a lowercase hexadecimal SHA-256");
    const mimeValid =
        (media.kind === "photo" && media.mime_type.startsWith("image/")) ||
        (media.kind === "audio" && media.mime_type.startsWith("audio/"));
    if (!mimeValid) errors.push("media mime_type is invalid for media kind");
    if (media.metadata !== undefined && !isJsonMetadata(media.metadata))
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
    if (draft.items.length === 0) errors.push("draft.items must not be empty");
    const ordinals = draft.items.map((item) => item.ordinal);
    if (new Set(ordinals).size !== ordinals.length)
        errors.push("draft item ordinals must be unique");
    if (
        draft.items.some(
            (item) => item.ordinal < 0 || !Number.isInteger(item.ordinal),
        )
    )
        errors.push("draft item ordinals must be non-negative integers");
    if (draft.items.some((item) => item.raw_item_text.trim() === ""))
        errors.push("draft item text must not be empty");
    if (!isValidDate(draft.reported_at))
        errors.push("draft reported_at must be a valid timestamp");
    if (!isValidDate(draft.consumed_at))
        errors.push("draft consumed_at must be a valid timestamp");
    if (!draft.parser_policy_version?.trim())
        errors.push("draft parser_policy_version is required");
    if (!draft.created_by?.trim()) errors.push("draft created_by is required");

    for (const input of draft.inputs) {
        if (!EVIDENCE_KINDS.has(input.source_kind))
            errors.push("evidence source_kind is unsupported");
        if (!input.content?.trim()) errors.push("evidence content is required");
        const withHash = input as MealEventInputEvidence & {
            content_hash?: string;
        };
        if (
            withHash.content_hash !== undefined &&
            withHash.content_hash !== contentSha256(input.content)
        )
            errors.push("evidence content_hash does not match content");
        if (input.metadata !== undefined && !isJsonMetadata(input.metadata))
            errors.push("evidence metadata must be JSON metadata");
    }
    for (const media of draft.media) {
        errors.push(
            ...validateCaptureMedia(media as CaptureMediaInput).map((error) =>
                error.replace(/^media /, "draft media "),
            ),
        );
    }
    return errors;
}
