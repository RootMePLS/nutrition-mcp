// ============================================================================
// BACKUP / DELETE POLICY CONTRACTS
// ============================================================================
// Retention rules and permanent-delete orchestration contracts ONLY.
// This slice schedules no backup jobs, uploads no snapshots and automates no
// restores. Backup deletion is an injected adapter: if an adapter cannot
// confirm removal, permanent delete returns a partial/failed receipt and
// never claims success.
//
// Retention contract (user decision): DB and media backups are SEPARATE;
// daily retention is exactly 30 days; monthly snapshots are kept forever.

import type { BackupKind, RetentionClass } from "./meal-types.js";

export const DAILY_RETENTION_DAYS = 30;

export interface KindRetentionPolicy {
    kind: BackupKind;
    daily_retention_days: number;
    monthly_retention_days: null; // forever
}

// Independent policies per backup kind — DB and media backups are run and
// retained separately.
export function retentionPolicy(): Record<BackupKind, KindRetentionPolicy> {
    return {
        postgres: {
            kind: "postgres",
            daily_retention_days: DAILY_RETENTION_DAYS,
            monthly_retention_days: null,
        },
        media: {
            kind: "media",
            daily_retention_days: DAILY_RETENTION_DAYS,
            monthly_retention_days: null,
        },
    };
}

// Expiry instant for a snapshot, or null when the retention class never
// expires (monthly = forever).
export function retentionExpiresAt(
    retentionClass: RetentionClass,
    createdAt: Date,
): Date | null {
    if (retentionClass === "monthly") return null;
    return new Date(
        createdAt.getTime() + DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
}

// ---------------------------------------------------------------------------
// PERMANENT DELETE ORCHESTRATION
// ---------------------------------------------------------------------------

export interface BackupManifestRef {
    kind: BackupKind;
    snapshot_key: string;
}

export interface BackupDeletionResult {
    confirmed: boolean;
    detail?: string;
}

export interface PermanentDeleteReceipt {
    status: "refused" | "completed" | "partial" | "failed";
    live_deleted: boolean;
    media_deleted: { key: string; deleted: boolean; detail?: string }[];
    backup_results: (BackupManifestRef & BackupDeletionResult)[];
}

// Orchestrates permanent delete against injected effects so the contract is
// testable without real storage providers. Requires an explicit confirmation
// token; anything else refuses before touching any state.
export async function permanentDeleteMealEvent(args: {
    confirmation_token: string | undefined;
    expected_confirmation_token: string;
    deleteLiveRows: () => Promise<{ event_deleted: boolean }>;
    media_keys: string[];
    deleteMedia: (key: string) => Promise<void>;
    manifests: BackupManifestRef[];
    deleteBackup: (
        kind: BackupKind,
        snapshotKey: string,
    ) => Promise<BackupDeletionResult>;
}): Promise<PermanentDeleteReceipt> {
    const refused: PermanentDeleteReceipt = {
        status: "refused",
        live_deleted: false,
        media_deleted: [],
        backup_results: [],
    };
    if (
        args.confirmation_token === undefined ||
        args.confirmation_token !== args.expected_confirmation_token
    ) {
        return refused;
    }

    // Live rows first; if the live delete itself fails, the receipt is a
    // failure and no backup deletion is claimed.
    let liveDeleted = false;
    try {
        const live = await args.deleteLiveRows();
        liveDeleted = live.event_deleted;
    } catch (err) {
        return {
            status: "failed",
            live_deleted: false,
            media_deleted: [],
            backup_results: [],
        };
    }

    const mediaDeleted: PermanentDeleteReceipt["media_deleted"] = [];
    for (const key of args.media_keys) {
        try {
            await args.deleteMedia(key);
            mediaDeleted.push({ key, deleted: true });
        } catch (err) {
            mediaDeleted.push({
                key,
                deleted: false,
                detail: (err as Error).message,
            });
        }
    }

    const backupResults: PermanentDeleteReceipt["backup_results"] = [];
    for (const manifest of args.manifests) {
        try {
            const result = await args.deleteBackup(
                manifest.kind,
                manifest.snapshot_key,
            );
            backupResults.push({ ...manifest, ...result });
        } catch (err) {
            backupResults.push({
                ...manifest,
                confirmed: false,
                detail: (err as Error).message,
            });
        }
    }

    const allConfirmed =
        liveDeleted &&
        mediaDeleted.every((m) => m.deleted) &&
        backupResults.every((r) => r.confirmed);

    return {
        status: allConfirmed ? "completed" : "partial",
        live_deleted: liveDeleted,
        media_deleted: mediaDeleted,
        backup_results: backupResults,
    };
}
