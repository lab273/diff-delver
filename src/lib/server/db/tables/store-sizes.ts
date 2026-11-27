/**
 * The `store_sizes` table: each store's size on disk when its Delves were
 * last measured, with the repository it was made for (DESIGN 9.1), so the
 * Storage page reads no store. A row that cannot be read is left out, as if
 * the store had not been measured. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import { parseRepositoryName, type RepositoryName } from '#lib/core/repository-name.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { nullable, parseRow, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';

const row = z.object({
	store_id: text(parseStoreId),
	repository: nullable(text(parseRepositoryName)),
	on_disk_bytes: whole(parseByteSize),
	measured_at: timestamp
});

/** A store's size on disk, as last measured. */
export interface StoredStoreSize {
	readonly store: StoreId;
	readonly repository: RepositoryName | undefined;
	readonly onDisk: ByteSize;
	readonly measuredAt: Timestamp;
}

/** Every store's size, as last measured. */
export function everyStoreSize(q: Queries): readonly StoredStoreSize[] {
	return q
		.all('SELECT store_id, repository, on_disk_bytes, measured_at FROM store_sizes')
		.flatMap((raw) => {
			const parsed = parseRow('store_sizes', row, raw);
			if (!parsed.ok) return [];
			const { store_id, repository, on_disk_bytes, measured_at } = parsed.value;
			return [{ store: store_id, repository, onDisk: on_disk_bytes, measuredAt: measured_at }];
		});
}

/** Records the store's size as measured now, or, with none, that it is gone. */
export function recordStoreSize(
	q: Queries,
	store: StoreId,
	size: Omit<StoredStoreSize, 'store'> | undefined
): void {
	q.run('DELETE FROM store_sizes WHERE store_id = ?', store);
	if (size === undefined) return;
	q.run(
		'INSERT INTO store_sizes (store_id, repository, on_disk_bytes, measured_at) VALUES (?, ?, ?, ?)',
		store,
		size.repository ?? null,
		size.onDisk,
		size.measuredAt
	);
}
