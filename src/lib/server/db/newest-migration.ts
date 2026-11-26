/**
 * Which migrations a database already has, read without changing it, so a copy
 * of diff delver can tell, before it replaces a running daemon, whether it
 * could serve the data folder at all (`ensureDaemon`).
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { SchemaVersion } from '#lib/core/schema-version.tiny.ts';
import { Database } from './database.ts';
import type { DatabaseError } from './database-error.ts';
import { inspect, newestOf } from './migrations.ts';

/**
 * The newest migration the database in the data directory has: none when it
 * has none yet, and an error when there is no database, it cannot be read, or
 * it is not diff delver's.
 */
export function newestMigrationIn(
	dataDirectory: AbsolutePath
): Result<SchemaVersion | undefined, DatabaseError> {
	const opened = Database.openToRead(dataDirectory);
	if (!opened.ok) return opened;
	const database = opened.value;
	try {
		const applied = database.read((q) => inspect(q, database.file));
		if (!applied.ok) return applied;
		return ok(applied.value.length === 0 ? undefined : newestOf(applied.value));
	} finally {
		database.close();
	}
}
