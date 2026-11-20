/**
 * The `new_units` table: the units of a revision that the revision before it
 * did not have (DESIGN 6.2), as runs of units (`storage/stored-units.ts` turns
 * a set of units into these rows and back). The only code that sees its rows.
 */
import { z } from 'zod';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { UnitRow } from '#lib/core/storage/stored-units.ts';
import { parseRow } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitColumns, unitValues } from './unit-columns.ts';

const row = z.object(unitColumns);

function toUnitRow(raw: RawRow): Result<UnitRow, StoredRowInvalid> {
	return andThen(parseRow('new_units', row, raw), (r) =>
		andThen(storedUnits('new_units', r), (units) => ok({ path: r.path, units }))
	);
}

/** Every row of a revision's new units. */
export function newUnitRowsFor(
	q: Queries,
	revision: RevisionId
): Result<readonly UnitRow[], StoredRowInvalid> {
	const rows: UnitRow[] = [];
	for (const raw of q.all(
		'SELECT path, side, first_line, last_line FROM new_units WHERE revision_id = ?',
		revision
	)) {
		const parsed = toUnitRow(raw);
		if (!parsed.ok) return parsed;
		rows.push(parsed.value);
	}
	return ok(rows);
}

/** Records the new units of a revision, which has none yet. */
export function insertNewUnitRows(
	q: Queries,
	revision: RevisionId,
	rows: readonly UnitRow[]
): void {
	for (const r of rows) {
		q.run(
			'INSERT INTO new_units (revision_id, path, side, first_line, last_line) VALUES (?, ?, ?, ?, ?)',
			revision,
			...unitValues(r.path, r.units)
		);
	}
}
