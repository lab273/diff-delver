/** The `schema_migrations` table: which migrations have been applied, and when. */
import { z } from 'zod';
import { map, ok, type Result } from '#lib/core/result.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { integer, parseRows } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({ version: integer.positive() });

/** The versions of every applied migration. The table must exist. */
export function appliedMigrations(q: Queries): Result<readonly number[], StoredRowInvalid> {
	const exists = q.get(
		"SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'"
	);
	if (exists === undefined) return ok([]);
	return map(
		parseRows('schema_migrations', row, q.all('SELECT version FROM schema_migrations')),
		(rows) => rows.map((r) => r.version)
	);
}

/** Records that a migration has been applied. */
export function recordMigration(q: Queries, version: number, name: string, at: Timestamp): void {
	q.run(
		'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
		version,
		name,
		at
	);
}
