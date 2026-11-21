/**
 * The `section_references` table: each section's cross-references (DESIGN
 * 4.3), changed units that live in another section and matter to this one, as
 * runs of units like `new_units`. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseSectionId, type SectionId } from '#lib/core/section-id.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { UnitRow } from '#lib/core/storage/stored-units.ts';
import { parseRow, text } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitColumns, unitValues } from './unit-columns.ts';

const row = z.object({ section_id: text(parseSectionId), ...unitColumns });

function toRow(raw: RawRow): Result<{ section: SectionId; row: UnitRow }, StoredRowInvalid> {
	return andThen(parseRow('section_references', row, raw), (r) =>
		andThen(storedUnits('section_references', r), (units) =>
			ok({ section: r.section_id, row: { path: r.path, units } })
		)
	);
}

/** Every cross-reference row of a revision, by section. */
export function referenceRowsFor(
	q: Queries,
	revision: RevisionId
): Result<ReadonlyMap<SectionId, readonly UnitRow[]>, StoredRowInvalid> {
	const bySection = new Map<SectionId, UnitRow[]>();
	for (const raw of q.all(
		'SELECT section_id, path, side, first_line, last_line FROM section_references WHERE revision_id = ? ORDER BY section_id, path, side, first_line',
		revision
	)) {
		const parsed = toRow(raw);
		if (!parsed.ok) return parsed;
		const list = bySection.get(parsed.value.section);
		if (list === undefined) bySection.set(parsed.value.section, [parsed.value.row]);
		else list.push(parsed.value.row);
	}
	return ok(bySection);
}

/** Sets a revision's cross-references to these, replacing every one it had. */
export function replaceReferenceRows(
	q: Queries,
	revision: RevisionId,
	rows: ReadonlyMap<SectionId, readonly UnitRow[]>
): void {
	q.run('DELETE FROM section_references WHERE revision_id = ?', revision);
	for (const [section, list] of rows) {
		for (const r of list) {
			q.run(
				'INSERT INTO section_references (revision_id, section_id, path, side, first_line, last_line) VALUES (?, ?, ?, ?, ?, ?)',
				revision,
				section,
				...unitValues(r.path, r.units)
			);
		}
	}
}
