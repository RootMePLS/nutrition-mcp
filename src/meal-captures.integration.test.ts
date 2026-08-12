import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
    appendCaptureMessage,
    attachCaptureMediaBytes,
    cancelMealCapture,
    confirmMealCapture,
    expireMealCapture,
    getMealCapture,
    saveCaptureAnswer,
    saveCaptureMedia,
    savePreparedDraft,
    startMealCapture,
} from "./meal-captures.js";
import { createMediaStore, type MediaStore } from "./media-store.js";
import type { PreparedMealDraft } from "./meal-capture-types.js";

const url = process.env.DATABASE_URL_TEST;
const describeDb = url ? describe : describe.skip;
const migrations = [
    "db/migrations/001_initial_schema.sql",
    "db/migrations/002_food_tracking.sql",
    "db/migrations/003_meal_captures.sql",
    "db/migrations/004_calculation_bundles.sql",
    "db/migrations/005_calculation_corrections.sql",
    "db/migrations/011_nutrient_expansion.sql",
];

async function migrate(client: PoolClient) {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    for (const path of migrations)
        await client.query(await Bun.file(path).text());
}

const draft: PreparedMealDraft = {
    reported_at: "2026-08-05T12:00:00Z",
    items: [
        { ordinal: 0, raw_item_text: "oatmeal" },
        { ordinal: 1, raw_item_text: "berries" },
    ],
    inputs: [{ source_kind: "user_text", content: "oatmeal and berries" }],
    media: [],
    parser_policy_version: "hermes.v1",
    created_by: "hermes",
};

describeDb("durable meal capture lifecycle", () => {
    let pool: Pool;
    beforeAll(async () => {
        pool = new Pool({ connectionString: url, max: 8 });
        const client = await pool.connect();
        try {
            await migrate(client);
        } finally {
            client.release();
        }
    });
    afterAll(async () => {
        await pool.end();
    });

    test("persists across reads, idempotent messages/answers, and valid cancel/expire transitions", async () => {
        const started = await startMealCapture(pool, {
            user_id: "a2-user",
            conversation_key: "c1",
            idempotency_key: "capture-1",
        });
        const replay = await startMealCapture(pool, {
            user_id: "a2-user",
            conversation_key: "different",
            idempotency_key: "capture-1",
        });
        expect(replay).toMatchObject({
            capture_id: started.capture_id,
            deduplicated: true,
        });
        await appendCaptureMessage(pool, started.capture_id, "a2-user", {
            external_message_id: "m1",
            kind: "text",
            text: "hi",
        });
        await appendCaptureMessage(pool, started.capture_id, "a2-user", {
            external_message_id: "m1",
            kind: "text",
            text: "changed",
        });
        await saveCaptureAnswer(pool, started.capture_id, "a2-user", {
            question: "how much?",
            answer: "one bowl",
        });
        await saveCaptureAnswer(pool, started.capture_id, "a2-user", {
            question: "how much?",
            answer: "one bowl",
        });
        const read = await getMealCapture(pool, started.capture_id, "a2-user");
        expect(read?.messages).toHaveLength(1);
        expect(read?.answers).toHaveLength(2);
        await cancelMealCapture(pool, started.capture_id, "a2-user");
        await cancelMealCapture(pool, started.capture_id, "a2-user");
        expect(
            (await getMealCapture(pool, started.capture_id, "a2-user"))?.state,
        ).toBe("cancelled");

        const expiring = await startMealCapture(pool, {
            user_id: "a2-user",
            conversation_key: "c2",
            idempotency_key: "capture-2",
            expires_at: new Date(Date.now() - 1000),
        });
        await expireMealCapture(pool, expiring.capture_id, "a2-user");
        await expireMealCapture(pool, expiring.capture_id, "a2-user");
        expect(
            (await getMealCapture(pool, expiring.capture_id, "a2-user"))?.state,
        ).toBe("expired");
    });

    test("saves media provenance and confirms exactly once under concurrency", async () => {
        const capture = await startMealCapture(pool, {
            user_id: "a2-user",
            conversation_key: "c3",
            idempotency_key: "capture-3",
        });
        const stagedMedia = {
            kind: "photo",
            storage_key: "staged/photo.jpg",
            mime_type: "image/jpeg",
            byte_size: 12,
            sha256: "b".repeat(64),
            metadata: { width: 10 },
        } as const;
        await saveCaptureMedia(
            pool,
            capture.capture_id,
            "a2-user",
            stagedMedia,
        );
        await savePreparedDraft(pool, capture.capture_id, "a2-user", {
            ...draft,
            media: [stagedMedia],
        });
        const results = await Promise.all([
            confirmMealCapture(
                pool,
                {
                    capture_id: capture.capture_id,
                    confirmation: "add",
                    event_idempotency_key: "evil-1",
                },
                "a2-user",
            ),
            confirmMealCapture(
                pool,
                {
                    capture_id: capture.capture_id,
                    confirmation: "add",
                    event_idempotency_key: "evil-2",
                },
                "a2-user",
            ),
        ]);
        expect(results[0]?.event_id).toBe(results[1]?.event_id);
        const counts = await pool.query(
            "SELECT (SELECT count(*) FROM meal_events WHERE user_id='a2-user') AS events, (SELECT count(*) FROM meal_event_versions WHERE event_id=$1) AS versions, (SELECT idempotency_key FROM meal_events WHERE id=$1) AS key",
            [results[0]!.event_id],
        );
        expect(Number(counts.rows[0].events)).toBe(1);
        expect(Number(counts.rows[0].versions)).toBe(1);
        expect(counts.rows[0].key).toBe(`capture:${capture.capture_id}`);
        const media = await pool.query(
            "SELECT kind, storage_key, sha256, metadata FROM meal_capture_media WHERE capture_id=$1",
            [capture.capture_id],
        );
        expect(media.rows).toHaveLength(1);
        expect(media.rows[0]).toMatchObject({
            kind: "photo",
            storage_key: "staged/photo.jpg",
            sha256: "b".repeat(64),
        });
        const eventMedia = await pool.query(
            "SELECT event_id, version, kind, storage_key, mime_type, byte_size, sha256 FROM meal_event_media WHERE event_id=$1",
            [results[0]!.event_id],
        );
        expect(eventMedia.rows).toHaveLength(1);
        expect(eventMedia.rows[0]).toMatchObject({
            event_id: results[0]!.event_id,
            version: 1,
            kind: stagedMedia.kind,
            storage_key: stagedMedia.storage_key,
            mime_type: stagedMedia.mime_type,
            byte_size: String(stagedMedia.byte_size),
            sha256: stagedMedia.sha256,
        });
    });

    test("rejects draft media that does not exactly match staged capture media", async () => {
        const capture = await startMealCapture(pool, {
            user_id: "a2-user",
            conversation_key: "mismatch",
            idempotency_key: "capture-mismatch",
        });
        await saveCaptureMedia(pool, capture.capture_id, "a2-user", {
            kind: "photo",
            storage_key: "staged/right.jpg",
            mime_type: "image/jpeg",
            byte_size: 12,
            sha256: "c".repeat(64),
        });
        await savePreparedDraft(pool, capture.capture_id, "a2-user", {
            ...draft,
            media: [
                {
                    kind: "photo",
                    storage_key: "staged/wrong.jpg",
                    mime_type: "image/jpeg",
                    byte_size: 12,
                    sha256: "c".repeat(64),
                },
            ],
        });
        await expect(
            confirmMealCapture(
                pool,
                { capture_id: capture.capture_id, confirmation: "add" },
                "a2-user",
            ),
        ).rejects.toThrow(/media provenance/);
        expect(
            (await getMealCapture(pool, capture.capture_id, "a2-user"))?.state,
        ).toBe("ready_to_confirm");
    });

    test("rolls back event aggregate when confirmation fails before capture update, then retries", async () => {
        const capture = await startMealCapture(pool, {
            user_id: "rollback-user",
            conversation_key: "rollback",
            idempotency_key: "capture-rollback",
        });
        const stagedMedia = {
            kind: "photo" as const,
            storage_key: "staged/rollback.jpg",
            mime_type: "image/jpeg",
            byte_size: 12,
            sha256: "d".repeat(64),
        };
        await saveCaptureMedia(
            pool,
            capture.capture_id,
            "rollback-user",
            stagedMedia,
        );
        await savePreparedDraft(pool, capture.capture_id, "rollback-user", {
            ...draft,
            media: [stagedMedia],
        });

        await expect(
            confirmMealCapture(
                pool,
                { capture_id: capture.capture_id, confirmation: "add" },
                "rollback-user",
                {
                    afterEventPersist: () => {
                        throw new Error("injected confirmation failure");
                    },
                },
            ),
        ).rejects.toThrow("injected confirmation failure");

        const afterFailure = await pool.query(
            `SELECT
                (SELECT count(*) FROM meal_events WHERE idempotency_key=$1) AS events,
                (SELECT count(*) FROM meal_event_versions WHERE event_id IN (SELECT id FROM meal_events WHERE idempotency_key=$1)) AS versions,
                (SELECT count(*) FROM meal_event_items WHERE event_id IN (SELECT id FROM meal_events WHERE idempotency_key=$1)) AS items,
                (SELECT count(*) FROM meal_event_media WHERE event_id IN (SELECT id FROM meal_events WHERE idempotency_key=$1)) AS media`,
            [`capture:${capture.capture_id}`],
        );
        expect(afterFailure.rows[0]).toMatchObject({
            events: "0",
            versions: "0",
            items: "0",
            media: "0",
        });
        expect(
            (await getMealCapture(pool, capture.capture_id, "rollback-user"))
                ?.state,
        ).toBe("ready_to_confirm");

        const retried = await confirmMealCapture(
            pool,
            { capture_id: capture.capture_id, confirmation: "add" },
            "rollback-user",
        );
        expect(retried.state).toBe("confirmed");
        const final = await pool.query(
            `SELECT
                (SELECT count(*) FROM meal_events WHERE idempotency_key=$1) AS events,
                (SELECT count(*) FROM meal_event_versions WHERE event_id=$2) AS versions,
                (SELECT count(*) FROM meal_event_items WHERE event_id=$2) AS items,
                (SELECT count(*) FROM meal_event_media WHERE event_id=$2) AS media`,
            [`capture:${capture.capture_id}`, retried.event_id],
        );
        expect(final.rows[0]).toMatchObject({
            events: "1",
            versions: "1",
            items: "2",
            media: "1",
        });
    });
});

// ---------------------------------------------------------------------------
// attachCaptureMediaBytes: real byte lifecycle against real PostgreSQL and a
// real temporary filesystem media root. Assertions read the filesystem bytes
// and recompute the hash — never DB metadata alone.
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

function sha256HexOf(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// Pool wrapper whose client rejects the media INSERT once armed — injects a
// failure between byte staging and COMMIT without touching production code.
function poolFailingMediaInsert(pool: Pool): Pool {
    const proxy = Object.create(pool) as Pool;
    proxy.connect = async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    return (text: unknown, ...rest: unknown[]) => {
                        if (
                            typeof text === "string" &&
                            text.includes("INSERT INTO meal_capture_media")
                        ) {
                            return Promise.reject(
                                new Error("injected media insert failure"),
                            );
                        }
                        return (realQuery as any)(text, ...rest);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    };
    return proxy;
}

// Pool wrapper whose client rejects the media identity SELECT once armed —
// injects a transactional failure into a duplicate attach after the original
// row has committed, without touching production code.
function poolFailingMediaIdentityCheck(pool: Pool): Pool {
    const proxy = Object.create(pool) as Pool;
    proxy.connect = async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    return (text: unknown, ...rest: unknown[]) => {
                        if (
                            typeof text === "string" &&
                            text.includes(
                                "FROM meal_capture_media WHERE capture_id=$1 AND sha256=$2",
                            )
                        ) {
                            return Promise.reject(
                                new Error(
                                    "injected media identity check failure",
                                ),
                            );
                        }
                        return (realQuery as any)(text, ...rest);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    };
    return proxy;
}

async function mediaRootFiles(root: string): Promise<string[]> {
    try {
        const entries = await readdir(root, { recursive: true });
        return entries
            .map((entry) => entry.toString())
            .filter((entry) =>
                /(?:^|\/)(?:photo|audio)-[0-9a-f]{64}$/.test(entry),
            )
            .sort();
    } catch {
        return [];
    }
}

describeDb("capture media byte lifecycle (attachCaptureMediaBytes)", () => {
    let pool: Pool;
    let mediaRoot: string;
    let mediaStore: MediaStore;
    beforeAll(async () => {
        pool = new Pool({ connectionString: url, max: 8 });
        const client = await pool.connect();
        try {
            await migrate(client);
        } finally {
            client.release();
        }
        mediaRoot = await mkdtemp(join(tmpdir(), "capture-media-test-"));
        mediaStore = createMediaStore(mediaRoot);
    });
    afterAll(async () => {
        await pool.end();
        await rm(mediaRoot, { recursive: true, force: true });
    });

    const startCapture = (key: string) =>
        startMealCapture(pool, {
            user_id: "media-user",
            conversation_key: key,
            idempotency_key: key,
        });

    test("happy path: stages bytes, persists row, on-disk hash matches", async () => {
        const capture = await startCapture("media-happy");
        const result = await attachCaptureMediaBytes(
            pool,
            mediaStore,
            capture.capture_id,
            "media-user",
            { kind: "photo", mime_type: "image/png", bytes_base64: PNG_BASE64 },
        );
        expect(result.deduplicated).toBe(false);
        expect(result.capture_state).toBe("receiving");
        expect(result.sha256).toBe(sha256HexOf(PNG_BYTES));
        expect(result.byte_size).toBe(PNG_BYTES.byteLength);
        expect(result.storage_key).toBe(
            `capture/${capture.capture_id}/photo-${result.sha256}.png`,
        );
        // Filesystem truth: the file exists and its bytes recompute to the
        // returned hash.
        const path = join(mediaRoot, result.storage_key);
        expect(await Bun.file(path).exists()).toBe(true);
        const onDisk = new Uint8Array(await Bun.file(path).arrayBuffer());
        expect(onDisk).toEqual(PNG_BYTES);
        expect(sha256HexOf(onDisk)).toBe(result.sha256);
        // DB row matches the returned identity.
        const { rows } = await pool.query(
            `SELECT storage_key, mime_type, byte_size, sha256 FROM meal_capture_media WHERE id=$1 AND capture_id=$2`,
            [result.media_id, capture.capture_id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            storage_key: result.storage_key,
            mime_type: "image/png",
            sha256: result.sha256,
        });
        expect(Number(rows[0]!.byte_size)).toBe(PNG_BYTES.byteLength);
    });

    test("rollback: injected INSERT failure removes both DB row and staged file", async () => {
        const capture = await startCapture("media-rollback");
        await expect(
            attachCaptureMediaBytes(
                poolFailingMediaInsert(pool),
                mediaStore,
                capture.capture_id,
                "media-user",
                {
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: PNG_BASE64,
                },
            ),
        ).rejects.toThrow("injected media insert failure");
        const { rows } = await pool.query(
            `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
            [capture.capture_id],
        );
        expect(Number(rows[0]!.n)).toBe(0);
        const stagedPath = join(
            mediaRoot,
            `capture/${capture.capture_id}/photo-${sha256HexOf(PNG_BYTES)}.png`,
        );
        expect(await Bun.file(stagedPath).exists()).toBe(false);
    });

    test("retry-safe: identical bytes attached twice yield one row and one file", async () => {
        const capture = await startCapture("media-retry");
        const input = {
            kind: "photo" as const,
            mime_type: "image/png",
            bytes_base64: PNG_BASE64,
        };
        const first = await attachCaptureMediaBytes(
            pool,
            mediaStore,
            capture.capture_id,
            "media-user",
            input,
        );
        const second = await attachCaptureMediaBytes(
            pool,
            mediaStore,
            capture.capture_id,
            "media-user",
            input,
        );
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.media_id).toBe(first.media_id);
        expect(second.storage_key).toBe(first.storage_key);
        expect(second.sha256).toBe(first.sha256);
        const { rows } = await pool.query(
            `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
            [capture.capture_id],
        );
        expect(Number(rows[0]!.n)).toBe(1);
        const path = join(mediaRoot, first.storage_key);
        expect(await Bun.file(path).exists()).toBe(true);
        const onDisk = new Uint8Array(await Bun.file(path).arrayBuffer());
        expect(sha256HexOf(onDisk)).toBe(first.sha256);
    });

    test("tampered caller sha256 is rejected; nothing staged or persisted", async () => {
        const capture = await startCapture("media-tampered");
        const filesBefore = await mediaRootFiles(mediaRoot);
        await expect(
            attachCaptureMediaBytes(
                pool,
                mediaStore,
                capture.capture_id,
                "media-user",
                {
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: PNG_BASE64,
                    sha256: "0".repeat(64),
                },
            ),
        ).rejects.toThrow(/sha256/i);
        const { rows } = await pool.query(
            `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
            [capture.capture_id],
        );
        expect(Number(rows[0]!.n)).toBe(0);
        expect(await mediaRootFiles(mediaRoot)).toEqual(filesBefore);
    });

    test("state guard: attach on a cancelled capture stages nothing", async () => {
        const capture = await startCapture("media-cancelled");
        await cancelMealCapture(pool, capture.capture_id, "media-user");
        const filesBefore = await mediaRootFiles(mediaRoot);
        await expect(
            attachCaptureMediaBytes(
                pool,
                mediaStore,
                capture.capture_id,
                "media-user",
                {
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: PNG_BASE64,
                },
            ),
        ).rejects.toThrow("capture is no longer editable");
        const { rows } = await pool.query(
            `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
            [capture.capture_id],
        );
        expect(Number(rows[0]!.n)).toBe(0);
        expect(await mediaRootFiles(mediaRoot)).toEqual(filesBefore);
    });

    test("cross-user attach is rejected as not found; nothing staged", async () => {
        const capture = await startMealCapture(pool, {
            user_id: "other-user",
            conversation_key: "media-cross-user",
            idempotency_key: "media-cross-user",
        });
        const filesBefore = await mediaRootFiles(mediaRoot);
        await expect(
            attachCaptureMediaBytes(
                pool,
                mediaStore,
                capture.capture_id,
                "media-user",
                {
                    kind: "photo",
                    mime_type: "image/png",
                    bytes_base64: PNG_BASE64,
                },
            ),
        ).rejects.toThrow("capture not found");
        expect(await mediaRootFiles(mediaRoot)).toEqual(filesBefore);
    });
});

// ---------------------------------------------------------------------------
// S5 F1 adversarial durability: every case FIRST attaches valid bytes and
// commits the meal_capture_media row, then proves that a rejected, failed,
// duplicate, or concurrent invocation can neither delete nor overwrite the
// committed file. Assertions read real filesystem bytes and recompute the
// committed SHA-256 — never DB metadata alone.
// ---------------------------------------------------------------------------

describeDb(
    "capture media durability under rejected and duplicate retries (S5 F1)",
    () => {
        let pool: Pool;
        let mediaRoot: string;
        let mediaStore: MediaStore;
        beforeAll(async () => {
            pool = new Pool({ connectionString: url, max: 8 });
            const client = await pool.connect();
            try {
                await migrate(client);
            } finally {
                client.release();
            }
            mediaRoot = await mkdtemp(join(tmpdir(), "capture-media-f1-test-"));
            mediaStore = createMediaStore(mediaRoot);
        });
        afterAll(async () => {
            await pool.end();
            await rm(mediaRoot, { recursive: true, force: true });
        });

        const OWNER = "durability-user";
        const startCapture = (key: string) =>
            startMealCapture(pool, {
                user_id: OWNER,
                conversation_key: key,
                idempotency_key: key,
            });
        const attachPng = (
            captureId: string,
            userId: string,
            targetPool: Pool = pool,
        ) =>
            attachCaptureMediaBytes(targetPool, mediaStore, captureId, userId, {
                kind: "photo",
                mime_type: "image/png",
                bytes_base64: PNG_BASE64,
            });

        // The committed row, the file bytes, and the recomputed SHA-256 must all
        // survive any rejected/failed/duplicate later attempt.
        async function expectCommittedMediaIntact(
            captureId: string,
            mediaId: string,
            storageKey: string,
            expectedSha: string,
        ) {
            const { rows } = await pool.query(
                `SELECT id, storage_key, sha256 FROM meal_capture_media WHERE capture_id=$1`,
                [captureId],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                id: mediaId,
                storage_key: storageKey,
                sha256: expectedSha,
            });
            const path = join(mediaRoot, storageKey);
            expect(await Bun.file(path).exists()).toBe(true);
            const onDisk = new Uint8Array(await Bun.file(path).arrayBuffer());
            expect(onDisk).toEqual(PNG_BYTES);
            expect(sha256HexOf(onDisk)).toBe(expectedSha);
        }

        test("wrong-user retry of committed bytes preserves the original row and file", async () => {
            const capture = await startCapture("f1-wrong-user");
            const first = await attachPng(capture.capture_id, OWNER);
            await expect(
                attachPng(capture.capture_id, "intruder"),
            ).rejects.toThrow("capture not found");
            await expectCommittedMediaIntact(
                capture.capture_id,
                first.media_id,
                first.storage_key,
                first.sha256,
            );
        });

        test("same-owner retry after cancel preserves the original row and file", async () => {
            const capture = await startCapture("f1-cancelled");
            const first = await attachPng(capture.capture_id, OWNER);
            await cancelMealCapture(pool, capture.capture_id, OWNER);
            await expect(attachPng(capture.capture_id, OWNER)).rejects.toThrow(
                "capture is no longer editable",
            );
            await expectCommittedMediaIntact(
                capture.capture_id,
                first.media_id,
                first.storage_key,
                first.sha256,
            );
        });

        test("same-owner retry after confirmation preserves the original row, file, and event reference", async () => {
            const capture = await startCapture("f1-confirmed");
            const first = await attachPng(capture.capture_id, OWNER);
            await savePreparedDraft(pool, capture.capture_id, OWNER, {
                ...draft,
                media: [
                    {
                        kind: "photo",
                        storage_key: first.storage_key,
                        mime_type: "image/png",
                        byte_size: first.byte_size,
                        sha256: first.sha256,
                        metadata: {},
                    },
                ],
            });
            const confirmed = await confirmMealCapture(
                pool,
                { capture_id: capture.capture_id, confirmation: "add" },
                OWNER,
            );
            expect(confirmed.state).toBe("confirmed");
            const eventMedia = await pool.query(
                `SELECT count(*) AS n FROM meal_event_media WHERE event_id=$1 AND storage_key=$2`,
                [confirmed.event_id, first.storage_key],
            );
            expect(Number(eventMedia.rows[0]!.n)).toBe(1);
            await expect(attachPng(capture.capture_id, OWNER)).rejects.toThrow(
                "capture is no longer editable",
            );
            await expectCommittedMediaIntact(
                capture.capture_id,
                first.media_id,
                first.storage_key,
                first.sha256,
            );
        });

        test("injected transactional failure on a duplicate attempt preserves the original row and file", async () => {
            const capture = await startCapture("f1-injected");
            const first = await attachPng(capture.capture_id, OWNER);
            await expect(
                attachPng(
                    capture.capture_id,
                    OWNER,
                    poolFailingMediaIdentityCheck(pool),
                ),
            ).rejects.toThrow("injected media identity check failure");
            await expectCommittedMediaIntact(
                capture.capture_id,
                first.media_id,
                first.storage_key,
                first.sha256,
            );
        });

        test("coordinated concurrent duplicate success and rejected/failing attempts preserve the original row and file", async () => {
            const capture = await startCapture("f1-concurrent");
            const first = await attachPng(capture.capture_id, OWNER);
            const results = await Promise.allSettled([
                attachPng(capture.capture_id, OWNER),
                attachPng(capture.capture_id, OWNER),
                attachPng(capture.capture_id, "intruder"),
                attachPng(
                    capture.capture_id,
                    OWNER,
                    poolFailingMediaIdentityCheck(pool),
                ),
            ]);
            expect(results.map((r) => r.status)).toEqual([
                "fulfilled",
                "fulfilled",
                "rejected",
                "rejected",
            ]);
            for (const r of results.slice(0, 2)) {
                const value = (
                    r as PromiseFulfilledResult<
                        Awaited<ReturnType<typeof attachPng>>
                    >
                ).value;
                expect(value.deduplicated).toBe(true);
                expect(value.media_id).toBe(first.media_id);
                expect(value.storage_key).toBe(first.storage_key);
            }
            expect(
                (results[2] as PromiseRejectedResult).reason.message,
            ).toMatch(/capture not found/);
            expect(
                (results[3] as PromiseRejectedResult).reason.message,
            ).toMatch(/injected media identity check failure/);
            await expectCommittedMediaIntact(
                capture.capture_id,
                first.media_id,
                first.storage_key,
                first.sha256,
            );
        });

        test("dedup retry heals a missing committed file with identical bytes", async () => {
            const capture = await startCapture("f1-heal");
            const first = await attachPng(capture.capture_id, OWNER);
            const path = join(mediaRoot, first.storage_key);
            await Bun.file(path).delete();
            expect(await Bun.file(path).exists()).toBe(false);
            const second = await attachPng(capture.capture_id, OWNER);
            expect(second.deduplicated).toBe(true);
            expect(second.media_id).toBe(first.media_id);
            await expectCommittedMediaIntact(
                capture.capture_id,
                first.media_id,
                first.storage_key,
                first.sha256,
            );
        });
    },
);

// ---------------------------------------------------------------------------
// S5 second remediation: COMMIT-outcome phase awareness + ON CONFLICT
// different-key orphan removal. A COMMIT error is an UNKNOWN outcome, not
// proof of rollback: the server may have durably committed while the
// acknowledgement was lost. The attach must reconcile on a fresh connection
// under a fresh capture-row lock and must NEVER delete a file whose row may
// have committed. Pool proxies below inject real PostgreSQL COMMIT outcomes
// without touching production code.
// ---------------------------------------------------------------------------

// Runs the real COMMIT on the server, then rejects ONLY the acknowledgement
// returned to the caller: the transaction is durably committed but the client
// observes an error. One-shot: the first COMMIT through the proxy loses its
// acknowledgement, later COMMITs (e.g. reconciliation) pass through.
function poolLosingCommitAcknowledgement(pool: Pool): Pool {
    let armed = true;
    const proxy = Object.create(pool) as Pool;
    proxy.connect = async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    return (text: unknown, ...rest: unknown[]) => {
                        if (
                            armed &&
                            typeof text === "string" &&
                            text.trim() === "COMMIT"
                        ) {
                            armed = false;
                            return (realQuery as any)(text, ...rest).then(
                                () => {
                                    throw new Error(
                                        "injected lost COMMIT acknowledgement after server commit",
                                    );
                                },
                            );
                        }
                        return (realQuery as any)(text, ...rest);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    };
    return proxy;
}

// Rejects COMMIT WITHOUT sending it to the server: the transaction is
// definitively never committed. One-shot so a later reconciliation COMMIT
// passes through.
function poolRejectingCommitBeforeSend(pool: Pool): Pool {
    let armed = true;
    const proxy = Object.create(pool) as Pool;
    proxy.connect = async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    return (text: unknown, ...rest: unknown[]) => {
                        if (
                            armed &&
                            typeof text === "string" &&
                            text.trim() === "COMMIT"
                        ) {
                            armed = false;
                            return Promise.reject(
                                new Error(
                                    "injected COMMIT rejected before being sent",
                                ),
                            );
                        }
                        return (realQuery as any)(text, ...rest);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    };
    return proxy;
}

// Runs the real COMMIT, loses its acknowledgement, AND refuses every later
// connection: reconciliation is unavailable, so the staged file must be
// retained as a possible orphan rather than risk referenced data.
function poolLosingCommitAckAndFailingReconnect(pool: Pool): Pool {
    let ackLost = false;
    const proxy = Object.create(pool) as Pool;
    proxy.connect = async () => {
        if (ackLost)
            throw new Error("injected reconciliation connection failure");
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    return (text: unknown, ...rest: unknown[]) => {
                        if (
                            !ackLost &&
                            typeof text === "string" &&
                            text.trim() === "COMMIT"
                        ) {
                            return (realQuery as any)(text, ...rest).then(
                                () => {
                                    ackLost = true;
                                    throw new Error(
                                        "injected lost COMMIT acknowledgement after server commit",
                                    );
                                },
                            );
                        }
                        return (realQuery as any)(text, ...rest);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    };
    return proxy;
}

// Hides the FIRST (capture_id, sha256) identity lookup from the attach
// transaction — simulating a conflicting row committed by a non-cooperating
// writer (no capture-row lock) in the window between the identity check and
// the INSERT. The conflicting row itself is committed beforehand through the
// real pool; only the first SELECT is masked, so the ON CONFLICT branch's own
// re-read sees the real conflicting row.
function poolHidingFirstMediaIdentityCheck(pool: Pool): Pool {
    let armed = true;
    const proxy = Object.create(pool) as Pool;
    proxy.connect = async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    return (text: unknown, ...rest: unknown[]) => {
                        if (
                            armed &&
                            typeof text === "string" &&
                            text.includes(
                                "FROM meal_capture_media WHERE capture_id=$1 AND sha256=$2",
                            )
                        ) {
                            armed = false;
                            return Promise.resolve({
                                rows: [],
                                rowCount: 0,
                            });
                        }
                        return (realQuery as any)(text, ...rest);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    };
    return proxy;
}

describeDb(
    "capture media commit-outcome reconciliation (S5 remediation 2)",
    () => {
        let pool: Pool;
        let mediaRoot: string;
        let mediaStore: MediaStore;
        beforeAll(async () => {
            pool = new Pool({ connectionString: url, max: 8 });
            const client = await pool.connect();
            try {
                await migrate(client);
            } finally {
                client.release();
            }
            mediaRoot = await mkdtemp(join(tmpdir(), "capture-media-f2-test-"));
            mediaStore = createMediaStore(mediaRoot);
        });
        afterAll(async () => {
            await pool.end();
            await rm(mediaRoot, { recursive: true, force: true });
        });

        const OWNER = "commit-outcome-user";
        const startCapture = (key: string) =>
            startMealCapture(pool, {
                user_id: OWNER,
                conversation_key: key,
                idempotency_key: key,
            });
        const attachPng = (
            captureId: string,
            userId: string,
            targetPool: Pool = pool,
        ) =>
            attachCaptureMediaBytes(targetPool, mediaStore, captureId, userId, {
                kind: "photo",
                mime_type: "image/png",
                bytes_base64: PNG_BASE64,
            });
        const stagedKeyOf = (captureId: string) =>
            `capture/${captureId}/photo-${sha256HexOf(PNG_BYTES)}.png`;
        const expectFileIntact = async (storageKey: string) => {
            const path = join(mediaRoot, storageKey);
            expect(await Bun.file(path).exists()).toBe(true);
            const onDisk = new Uint8Array(await Bun.file(path).arrayBuffer());
            expect(onDisk).toEqual(PNG_BYTES);
            expect(sha256HexOf(onDisk)).toBe(sha256HexOf(PNG_BYTES));
        };

        test("real COMMIT succeeds then acknowledgement is lost: attach rejects but row and file survive, retry returns the original identity", async () => {
            const capture = await startCapture("f2-ack-lost");
            const storageKey = stagedKeyOf(capture.capture_id);
            await expect(
                attachPng(
                    capture.capture_id,
                    OWNER,
                    poolLosingCommitAcknowledgement(pool),
                ),
            ).rejects.toThrow(
                "injected lost COMMIT acknowledgement after server commit",
            );
            // The server durably committed: the row must survive ...
            const { rows } = await pool.query(
                `SELECT id, storage_key, sha256 FROM meal_capture_media WHERE capture_id=$1`,
                [capture.capture_id],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                storage_key: storageKey,
                sha256: sha256HexOf(PNG_BYTES),
            });
            // ... and so must the referenced bytes, with a recomputed SHA match.
            await expectFileIntact(storageKey);
            // A clean retry reconciles to the original committed identity.
            const retry = await attachPng(capture.capture_id, OWNER);
            expect(retry.deduplicated).toBe(true);
            expect(retry.media_id).toBe(rows[0]!.id);
            expect(retry.storage_key).toBe(storageKey);
            expect(retry.sha256).toBe(sha256HexOf(PNG_BYTES));
        });

        test("real COMMIT succeeds then acknowledgement is lost AND reconciliation is unavailable: possible orphan is retained, never deleted", async () => {
            const capture = await startCapture("f2-ack-lost-no-reconnect");
            const storageKey = stagedKeyOf(capture.capture_id);
            await expect(
                attachPng(
                    capture.capture_id,
                    OWNER,
                    poolLosingCommitAckAndFailingReconnect(pool),
                ),
            ).rejects.toThrow(
                "injected lost COMMIT acknowledgement after server commit",
            );
            const { rows } = await pool.query(
                `SELECT id, storage_key, sha256 FROM meal_capture_media WHERE capture_id=$1`,
                [capture.capture_id],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                storage_key: storageKey,
                sha256: sha256HexOf(PNG_BYTES),
            });
            // Reconciliation could not run: retain rather than risk referenced
            // data — the committed file must still be there.
            await expectFileIntact(storageKey);
            const retry = await attachPng(capture.capture_id, OWNER);
            expect(retry.deduplicated).toBe(true);
            expect(retry.media_id).toBe(rows[0]!.id);
            expect(retry.storage_key).toBe(storageKey);
        });

        test("COMMIT rejected before being sent: reconciliation proves no row and removes the staged file", async () => {
            const capture = await startCapture("f2-commit-rejected");
            const storageKey = stagedKeyOf(capture.capture_id);
            await expect(
                attachPng(
                    capture.capture_id,
                    OWNER,
                    poolRejectingCommitBeforeSend(pool),
                ),
            ).rejects.toThrow("injected COMMIT rejected before being sent");
            const { rows } = await pool.query(
                `SELECT count(*) AS n FROM meal_capture_media WHERE capture_id=$1`,
                [capture.capture_id],
            );
            expect(Number(rows[0]!.n)).toBe(0);
            expect(await Bun.file(join(mediaRoot, storageKey)).exists()).toBe(
                false,
            );
        });

        test("non-cooperating conflicting row with a different key: conflict row and file survive, redundant staged key is removed", async () => {
            const capture = await startCapture("f2-conflict-different-key");
            const sha = sha256HexOf(PNG_BYTES);
            const stagedKey = stagedKeyOf(capture.capture_id);
            const foreignKey = `capture/${capture.capture_id}/photo-foreign-${sha}`;
            // The non-cooperating writer's referenced bytes exist on disk.
            await mediaStore.restore({
                storage_key: foreignKey,
                bytes: PNG_BYTES,
                mime_type: "image/png",
            });
            // Non-cooperating writer: commits a conflicting (capture_id, sha256)
            // row directly, WITHOUT the capture-row lock, with a DIFFERENT
            // storage_key. The attach's masked identity check simulates the row
            // arriving after the check; the INSERT then hits ON CONFLICT.
            const conflict = await pool.query(
                `INSERT INTO meal_capture_media (capture_id,kind,storage_key,mime_type,byte_size,sha256,metadata) VALUES ($1,'photo',$2,'image/png',$3,$4,'{}'::jsonb) RETURNING id`,
                [capture.capture_id, foreignKey, PNG_BYTES.byteLength, sha],
            );
            const result = await attachPng(
                capture.capture_id,
                OWNER,
                poolHidingFirstMediaIdentityCheck(pool),
            );
            expect(result.deduplicated).toBe(true);
            expect(result.media_id).toBe(conflict.rows[0]!.id);
            expect(result.storage_key).toBe(foreignKey);
            // The conflicting row survives and keeps its own storage key.
            const { rows } = await pool.query(
                `SELECT id, storage_key, sha256 FROM meal_capture_media WHERE capture_id=$1`,
                [capture.capture_id],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                id: result.media_id,
                storage_key: foreignKey,
                sha256: sha,
            });
            // The conflicting row's file survives byte-identically ...
            await expectFileIntact(foreignKey);
            // ... and the invocation-owned, unreferenced staged key is removed.
            expect(await Bun.file(join(mediaRoot, stagedKey)).exists()).toBe(
                false,
            );
        });
    },
);
