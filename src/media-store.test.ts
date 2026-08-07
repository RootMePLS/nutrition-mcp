import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createMediaStore,
    generateCaptureStorageKey,
    generateStorageKey,
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

    // --- storage key extension tests ---

    test("storage key includes file extension for known MIME types", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-ext",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "image/png",
        });
        expect(meta.storage_key).toEndWith(".png");
    });

    test("storage key omits extension for unknown MIME types", async () => {
        const store = createMediaStore(root);
        const meta = await store.put({
            event_id: "evt-noext",
            version: 1,
            kind: "photo",
            bytes: BYTES,
            mime_type: "application/octet-stream",
        });
        expect(meta.storage_key).not.toContain(".octet-stream");
        const sha = new Bun.CryptoHasher("sha256").update(BYTES).digest("hex");
        expect(meta.storage_key).toEndWith(`photo-${sha}`);
    });

    test("generateStorageKey appends extension for known MIME", () => {
        const key = generateStorageKey({
            event_id: "evt-1",
            version: 1,
            kind: "photo",
            sha256: "abc123",
            mime_type: "image/jpeg",
        });
        expect(key).toBe("evt-1/1/photo-abc123.jpg");
    });

    test("generateStorageKey omits extension when mime_type missing", () => {
        const key = generateStorageKey({
            event_id: "evt-1",
            version: 1,
            kind: "photo",
            sha256: "abc123",
        });
        expect(key).toBe("evt-1/1/photo-abc123");
    });

    test("generateStorageKey omits extension for unknown MIME", () => {
        const key = generateStorageKey({
            event_id: "evt-1",
            version: 1,
            kind: "photo",
            sha256: "abc123",
            mime_type: "application/octet-stream",
        });
        expect(key).toBe("evt-1/1/photo-abc123");
    });

    test("generateCaptureStorageKey appends extension for known MIME", () => {
        const key = generateCaptureStorageKey({
            capture_id: "cap-1",
            kind: "photo",
            sha256: "abc123",
            mime_type: "image/webp",
        });
        expect(key).toBe("capture/cap-1/photo-abc123.webp");
    });

    test("generateCaptureStorageKey appends .ogg for audio", () => {
        const key = generateCaptureStorageKey({
            capture_id: "cap-2",
            kind: "audio",
            sha256: "def456",
            mime_type: "audio/ogg",
        });
        expect(key).toBe("capture/cap-2/audio-def456.ogg");
    });

    test("generateCaptureStorageKey omits extension when mime_type missing", () => {
        const key = generateCaptureStorageKey({
            capture_id: "cap-1",
            kind: "photo",
            sha256: "abc123",
        });
        expect(key).toBe("capture/cap-1/photo-abc123");
    });

    test("generateCaptureStorageKey omits extension for unknown MIME", () => {
        const key = generateCaptureStorageKey({
            capture_id: "cap-1",
            kind: "photo",
            sha256: "abc123",
            mime_type: "application/octet-stream",
        });
        expect(key).toBe("capture/cap-1/photo-abc123");
    });

    test("audio MIME types get correct extensions", () => {
        expect(
            generateCaptureStorageKey({
                capture_id: "cap-a",
                kind: "audio",
                sha256: "xyz",
                mime_type: "audio/mpeg",
            }),
        ).toBe("capture/cap-a/audio-xyz.mp3");
        expect(
            generateCaptureStorageKey({
                capture_id: "cap-a",
                kind: "audio",
                sha256: "xyz",
                mime_type: "audio/mp4",
            }),
        ).toBe("capture/cap-a/audio-xyz.m4a");
    });
});
