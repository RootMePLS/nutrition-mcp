import {
    UnknownCommitOutcomeError,
    withTransaction,
    withTransactionCommitPhases,
} from "./db.js";
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
// - COMMIT-outcome phase awareness (S5 second remediation): a failure AFTER
//   COMMIT was sent is an UNKNOWN outcome, not proof of rollback. No
//   immediate deletion happens; the uncertain client is discarded and the
//   outcome is reconciled on a fresh connection under a fresh capture-row
//   lock. The staged file is deleted only when the locked reconciliation
//   DEFINITIVELY proves no committed row references it; if the row exists or
//   reconciliation is unavailable/ambiguous, the file is retained (a bounded,
//   deterministic-key possible orphan is always preferred over deleting
//   potentially referenced bytes).
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
    bytes_base64?: string;
    file_path?: string;
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

// Reconcile an invocation-owned staged file after an UNKNOWN commit outcome.
// Runs on a FRESH connection (the uncertain one was discarded by
// withTransactionCommitPhases) under a FRESH capture-row lock, which
// serializes against every cooperating attach/confirm of this capture.
//
// Deletion rule — delete the staged key ONLY when this locked snapshot
// definitively proves no committed row references it:
// - (capture_id, sha256) row exists and references exactly this key
//   -> commit landed; RETAIN the referenced bytes.
// - Row exists with a different storage_key, or no row exists -> delete the
//   staged key only if NEITHER meal_capture_media NOR meal_event_media
//   references that exact key anywhere.
// - Anything unavailable or ambiguous (connection failure, query failure,
//   missing capture row, commit failure of the reconciliation transaction
//   BEFORE the delete decision) -> RETAIN the possible orphan. This function
//   never throws: retention is always the safe failure mode.
//
// Deleting happens while the capture lock is still held (before COMMIT), so
// no racing cooperating attach can interleave a new reference between the
// absence proof and the delete.
async function reconcileStagedKeyAfterUnknownCommit(args: {
    pool: Pool;
    mediaStore: MediaStore;
    captureId: string;
    sha256: string;
    stagedKey: string;
}): Promise<void> {
    const { pool, mediaStore, captureId, sha256, stagedKey } = args;
    try {
        const client = await pool.connect();
        let destroyClient = false;
        try {
            await client.query("BEGIN");
            const capture = await client.query(
                `SELECT id FROM meal_captures WHERE id=$1 FOR UPDATE`,
                [captureId],
            );
            if (!capture.rows.length) {
                // The capture row itself is unreadable here — ambiguous.
                // Retain.
                await client.query("ROLLBACK");
                return;
            }
            const media = await client.query(
                `SELECT storage_key FROM meal_capture_media WHERE capture_id=$1 AND sha256=$2`,
                [captureId, sha256],
            );
            const referencedKey = media.rows.length
                ? (media.rows[0]!.storage_key as string)
                : null;
            if (referencedKey === stagedKey) {
                // Commit landed: the durable row references these exact
                // bytes. Retain.
                await client.query("COMMIT");
                return;
            }
            // Row absent or referencing a DIFFERENT key: the staged key is
            // redundant garbage UNLESS some other committed row references
            // it. Prove non-reference under the held capture lock.
            const references = await client.query(
                `SELECT
                    (SELECT count(*) FROM meal_capture_media WHERE storage_key=$1) AS capture_refs,
                    (SELECT count(*) FROM meal_event_media WHERE storage_key=$1) AS event_refs`,
                [stagedKey],
            );
            const refCount =
                Number(references.rows[0]!.capture_refs) +
                Number(references.rows[0]!.event_refs);
            if (refCount === 0) {
                // Definitively unreferenced and invocation-owned: delete
                // while the capture lock is still held.
                await mediaStore.delete(stagedKey);
            }
            await client.query("COMMIT");
        } catch {
            destroyClient = true;
            // Reconciliation itself is unavailable/ambiguous: retain the
            // possible orphan rather than risk referenced data.
            try {
                await client.query("ROLLBACK");
            } catch {
                // Connection is dead; destruction below finishes cleanup.
            }
        } finally {
            client.release(
                destroyClient
                    ? new Error("discarding failed reconciliation client")
                    : undefined,
            );
        }
    } catch {
        // No fresh connection available: retain the possible orphan.
    }
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

    // Validate mutual exclusivity of bytes_base64 and file_path.
    const hasBytes =
        typeof input.bytes_base64 === "string" && input.bytes_base64.length > 0;
    const hasPath =
        typeof input.file_path === "string" && input.file_path.length > 0;
    if (hasBytes && hasPath) {
        errors.push("provide file_path or bytes_base64, not both");
    } else if (!hasBytes && !hasPath) {
        errors.push("file_path or bytes_base64 is required");
    }

    let bytes: Uint8Array | null = null;
    if (hasBytes) {
        // --- bytes_base64 path ---
        if (!STRICT_BASE64.test(input.bytes_base64!)) {
            errors.push("media bytes_base64 must be canonical base64");
        } else {
            const decoded = Buffer.from(input.bytes_base64!, "base64");
            if (decoded.toString("base64") !== input.bytes_base64) {
                errors.push("media bytes_base64 must be canonical base64");
            } else if (decoded.byteLength > CAPTURE_MEDIA_MAX_BYTES) {
                errors.push(
                    "media bytes exceed the 8 MiB decoded capture limit",
                );
            } else {
                bytes = new Uint8Array(decoded);
            }
        }
    } else if (hasPath) {
        // --- file_path validation (shape only; existence checked later) ---
        const fp = input.file_path!;
        if (fp.includes("\u0000")) {
            errors.push("file_path must not contain NUL bytes");
        } else if (fp.includes("\\")) {
            errors.push("file_path must use forward slashes");
        } else if (fp.split("/").includes("..")) {
            errors.push("file_path must not contain '..' segments");
        } else if (!fp.startsWith("/")) {
            errors.push("file_path must be an absolute path");
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

    // --- If file_path, read the file now (schema is clean) ---
    if (hasPath && !hasBytes) {
        const fp = input.file_path!;
        const file = Bun.file(fp);
        if (!(await file.exists())) {
            throw new MealCaptureValidationError([
                `file_path does not exist or is not readable: ${fp}`,
            ]);
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        if (buf.byteLength === 0) {
            throw new MealCaptureValidationError([
                `file_path is an empty file: ${fp}`,
            ]);
        }
        if (buf.byteLength > CAPTURE_MEDIA_MAX_BYTES) {
            throw new MealCaptureValidationError([
                `file at file_path exceeds the 8 MiB capture limit`,
            ]);
        }
        bytes = buf;
    }

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
    // Conflict branch with a DIFFERENT referenced key: the staged file is
    // provably unreferenced (capture lock held) and invocation-owned, so it
    // is redundant — but it is deleted only AFTER a safe, acknowledged commit
    // (or by reconciliation after an unknown outcome).
    let redundantUnreferencedStagedKey: string | null = null;
    try {
        const identity = await withTransactionCommitPhases(
            pool,
            async (client) => {
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
                        await mediaStore.read(
                            row.storage_key as string,
                            sha256,
                        );
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
                // cooperating writer of this identity holds it), but if a
                // conflicting row ever appears (non-cooperating writer), resolve
                // it by EXACT key comparison rather than assuming the staged key
                // is the referenced one.
                const raced = await client.query(
                    `SELECT id, storage_key FROM meal_capture_media WHERE capture_id=$1 AND sha256=$2`,
                    [captureId, sha256],
                );
                const row = raced.rows[0]!;
                if (row.storage_key !== staged.storage_key) {
                    // The conflicting row references a DIFFERENT key. This
                    // invocation's staged file is newly created and provably
                    // unreferenced (the capture lock is held, excluding any
                    // racing cooperating attach): mark it for deletion after
                    // a safe commit / reconciliation instead of retaining an
                    // unbounded orphan.
                    redundantUnreferencedStagedKey = staged.storage_key;
                    stagedByThisInvocation = null;
                }
                // Same key: the staged file coincides with the now-referenced
                // key — ownership transfers to the committed row on commit;
                // it is never deleted on any outcome (the unknown-outcome
                // reconciliation below retains referenced keys).
                return {
                    media_id: row.id as string,
                    storage_key: row.storage_key as string,
                    capture_state: state,
                    deduplicated: true,
                };
            },
        );
        // Committed AND acknowledged: the media row is durable. A redundant
        // different-key staged file stays unreferenced (the unique
        // (capture_id, sha256) row points at the other key and every
        // cooperating retry resolves through that row), so removing it cannot
        // destroy referenced data. Retention on delete failure is bounded
        // (one deterministic key per capture/sha256).
        const redundant = redundantUnreferencedStagedKey;
        stagedByThisInvocation = null;
        redundantUnreferencedStagedKey = null;
        if (redundant) {
            try {
                await mediaStore.delete(redundant);
            } catch {
                // Bounded orphan retained; never fail a committed attach.
            }
        }
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
        const staged = stagedByThisInvocation ?? redundantUnreferencedStagedKey;
        if (staged) {
            if (error instanceof UnknownCommitOutcomeError) {
                // UNKNOWN outcome: the COMMIT may have landed. Never delete
                // immediately — reconcile on a fresh connection under a fresh
                // capture-row lock; delete only on definitive proof of
                // non-reference, otherwise retain the possible orphan.
                await reconcileStagedKeyAfterUnknownCommit({
                    pool,
                    mediaStore,
                    captureId,
                    sha256,
                    stagedKey: staged,
                });
            } else {
                // Definitively pre-COMMIT failure: ordinary rollback cleanup
                // of a file proven newly created by THIS invocation and never
                // referenced by a committed row.
                await mediaStore.delete(staged);
            }
        }
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
