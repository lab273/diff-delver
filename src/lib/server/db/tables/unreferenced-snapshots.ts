/**
 * The `unreferenced_snapshots` table: snapshots in a store that no revision
 * refers to, with when that was first noticed. A snapshot is taken before its
 * revision is recorded, so a crash in between leaves one behind; it is removed
 * once it has gone unreferenced for longer than the store's grace period. The
 * only code that sees its rows.
 */
import { z } from 'zod';
import { map, type Result } from '#lib/core/result.ts';
import { parseSnapshotId, type SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRows, text, timestamp } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

export interface Sighting {
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
	readonly firstSeenAt: Timestamp;
}

const row = z.object({
	store_id: text(parseStoreId),
	snapshot_id: text(parseSnapshotId),
	first_seen_at: timestamp
});

/** Every unreferenced snapshot noticed so far in a store. */
export function sightingsIn(
	q: Queries,
	store: StoreId
): Result<readonly Sighting[], StoredRowInvalid> {
	return map(
		parseRows(
			'unreferenced_snapshots',
			row,
			q.all(
				'SELECT store_id, snapshot_id, first_seen_at FROM unreferenced_snapshots WHERE store_id = ?',
				store
			)
		),
		(rows) =>
			rows.map((r) => ({
				store: r.store_id,
				snapshot: r.snapshot_id,
				firstSeenAt: r.first_seen_at
			}))
	);
}

/** Notes an unreferenced snapshot at `at`, unless it was noticed before. */
export function noticeSnapshot(
	q: Queries,
	store: StoreId,
	snapshot: SnapshotId,
	at: Timestamp
): void {
	q.run(
		'INSERT INTO unreferenced_snapshots (store_id, snapshot_id, first_seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
		store,
		snapshot,
		at
	);
}

/** Forgets a snapshot: it was removed, or a revision refers to it after all. */
export function forgetSnapshot(q: Queries, store: StoreId, snapshot: SnapshotId): void {
	q.run(
		'DELETE FROM unreferenced_snapshots WHERE store_id = ? AND snapshot_id = ?',
		store,
		snapshot
	);
}
