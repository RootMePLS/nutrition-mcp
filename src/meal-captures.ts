import { withTransaction } from "./db.js";
import { createMealEvent } from "./meal-events.js";
import {
    validatePreparedDraft,
    type CaptureMessageInput,
    type CaptureResult,
    type ClarificationAnswer,
    type ConfirmCaptureCommand,
    type PreparedMealDraft,
    type StartCaptureCommand,
} from "./meal-capture-types.js";
import type { Pool } from "pg";

export class MealCaptureValidationError extends Error {
    constructor(public readonly issues: string[]) {
        super(`invalid meal capture: ${issues.join("; ")}`);
    }
}

export function isExplicitConfirmation(value: string): boolean {
    return ["добавь", "add", "confirm"].includes(value.trim().toLowerCase());
}

export async function startMealCapture(
    pool: Pool,
    command: StartCaptureCommand,
): Promise<CaptureResult> {
    if (
        !command.user_id ||
        !command.conversation_key ||
        !command.idempotency_key
    )
        throw new MealCaptureValidationError([
            "capture identifiers are required",
        ]);
    return withTransaction(pool, async (client) => {
        const inserted = await client.query(
            `INSERT INTO meal_captures (user_id, conversation_key, idempotency_key, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING id,state`,
            [
                command.user_id,
                command.conversation_key,
                command.idempotency_key,
                command.expires_at ?? null,
            ],
        );
        if (inserted.rows.length > 0)
            return {
                capture_id: inserted.rows[0]!.id as string,
                state: inserted.rows[0]!.state as CaptureResult["state"],
            };
        const existing = await client.query(
            `SELECT id,state,event_id,event_version FROM meal_captures WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
            [command.user_id, command.idempotency_key],
        );
        const row = existing.rows[0]!;
        return {
            capture_id: row.id as string,
            state: row.state as CaptureResult["state"],
            event_id: (row.event_id as string | null) ?? undefined,
            version: (row.event_version as number | null) ?? undefined,
            deduplicated: true,
        };
    });
}

export async function appendCaptureMessage(
    pool: Pool,
    captureId: string,
    message: CaptureMessageInput,
): Promise<void> {
    if (!message.external_message_id || !message.kind)
        throw new MealCaptureValidationError([
            "message id and kind are required",
        ]);
    await pool.query(
        `INSERT INTO meal_capture_messages (capture_id,external_message_id,kind,text,raw_metadata,received_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (capture_id,external_message_id) DO NOTHING`,
        [
            captureId,
            message.external_message_id,
            message.kind,
            message.text ?? null,
            JSON.stringify(message.raw_metadata ?? {}),
            message.received_at ?? new Date().toISOString(),
        ],
    );
}

export async function saveCaptureAnswer(
    pool: Pool,
    captureId: string,
    answer: ClarificationAnswer,
): Promise<void> {
    if (!answer.question.trim() || !answer.answer.trim())
        throw new MealCaptureValidationError([
            "question and answer are required",
        ]);
    await pool.query(
        `INSERT INTO meal_capture_answers (capture_id,question,answer,message_id,metadata) VALUES ($1,$2,$3,$4,$5)`,
        [
            captureId,
            answer.question,
            answer.answer,
            answer.message_id ?? null,
            JSON.stringify(answer.metadata ?? {}),
        ],
    );
}

export async function savePreparedDraft(
    pool: Pool,
    captureId: string,
    draft: PreparedMealDraft,
): Promise<void> {
    const errors = validatePreparedDraft(draft);
    if (errors.length > 0) throw new MealCaptureValidationError(errors);
    await withTransaction(pool, async (client) => {
        const locked = await client.query(
            `SELECT state FROM meal_captures WHERE id=$1 FOR UPDATE`,
            [captureId],
        );
        if (locked.rows.length === 0)
            throw new MealCaptureValidationError([
                `capture not found: ${captureId}`,
            ]);
        if (
            !["receiving", "ready_to_confirm"].includes(
                locked.rows[0]!.state as string,
            )
        )
            throw new MealCaptureValidationError([
                "capture is no longer editable",
            ]);
        await client.query(
            `UPDATE meal_captures SET prepared_draft=$2,state='ready_to_confirm',updated_at=now() WHERE id=$1`,
            [captureId, JSON.stringify(draft)],
        );
    });
}

export async function confirmMealCapture(
    pool: Pool,
    command: ConfirmCaptureCommand,
    userId: string,
): Promise<CaptureResult> {
    if (!isExplicitConfirmation(command.confirmation))
        throw new MealCaptureValidationError([
            "explicit confirmation 'добавь' is required",
        ]);
    const { rows } = await pool.query(
        `SELECT * FROM meal_captures WHERE id=$1 AND user_id=$2`,
        [command.capture_id, userId],
    );
    if (rows.length === 0)
        throw new MealCaptureValidationError(["capture not found"]);
    const row = rows[0]!;
    if (row.state === "confirmed")
        return {
            capture_id: row.id as string,
            state: "confirmed",
            event_id: row.event_id as string,
            version: row.event_version as number,
            deduplicated: true,
        };
    if (row.state !== "ready_to_confirm")
        throw new MealCaptureValidationError([
            `capture cannot be confirmed from state ${row.state}`,
        ]);
    if (!row.prepared_draft)
        throw new MealCaptureValidationError(["prepared draft is required"]);
    const draft = row.prepared_draft as PreparedMealDraft;
    const event = await createMealEvent(pool, {
        user_id: userId,
        idempotency_key:
            command.event_idempotency_key ?? `capture:${command.capture_id}`,
        reported_at: draft.reported_at,
        consumed_at: draft.consumed_at ?? undefined,
        meal_type: draft.meal_type ?? null,
        items: draft.items,
        inputs: draft.inputs,
        media: draft.media,
        provider_results: draft.provider_results ?? [],
        parser_policy_version: draft.parser_policy_version,
        created_by: draft.created_by,
        external_write_authorized: true,
        enforce_media_identity: false,
    });
    await withTransaction(pool, async (client) => {
        const locked = await client.query(
            `SELECT state FROM meal_captures WHERE id=$1 FOR UPDATE`,
            [command.capture_id],
        );
        if (locked.rows[0]?.state === "confirmed") return;
        await client.query(
            `UPDATE meal_captures SET state='confirmed',confirmed_at=now(),event_id=$2,event_version=$3,updated_at=now() WHERE id=$1`,
            [command.capture_id, event.event_id, event.version],
        );
    });
    return {
        capture_id: command.capture_id,
        state: "confirmed",
        event_id: event.event_id,
        version: event.version,
        deduplicated: event.deduplicated,
    };
}
