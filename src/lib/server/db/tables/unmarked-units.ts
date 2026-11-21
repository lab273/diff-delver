/**
 * The `unmarked_units` table: the units of a revision whose reviewed mark the
 * update that made it took off, because something close to them changed
 * (DESIGN 6.2 step 3), as runs of units like `new_units`. The page says why
 * those changes are to be read again. The only code that sees its rows.
 */
import { z } from 'zod';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { UnitRow } from '#lib/core/storage/stored-units.ts';
import { parseRow } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitColumns, unitValues } from './unit-columns.ts';

const row = z.object(unitColumns);

function toUnitRow(raw: RawRow): Result<UnitRow, StoredRowInvalid> {
	return andThen(parseRow('unmarked_units', row, raw), (r) =>
		andThen(storedUnits('unmarked_units', r), (units) => ok({ path: r.path, units }))
	);
}

/** Every row of a revision's unmarked units, or only of the file at `path`. */
export function unmarkedUnitRowsFor(
	q: Queries,
	revision: RevisionId,
	path?: RepoPath
): Result<readonly UnitRow[], StoredRowInvalid> {
	const rows: UnitRow[] = [];
	for (const raw of q.all(
		'SELECT path, side, first_line, last_line FROM unmarked_units WHERE revision_id = ?' +
			(path === undefined ? '' : ' AND path = ?'),
		revision,
		...(path === undefined ? [] : [repoPathBytes(path)])
	)) {
		const parsed = toUnitRow(raw);
		if (!parsed.ok) return parsed;
		rows.push(parsed.value);
	}
	return ok(rows);
}

/** Records the unmarked units of a revision, which has none yet. */
export function insertUnmarkedUnitRows(
	q: Queries,
	revision: RevisionId,
	rows: readonly UnitRow[]
): void {
	for (const r of rows) {
		q.run(
			'INSERT INTO unmarked_units (revision_id, path, side, first_line, last_line) VALUES (?, ?, ?, ?, ?)',
			revision,
			...unitValues(r.path, r.units)
		);
	}
}
