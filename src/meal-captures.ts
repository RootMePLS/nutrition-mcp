import { withTransaction } from "./db.js";
import { createMealEvent, type CreateMealEventResult } from "./meal-events.js";
import {
    generateCaptureStorageKey,
    mediaSha256Hex,
    type MediaStore,
} from "./media-store.js";
import {
    validateCaptureMedia,
    validateCaptureMessage,
    validatePreparedDraft,
    type CaptureMediaInput,
    type CaptureMessageInput,
    type CaptureResult,
    type CaptureState,
    type ClarificationAnswer,
    type ConfirmCaptureCommand,
    type PreparedMealDraft,
    type StartCaptureCommand,
} from "./meal-capture-types.js";
import type { Pool, PoolClient } from "pg";

export class MealCaptureValidationError extends Error {
    constructor(public readonly issues: string[]) {
        super(`invalid meal capture: ${issues.join("; ")}`);
    }
}
export function isExplicitConfirmation(value: string): boolean {
    return ["добавь", "add", "confirm"].includes(value.trim().toLowerCase());
}
function notFound(): never {
    throw new MealCaptureValidationError(["capture not found"]);
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
        if (inserted.rows.length)
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
            event_id: row.event_id ?? undefined,
            version: row.event_version ?? undefined,
            deduplicated: true,
        };
    });
}

export interface MealCaptureRead extends CaptureResult {
    user_id: string;
    conversation_key: string;
    expires_at: string | null;
    prepared_draft: PreparedMealDraft | null;
    messages: Record<string, unknown>[];
    answers: Record<string, unknown>[];
    media: Record<string, unknown>[];
}
export async function getMealCapture(
    pool: Pool,
    captureId: string,
    userId: string,
): Promise<MealCaptureRead | null> {
    const { rows } = await pool.query(
        `SELECT * FROM meal_captures WHERE id=$1 AND user_id=$2`,
        [captureId, userId],
    );
    if (!rows.length) return null;
    const row = rows[0]!;
    const [messages, answers, media] = await Promise.all([
        pool.query(
            `SELECT * FROM meal_capture_messages WHERE capture_id=$1 ORDER BY received_at,id`,
            [captureId],
        ),
        pool.query(
            `SELECT * FROM meal_capture_answers WHERE capture_id=$1 ORDER BY created_at,id`,
            [captureId],
        ),
        pool.query(
            `SELECT * FROM meal_capture_media WHERE capture_id=$1 ORDER BY created_at,id`,
            [captureId],
        ),
    ]);
    return {
        capture_id: row.id,
        user_id: row.user_id,
        conversation_key: row.conversation_key,
        state: row.state,
        expires_at: row.expires_at?.toISOString?.() ?? row.expires_at ?? null,
        prepared_draft: row.prepared_draft,
        event_id: row.event_id ?? undefined,
        version: row.event_version ?? undefined,
        messages: messages.rows,
        answers: answers.rows,
        media: media.rows,
    } as MealCaptureRead;
}

async function transitionCapture(
    pool: Pool,
    id: string,
    userId: string,
    target: "cancelled" | "expired",
): Promise<CaptureResult> {
    return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT id,state,event_id,event_version,expires_at FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [id, userId],
        );
        if (!rows.length) return notFound();
        const row = rows[0]!;
        if (row.state === target)
            return { capture_id: row.id, state: target, deduplicated: true };
        if (row.state !== "receiving" && row.state !== "ready_to_confirm")
            throw new MealCaptureValidationError([
                `capture cannot transition from state ${row.state}`,
            ]);
        if (
            target === "expired" &&
            (!row.expires_at || new Date(row.expires_at).getTime() > Date.now())
        )
            throw new MealCaptureValidationError(["capture has not expired"]);
        await client.query(
            `UPDATE meal_captures SET state=$2,updated_at=now() WHERE id=$1`,
            [id, target],
        );
        return { capture_id: id, state: target };
    });
}
export const cancelMealCapture = (pool: Pool, id: string, userId: string) =>
    transitionCapture(pool, id, userId, "cancelled");
export const expireMealCapture = (pool: Pool, id: string, userId: string) =>
    transitionCapture(pool, id, userId, "expired");

export async function appendCaptureMessage(
    pool: Pool,
    captureId: string,
    userId: string,
    message: CaptureMessageInput,
): Promise<void> {
    const errors = validateCaptureMessage(message);
    if (errors.length) throw new MealCaptureValidationError(errors);
    await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT state FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [captureId, userId],
        );
        if (!rows.length) return notFound();
        if (!["receiving", "ready_to_confirm"].includes(rows[0]!.state))
            throw new MealCaptureValidationError([
                "capture is no longer editable",
            ]);
        await client.query(
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
    });
}
export async function saveCaptureAnswer(
    pool: Pool,
    captureId: string,
    userId: string,
    answer: ClarificationAnswer,
): Promise<void> {
    if (!answer.question.trim() || !answer.answer.trim())
        throw new MealCaptureValidationError([
            "question and answer are required",
        ]);
    await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT state FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [captureId, userId],
        );
        if (!rows.length) return notFound();
        if (!["receiving", "ready_to_confirm"].includes(rows[0]!.state))
            throw new MealCaptureValidationError([
                "capture is no longer editable",
            ]);
        await client.query(
            `INSERT INTO meal_capture_answers (capture_id,question,answer,message_id,metadata) VALUES ($1,$2,$3,$4,$5)`,
            [
                captureId,
                answer.question,
                answer.answer,
                answer.message_id ?? null,
                JSON.stringify(answer.metadata ?? {}),
            ],
        );
    });
}
// ---------------------------------------------------------------------------
// Public capture-media byte path (S5). Bytes arrive base64-encoded, are
// decoded and verified here (size cap, MIME allow-list, server-side SHA-256),
// staged through the capture-scoped MediaStore, and only then recorded in the
// database. The caller NEVER controls storage_key.
//
// Durability contract (S5 F1 remediation):
// - Capture ownership/state and any existing (capture_id, sha256) identity are
//   established under a per-capture SELECT ... FOR UPDATE transaction BEFORE
//   any filesystem write; rejected requests never touch disk.
// - The lock is held across the local filesystem write, so concurrent attaches
//   of the same capture serialize and later attempts observe the committed row.
// - Cleanup ownership is tracked explicitly: only a file THIS invocation
//   created for a NEW, still-uncommitted row may be deleted on rollback.
//   Ownership is NEVER inferred from the content-addressed storage_key, which
//   can pre-exist and be referenced by committed meal_capture_media or
//   meal_event_media rows.
// - Existing-row retries own nothing for cleanup: they verify the referenced
//   file and, only if it went missing or corrupt, safely heal it with the
//   identical content-addressed bytes (healing can only restore, never
//   destroy).
// ---------------------------------------------------------------------------

export const CAPTURE_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

export const CAPTURE_MEDIA_MIME_ALLOW_LIST: Readonly<
    Record<"photo" | "audio", ReadonlySet<string>>
> = {
    photo: new Set(["image/jpeg", "image/png", "image/webp"]),
    audio: new Set(["audio/ogg", "audio/mpeg", "audio/mp4"]),
};

const STRICT_BASE64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface AttachCaptureMediaInput {
    kind: "photo" | "audio";
    mime_type: string;
    bytes_base64: string;
    sha256?: string;
    duration_ms?: number | null;
    width?: number | null;
    height?: number | null;
    metadata?: Record<string, unknown>;
}

export interface AttachCaptureMediaResult {
    capture_id: string;
    media_id: string;
    kind: "photo" | "audio";
    storage_key: string;
    mime_type: string;
    byte_size: number;
    sha256: string;
    duration_ms: number | null;
    width: number | null;
    height: number | null;
    metadata: Record<string, unknown>;
    capture_state: CaptureState;
    deduplicated: boolean;
}

export async function attachCaptureMediaBytes(
    pool: Pool,
    mediaStore: MediaStore,
    captureId: string,
    userId: string,
    input: AttachCaptureMediaInput,
): Promise<AttachCaptureMediaResult> {
    const errors: string[] = [];
    const kind = input?.kind;
    if (kind !== "photo" && kind !== "audio") {
        errors.push("media kind is unsupported");
    } else if (!CAPTURE_MEDIA_MIME_ALLOW_LIST[kind].has(input.mime_type)) {
        errors.push(
            `media mime_type is not in the capture allow-list for ${kind}`,
        );
    }
    let bytes: Uint8Array | null = null;
    if (
        typeof input.bytes_base64 !== "string" ||
        !STRICT_BASE64.test(input.bytes_base64)
    ) {
        errors.push("media bytes_base64 must be canonical base64");
    } else {
        const decoded = Buffer.from(input.bytes_base64, "base64");
        if (decoded.toString("base64") !== input.bytes_base64) {
            errors.push("media bytes_base64 must be canonical base64");
        } else if (decoded.byteLength > CAPTURE_MEDIA_MAX_BYTES) {
            errors.push("media bytes exceed the 8 MiB decoded capture limit");
        } else {
            bytes = new Uint8Array(decoded);
        }
    }
    for (const [field, value] of [
        ["duration_ms", input.duration_ms],
        ["width", input.width],
        ["height", input.height],
    ] as const) {
        if (
            value !== undefined &&
            value !== null &&
            (!Number.isInteger(value) || value < 0)
        )
            errors.push(`media ${field} must be a non-negative integer`);
    }
    if (errors.length) throw new MealCaptureValidationError(errors);

    // The server is the sole authority on identity: hash the decoded bytes,
    // never trust a caller-supplied digest.
    const sha256 = mediaSha256Hex(bytes!);
    if (input.sha256 !== undefined && input.sha256 !== sha256)
        throw new MealCaptureValidationError([
            "caller sha256 does not match the server-computed sha256 of the decoded bytes",
        ]);

    // Record-level validation (metadata JSON shape, hash format, …) reuses
    // the same validator as the internal saveCaptureMedia seam; the storage
    // key here is backend-generated, not caller input.
    const candidate: CaptureMediaInput = {
        kind: kind as "photo" | "audio",
        storage_key: generateCaptureStorageKey({
            capture_id: captureId,
            kind: kind as "photo" | "audio",
            sha256,
        }),
        mime_type: input.mime_type,
        byte_size: bytes!.byteLength,
        sha256,
        duration_ms: input.duration_ms ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        metadata: input.metadata ?? {},
    };
    const recordErrors = validateCaptureMedia(candidate);
    if (recordErrors.length) throw new MealCaptureValidationError(recordErrors);

    // Cleanup ownership for THIS invocation only: set solely when a file is
    // staged for a NEW, still-uncommitted row; cleared on commit or whenever
    // the file is (or becomes) referenced by a committed row. Never derived
    // from the deterministic storage_key.
    let stagedByThisInvocation: string | null = null;
    try {
        const identity = await withTransaction(pool, async (client) => {
            // Lock the capture row and validate ownership/state FIRST — before
            // any filesystem I/O — so rejected requests never touch disk.
            const { rows } = await client.query(
                `SELECT state FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
                [captureId, userId],
            );
            if (!rows.length) return notFound();
            const state = rows[0]!.state as CaptureState;
            if (!["receiving", "ready_to_confirm"].includes(state))
                throw new MealCaptureValidationError([
                    "capture is no longer editable",
                ]);
            // Establish existing (capture_id, sha256) identity under the same
            // lock, before staging anything. Concurrent same-capture attaches
            // block on the FOR UPDATE above and therefore always observe the
            // committed row here.
            const existing = await client.query(
                `SELECT id, storage_key FROM meal_capture_media WHERE capture_id=$1 AND sha256=$2`,
                [captureId, sha256],
            );
            if (existing.rows.length) {
                const row = existing.rows[0]!;
                // The row is committed and references the file: this
                // invocation owns NOTHING for cleanup. Verify the referenced
                // bytes; heal only when missing or corrupt, rewriting the
                // identical content-addressed bytes (restore, never destroy).
                try {
                    await mediaStore.read(row.storage_key as string, sha256);
                } catch {
                    await mediaStore.restore({
                        storage_key: row.storage_key as string,
                        bytes: bytes!,
                        mime_type: candidate.mime_type,
                    });
                }
                return {
                    media_id: row.id as string,
                    storage_key: row.storage_key as string,
                    capture_state: state,
                    deduplicated: true,
                };
            }
            // Genuinely new content for this capture: stage bytes while
            // holding the capture lock, then insert the row. Only this staged
            // file — created by this invocation for a row that has not
            // committed yet — is eligible for rollback cleanup.
            const staged = await mediaStore.putCapture({
                capture_id: captureId,
                kind: candidate.kind,
                bytes: bytes!,
                mime_type: candidate.mime_type,
            });
            stagedByThisInvocation = staged.storage_key;
            const inserted = await client.query(
                `INSERT INTO meal_capture_media (capture_id,kind,storage_key,mime_type,byte_size,sha256,duration_ms,width,height,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (capture_id,sha256) DO NOTHING RETURNING id`,
                [
                    captureId,
                    candidate.kind,
                    staged.storage_key,
                    staged.mime_type,
                    staged.byte_size,
                    staged.sha256,
                    candidate.duration_ms,
                    candidate.width,
                    candidate.height,
                    JSON.stringify(candidate.metadata),
                ],
            );
            if (inserted.rows.length)
                return {
                    media_id: inserted.rows[0]!.id as string,
                    storage_key: staged.storage_key,
                    capture_state: state,
                    deduplicated: false,
                };
            // Defense-in-depth: unreachable under the capture lock (every
            // writer of this identity holds it), but if a conflicting row ever
            // appears, the staged file coincides with the now-referenced key —
            // release cleanup ownership instead of deleting referenced bytes.
            stagedByThisInvocation = null;
            const raced = await client.query(
                `SELECT id, storage_key FROM meal_capture_media WHERE capture_id=$1 AND sha256=$2`,
                [captureId, sha256],
            );
            const row = raced.rows[0]!;
            return {
                media_id: row.id as string,
                storage_key: row.storage_key as string,
                capture_state: state,
                deduplicated: true,
            };
        });
        // Committed: the file is now referenced by a durable row, so this
        // invocation no longer owns it for cleanup under any outcome.
        stagedByThisInvocation = null;
        return {
            capture_id: captureId,
            kind: candidate.kind,
            mime_type: candidate.mime_type,
            byte_size: bytes!.byteLength,
            sha256,
            duration_ms: candidate.duration_ms ?? null,
            width: candidate.width ?? null,
            height: candidate.height ?? null,
            metadata: candidate.metadata ?? {},
            ...identity,
        };
    } catch (error) {
        // Rollback cleanup is limited to a file proven to have been newly
        // created by THIS invocation and never referenced by a committed row.
        if (stagedByThisInvocation)
            await mediaStore.delete(stagedByThisInvocation);
        throw error;
    }
}

export async function saveCaptureMedia(
    pool: Pool,
    captureId: string,
    userId: string,
    media: CaptureMediaInput,
): Promise<void> {
    const errors = validateCaptureMedia(media);
    if (errors.length) throw new MealCaptureValidationError(errors);
    await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT state FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [captureId, userId],
        );
        if (!rows.length) return notFound();
        if (!["receiving", "ready_to_confirm"].includes(rows[0]!.state))
            throw new MealCaptureValidationError([
                "capture is no longer editable",
            ]);
        await client.query(
            `INSERT INTO meal_capture_media (capture_id,kind,storage_key,mime_type,byte_size,sha256,duration_ms,width,height,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (capture_id,sha256) DO NOTHING`,
            [
                captureId,
                media.kind,
                media.storage_key,
                media.mime_type,
                media.byte_size,
                media.sha256,
                media.duration_ms ?? null,
                media.width ?? null,
                media.height ?? null,
                JSON.stringify(media.metadata ?? {}),
            ],
        );
    });
}
export async function savePreparedDraft(
    pool: Pool,
    captureId: string,
    userId: string,
    draft: PreparedMealDraft,
): Promise<void> {
    const errors = validatePreparedDraft(draft);
    if (errors.length) throw new MealCaptureValidationError(errors);
    await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT state FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [captureId, userId],
        );
        if (!rows.length) return notFound();
        if (!["receiving", "ready_to_confirm"].includes(rows[0]!.state))
            throw new MealCaptureValidationError([
                "capture is no longer editable",
            ]);
        await client.query(
            `UPDATE meal_captures SET prepared_draft=$2,state='ready_to_confirm',updated_at=now() WHERE id=$1`,
            [captureId, JSON.stringify(draft)],
        );
    });
}

export interface MealCaptureConfirmationDependencies {
    afterEventPersist?: (event: CreateMealEventResult) => void | Promise<void>;
}

export async function confirmMealCapture(
    pool: Pool,
    command: ConfirmCaptureCommand,
    userId: string,
    dependencies: MealCaptureConfirmationDependencies = {},
): Promise<CaptureResult> {
    if (!isExplicitConfirmation(command.confirmation))
        throw new MealCaptureValidationError([
            "explicit confirmation 'добавь' is required",
        ]);
    return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
            `SELECT * FROM meal_captures WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [command.capture_id, userId],
        );
        if (!rows.length) return notFound();
        const row = rows[0]!;
        if (row.state === "confirmed")
            return {
                capture_id: row.id,
                state: "confirmed",
                event_id: row.event_id,
                version: row.event_version,
                deduplicated: true,
            };
        if (row.state !== "ready_to_confirm")
            throw new MealCaptureValidationError([
                `capture cannot be confirmed from state ${row.state}`,
            ]);
        if (!row.prepared_draft)
            throw new MealCaptureValidationError([
                "prepared draft is required",
            ]);
        const draft = row.prepared_draft as PreparedMealDraft;
        const staged = await client.query(
            `SELECT kind,storage_key,mime_type,byte_size,sha256,duration_ms,width,height,metadata
             FROM meal_capture_media WHERE capture_id=$1 ORDER BY created_at,id`,
            [command.capture_id],
        );
        const draftMedia = draft.media ?? [];
        if (
            staged.rows.length !== draftMedia.length ||
            staged.rows.some((m, i) => {
                const d = draftMedia[i];
                return (
                    !d ||
                    m.kind !== d.kind ||
                    m.storage_key !== d.storage_key ||
                    m.mime_type !== d.mime_type ||
                    Number(m.byte_size) !== d.byte_size ||
                    m.sha256 !== d.sha256 ||
                    Number(m.duration_ms ?? 0) !== Number(d.duration_ms ?? 0) ||
                    Number(m.width ?? 0) !== Number(d.width ?? 0) ||
                    Number(m.height ?? 0) !== Number(d.height ?? 0) ||
                    JSON.stringify(m.metadata ?? {}) !==
                        JSON.stringify(d.metadata ?? {})
                );
            })
        ) {
            throw new MealCaptureValidationError([
                "media provenance does not match staged capture media",
            ]);
        }
        const event = await createMealEvent(
            pool,
            {
                user_id: userId,
                idempotency_key: `capture:${command.capture_id}`,
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
            },
            client,
        );
        await dependencies.afterEventPersist?.(event);
        await client.query(
            `UPDATE meal_captures SET state='confirmed',confirmed_at=now(),event_id=$2,event_version=$3,updated_at=now() WHERE id=$1`,
            [command.capture_id, event.event_id, event.version],
        );
        return {
            capture_id: command.capture_id,
            state: "confirmed",
            event_id: event.event_id,
            version: event.version,
            deduplicated: event.deduplicated,
        };
    });
}
