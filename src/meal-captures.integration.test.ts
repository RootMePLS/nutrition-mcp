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
        await appendCaptureMessage(pool, started.capture_id, {
            external_message_id: "m1",
            kind: "text",
            text: "hi",
        });
        await appendCaptureMessage(pool, started.capture_id, {
            external_message_id: "m1",
            kind: "text",
            text: "changed",
        });
        await saveCaptureAnswer(pool, started.capture_id, {
            question: "how much?",
            answer: "one bowl",
        });
        await saveCaptureAnswer(pool, started.capture_id, {
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
        await saveCaptureMedia(pool, capture.capture_id, "a2-user", {
            kind: "photo",
            storage_key: "staged/photo.jpg",
            mime_type: "image/jpeg",
            byte_size: 12,
            sha256: "b".repeat(64),
            metadata: { width: 10 },
        });
        await savePreparedDraft(pool, capture.capture_id, draft);
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
    });
});
