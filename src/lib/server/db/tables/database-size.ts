/**
 * The `database_size` table: the database's own size on disk when the stores
 * were last measured (DESIGN 9.1), one row. A row that cannot be read is
 * taken as not measured. The only code that sees its row.
 */
import { z } from 'zod';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRow, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';

const row = z.object({ on_disk_bytes: whole(parseByteSize), measured_at: timestamp });

/** The database's size on disk, as last measured. */
export interface StoredDatabaseSize {
	readonly onDisk: ByteSize;
	readonly measuredAt: Timestamp;
}

/** The database's size as last measured, or undefined while it has not been. */
export function databaseSizeOf(q: Queries): StoredDatabaseSize | undefined {
	const raw = q.get('SELECT on_disk_bytes, measured_at FROM database_size WHERE id = 1');
	if (raw === undefined) return undefined;
	const parsed = parseRow('database_size', row, raw);
	return parsed.ok
		? { onDisk: parsed.value.on_disk_bytes, measuredAt: parsed.value.measured_at }
		: undefined;
}

/** Records the database's size as measured now. */
export function recordDatabaseSize(q: Queries, size: StoredDatabaseSize): void {
	q.run(
		`INSERT INTO database_size (id, on_disk_bytes, measured_at) VALUES (1, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET on_disk_bytes = excluded.on_disk_bytes, measured_at = excluded.measured_at`,
		size.onDisk,
		size.measuredAt
	);
}
