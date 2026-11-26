/**
 * The `reading_steps` and `reading_step_units` tables: each section's reading
 * order (DESIGN 4.3.1), its steps in order with the agent's note on each, and
 * the change units of each step's file it holds, as runs of units like
 * `new_units`. The only code that sees their rows; writes go through the
 * report service's `SortingWrites`, so every one is counted.
 */
import { z } from 'zod';
import { parseAgentMarkdown, type AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseSectionId, type SectionId } from '#lib/core/section-id.tiny.ts';
import type { UnitRow } from '#lib/core/storage/stored-units.ts';
import { integer, nullable, parseRow, repoPath, text } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitValues } from './unit-columns.ts';

/** One step as stored: its file, the agent's note, and the runs of units it holds. */
export interface StoredStep {
	readonly path: RepoPath;
	readonly note: AgentMarkdown | undefined;
	readonly rows: readonly UnitRow[];
}

const stepRow = z.object({
	section_id: text(parseSectionId),
	position: integer,
	path: repoPath,
	note: nullable(text(parseAgentMarkdown))
});

const unitRow = z.object({
	section_id: text(parseSectionId),
	position: integer,
	side: z.enum(['old', 'new', 'file']),
	first_line: integer,
	last_line: integer
});

function stepKey(section: SectionId, position: number): string {
	return `${section}\u0000${String(position)}`;
}

/** Every section's steps in a revision, in order. */
export function readingStepsFor(
	q: Queries,
	revision: RevisionId
): Result<ReadonlyMap<SectionId, readonly StoredStep[]>, StoredRowInvalid> {
	const steps = new Map<
		string,
		{ section: SectionId; path: RepoPath; note: AgentMarkdown | undefined; rows: UnitRow[] }
	>();
	const order: string[] = [];
	for (const raw of q.all(
		'SELECT section_id, position, path, note FROM reading_steps WHERE revision_id = ? ORDER BY section_id, position',
		revision
	)) {
		const parsed = parseRow('reading_steps', stepRow, raw);
		if (!parsed.ok) return parsed;
		const r = parsed.value;
		const key = stepKey(r.section_id, r.position);
		steps.set(key, { section: r.section_id, path: r.path, note: r.note, rows: [] });
		order.push(key);
	}
	if (order.length === 0) return ok(new Map());
	for (const raw of q.all(
		'SELECT section_id, position, side, first_line, last_line FROM reading_step_units WHERE revision_id = ? ORDER BY section_id, position, side, first_line',
		revision
	)) {
		const parsed = unitOf(raw);
		if (!parsed.ok) return parsed;
		const step = steps.get(stepKey(parsed.value.section, parsed.value.position));
		if (step !== undefined) step.rows.push({ path: step.path, units: parsed.value.units });
	}
	const bySection = new Map<SectionId, StoredStep[]>();
	for (const key of order) {
		const step = steps.get(key);
		if (step === undefined) continue;
		const list = bySection.get(step.section) ?? [];
		list.push({ path: step.path, note: step.note, rows: step.rows });
		bySection.set(step.section, list);
	}
	return ok(bySection);
}

function unitOf(
	raw: RawRow
): Result<{ section: SectionId; position: number; units: UnitRow['units'] }, StoredRowInvalid> {
	return andThen(parseRow('reading_step_units', unitRow, raw), (r) =>
		andThen(storedUnits('reading_step_units', r), (units) =>
			ok({ section: r.section_id, position: r.position, units })
		)
	);
}

/** Sets a revision's reading orders to these, replacing every step it had. */
export function replaceReadingSteps(
	q: Queries,
	revision: RevisionId,
	orders: ReadonlyMap<SectionId, readonly StoredStep[]>
): void {
	q.run('DELETE FROM reading_steps WHERE revision_id = ?', revision);
	for (const [section, steps] of orders) {
		steps.forEach((step, position) => {
			q.run(
				'INSERT INTO reading_steps (revision_id, section_id, position, path, note) VALUES (?, ?, ?, ?, ?)',
				revision,
				section,
				position,
				repoPathBytes(step.path),
				step.note ?? null
			);
			for (const row of step.rows) {
				const [, side, first, last] = unitValues(row.path, row.units);
				q.run(
					'INSERT INTO reading_step_units (revision_id, section_id, position, side, first_line, last_line) VALUES (?, ?, ?, ?, ?, ?)',
					revision,
					section,
					position,
					side,
					first,
					last
				);
			}
		});
	}
}
