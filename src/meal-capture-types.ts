import type {
    CreateMealEventCommand,
    MealEventInputEvidence,
    MealEventItemInput,
    MealEventMediaInput,
} from "./meal-types.js";

export type CaptureState =
    "receiving" | "ready_to_confirm" | "confirmed" | "cancelled" | "expired";
export type CaptureMessageKind =
    "text" | "answer" | "photo" | "audio" | "other";

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
    if (Number.isNaN(new Date(draft.reported_at).getTime()))
        errors.push("draft reported_at must be a valid timestamp");
    if (
        draft.consumed_at != null &&
        Number.isNaN(new Date(draft.consumed_at).getTime())
    )
        errors.push("draft consumed_at must be a valid timestamp");
    return errors;
}
