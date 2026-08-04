import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
    appendCaptureMessage,
    cancelMealCapture,
    confirmMealCapture,
    expireMealCapture,
    getMealCapture,
    saveCaptureAnswer,
    saveCaptureMedia,
    savePreparedDraft,
    startMealCapture,
} from "./meal-captures.js";
import type { PreparedMealDraft } from "./meal-capture-types.js";

const url = process.env.DATABASE_URL_TEST;
const describeDb = url ? describe : describe.skip;
const migrations = [
    "db/migrations/001_initial_schema.sql",
    "db/migrations/002_food_tracking.sql",
    "db/migrations/003_meal_captures.sql",
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
