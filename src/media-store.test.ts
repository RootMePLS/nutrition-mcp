import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createMediaStore,
    MediaChecksumError,
    MediaNotFoundError,
    UnsafeStorageKeyError,
} from "./media-store.js";

// ---------------------------------------------------------------------------
// Safe media storage contract: bytes live under a configured root, addressed
// only by generated opaque keys. Postgres stores metadata only.
// ---------------------------------------------------------------------------

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nutrition-mcp-media-test-"));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const BYTES = new TextEncoder().encode("fake-jpeg-bytes");

describe("media store", () => {
    test("bytes are written under MEDIA_ROOT with a generated event/version key", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-1",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "image/jpeg",
        });
        expect(meta.storage_key).toContain("evt-1");
        expect(meta.storage_key).toContain("1");
        // The key is relative and stays under the root.
        expect(meta.storage_key.startsWith("/")).toBe(false);
        expect(meta.storage_key).not.toContain("..");
        const onDisk = join(root, meta.storage_key);
        expect(existsSync(onDisk)).toBe(true);
        const written = new Uint8Array(await Bun.file(onDisk).arrayBuffer());
        expect(written).toEqual(BYTES);
    });

    test("returned metadata carries MIME, byte size and SHA-256", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-2",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "image/jpeg",
        });
        const expectedSha = new Bun.CryptoHasher("sha256")
            .update(BYTES)
            .digest("hex");
        expect(meta.mime_type).toBe("image/jpeg");
        expect(meta.byte_size).toBe(BYTES.byteLength);
        expect(meta.sha256).toBe(expectedSha);
    });

    test("unsafe keys cannot select arbitrary paths", async () => {
        const store = createMediaStore(root);
        const unsafe = [
            "/etc/passwd",
            "../outside",
            "a/../../b",
            "..",
            "a\\..\\b",
            "/absolute/key",
        ];
        for (const key of unsafe) {
            await expect(
                store.read(key, "0".repeat(64)),
            ).rejects.toBeInstanceOf(UnsafeStorageKeyError);
            await expect(store.delete(key)).rejects.toBeInstanceOf(
                UnsafeStorageKeyError,
            );
        }
    });

    test("read verifies the expected checksum and returns the bytes", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-3",
            version: 2,
            kind: "audio",
            bytes: BYTES,
            mime_type: "audio/ogg",
        });
        const bytes = await store.read(meta.storage_key, meta.sha256);
        expect(bytes).toEqual(BYTES);
    });

    test("missing file and checksum mismatch are explicit errors", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-4",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "image/jpeg",
        });
        await expect(
            store.read("evt-4/1/nonexistent", "0".repeat(64)),
        ).rejects.toBeInstanceOf(MediaNotFoundError);
        await expect(
            store.read(meta.storage_key, "f".repeat(64)),
        ).rejects.toBeInstanceOf(MediaChecksumError);
    });

    test("delete uses only the generated key and is idempotent", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-5",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "image/jpeg",
        });
        await store.delete(meta.storage_key);
        expect(existsSync(join(root, meta.storage_key))).toBe(false);
        // Second delete is a no-op, not an error.
        await store.delete(meta.storage_key);
    });

    test("restore rewrites verified bytes at an already-referenced key", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-6",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "image/jpeg",
        });
        await store.delete(meta.storage_key);
        expect(existsSync(join(root, meta.storage_key))).toBe(false);
        const restored = await store.restore({
            storage_key: meta.storage_key,
            bytes: BYTES,
            mime_type: "image/jpeg",
        });
        expect(restored).toEqual(meta);
        const reread = await store.read(meta.storage_key, meta.sha256);
        expect(reread).toEqual(BYTES);
    });

    test("restore rejects unsafe keys before any I/O", async () => {
        const store = createMediaStore(root);
        await expect(
            store.restore({
                storage_key: "../outside",
                bytes: BYTES,
                mime_type: "image/jpeg",
            }),
        ).rejects.toBeInstanceOf(UnsafeStorageKeyError);
    });
});
