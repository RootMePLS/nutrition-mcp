import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool } from "pg";
import {
    DAILY_RETENTION_DAYS,
    permanentDeleteMealEvent,
    retentionExpiresAt,
    retentionPolicy,
} from "./backup-policy.js";
import {
    createMealEvent,
    getMealEvent,
    tombstoneMealEvent,
} from "./meal-events.js";

// ---------------------------------------------------------------------------
// Backup/delete policy contracts. Pure retention rules plus permanent-delete
// orchestration against INJECTED adapters — this slice schedules no jobs,
// uploads no snapshots and claims no backup execution.
// ---------------------------------------------------------------------------

describe("backup retention policy", () => {
    test("policy returns independent DB and media targets", () => {
        const policy = retentionPolicy();
        expect(policy.postgres).not.toBe(policy.media);
        expect(policy.postgres.kind).toBe("postgres");
        expect(policy.media.kind).toBe("media");
        expect(Object.keys(policy).sort()).toEqual(["media", "postgres"]);
    });

    test("daily retention is exactly 30 days", () => {
        expect(DAILY_RETENTION_DAYS).toBe(30);
        const created = new Date("2026-08-04T00:00:00.000Z");
        const expires = retentionExpiresAt("daily", created);
        expect(expires).not.toBeNull();
        expect(expires!.getTime() - created.getTime()).toBe(
            30 * 24 * 60 * 60 * 1000,
        );
    });

    test("monthly retention is forever (no expiry)", () => {
        expect(
            retentionExpiresAt("monthly", new Date("2026-08-04T00:00:00.000Z")),
        ).toBeNull();
    });
});

describe("permanent delete orchestration", () => {
    const manifests = [
        { kind: "postgres" as const, snapshot_key: "pg-2026-08-04" },
        { kind: "media" as const, snapshot_key: "media-2026-08-04" },
    ];

    function deps(overrides: Record<string, unknown> = {}) {
        const calls = {
            live: 0,
            media: [] as string[],
            backups: [] as { kind: string; key: string }[],
        };
        return {
            calls,
            args: {
                confirmation_token: "CONFIRM-DELETE",
                expected_confirmation_token: "CONFIRM-DELETE",
                deleteLiveRows: async () => {
                    calls.live++;
                    return { event_deleted: true };
                },
                media_keys: ["evt/1/photo-abc"],
                deleteMedia: async (key: string) => {
                    calls.media.push(key);
                },
                manifests,
                deleteBackup: async (kind: string, key: string) => {
                    calls.backups.push({ kind, key });
                    return { confirmed: true };
                },
                ...overrides,
            },
        };
    }

    test("permanent delete refuses without explicit confirmation", async () => {
        const { calls, args } = deps({ confirmation_token: undefined });
        const receipt = await permanentDeleteMealEvent(args);
        expect(receipt.status).toBe("refused");
        expect(calls.live).toBe(0);
        expect(calls.media.length).toBe(0);
        expect(calls.backups.length).toBe(0);

        const wrong = deps({ confirmation_token: "wrong-token" });
        const wrongReceipt = await permanentDeleteMealEvent(wrong.args);
        expect(wrongReceipt.status).toBe("refused");
        expect(wrong.calls.live).toBe(0);
    });

    test("permanent delete removes live data and calls both backup adapters", async () => {
        const { calls, args } = deps();
        const receipt = await permanentDeleteMealEvent(args);
        expect(receipt.status).toBe("completed");
        expect(calls.live).toBe(1);
        expect(calls.media).toEqual(["evt/1/photo-abc"]);
        expect(calls.backups).toEqual([
            { kind: "postgres", key: "pg-2026-08-04" },
            { kind: "media", key: "media-2026-08-04" },
        ]);
        expect(receipt.backup_results.every((r) => r.confirmed)).toBe(true);
    });

    test("an unconfirmed backup adapter yields a partial receipt, never claimed success", async () => {
        const { calls, args } = deps({
            deleteBackup: async (kind: string, key: string) => {
                calls.backups.push({ kind, key });
                return kind === "media"
                    ? { confirmed: false, detail: "provider timeout" }
                    : { confirmed: true };
            },
        });
        const receipt = await permanentDeleteMealEvent(args);
        expect(receipt.status).toBe("partial");
        const media = receipt.backup_results.find((r) => r.kind === "media");
        expect(media!.confirmed).toBe(false);
        expect(media!.detail).toBe("provider timeout");
    });
});

// ---------------------------------------------------------------------------
// Ordinary delete (tombstone) — DB-gated.
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/backup-policy.test.ts: tombstone tests SKIPPED — " +
            "DATABASE_URL_TEST is not set",
    );
}

const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

describeDb("ordinary delete tombstone (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST });
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            await client.query(
                await Bun.file("db/migrations/001_initial_schema.sql").text(),
            );
            await client.query(
                await Bun.file("db/migrations/002_food_tracking.sql").text(),
            );
        } finally {
            client.release();
        }
    });

    test("tombstone keeps versions, media metadata and backup manifests untouched", async () => {
        const created = await createMealEvent(pool, {
            user_id: "u1",
            idempotency_key: "create:tombstone",
            reported_at: "2026-08-04T12:00:00.000Z",
            items: [{ ordinal: 0, raw_item_text: "soup" }],
            inputs: [{ source_kind: "user_text", content: "soup" }],
            media: [
                {
                    kind: "photo",
                    storage_key: "evt/1/photo-abc",
                    mime_type: "image/jpeg",
                    byte_size: 10,
                    sha256: "b".repeat(64),
                },
            ],
            provider_results: [],
            parser_policy_version: "policy-1",
            created_by: "test",
        });
        await pool.query(
            `INSERT INTO backup_manifests (backup_kind, retention_class, snapshot_key, checksum)
             VALUES ('postgres', 'daily', 'pg-1', 'x'), ('media', 'daily', 'media-1', 'y')`,
        );

        await tombstoneMealEvent(pool, created.event_id);

        const aggregate = await getMealEvent(pool, created.event_id);
        expect(aggregate!.event.status).toBe("deleted");
        expect(aggregate!.event.deleted_at).not.toBeNull();
        // History, media metadata and manifests survive ordinary delete.
        expect(aggregate!.items.length).toBe(1);
        expect(aggregate!.media.length).toBe(1);
        const { rows } = await pool.query(
            `SELECT count(*) AS n FROM backup_manifests
             WHERE deletion_status = 'present'`,
        );
        expect(Number(rows[0]!.n)).toBe(2);
    });
});
