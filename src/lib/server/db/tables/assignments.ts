/**
 * The `assignments` table: the bucket and role of every change unit of a
 * revision, as runs of units (`storage/stored-units.ts` turns a state into these
 * rows and back). The only code that sees its rows.
 */
import { z } from 'zod';
import type { IgnoredBy, Bucket } from '#lib/core/diff/bucket.ts';
import { parseIgnoreRuleId } from '#lib/core/diff/path-rules.ts';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { parseGlobPattern } from '#lib/core/glob-pattern.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { andThen, err, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRole } from '#lib/core/role.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import type { AssignmentRow } from '#lib/core/storage/stored-units.ts';
import { nullable, parseRow, text } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitColumns, unitValues } from './unit-columns.ts';

const row = z.object({
	...unitColumns,
	bucket: z.enum(['section', 'ignored', 'uncategorised']),
	section_id: nullable(text(parseSectionId)),
	ignored_by: nullable(z.enum(['rule', 'pattern', 'agent'])),
	ignored_detail: nullable(z.string()),
	role: text(parseRole)
});

type Row = z.infer<typeof row>;

function invalid(detail: string): Result<never, StoredRowInvalid> {
	return err({ kind: 'StoredRowInvalid', table: 'assignments', detail });
}

function ignoredBy(
	kind: 'rule' | 'pattern' | 'agent',
	detail: string
): Result<IgnoredBy, StoredRowInvalid> {
	switch (kind) {
		case 'rule': {
			const rule = parseIgnoreRuleId(detail);
			return rule.ok ? ok({ kind: 'rule', rule: rule.value }) : invalid(`unknown rule ${detail}`);
		}
		case 'pattern': {
			const pattern = parseGlobPattern(detail);
			return pattern.ok
				? ok({ kind: 'pattern', pattern: pattern.value })
				: invalid('a bad pattern');
		}
		case 'agent': {
			const reason = parseAgentMarkdown(detail);
			return reason.ok ? ok({ kind: 'agent', reason: reason.value }) : invalid('a bad reason');
		}
	}
}

function bucketOf(r: Row): Result<Bucket, StoredRowInvalid> {
	switch (r.bucket) {
		case 'section':
			return r.section_id === undefined || r.ignored_by !== undefined
				? invalid('a section bucket without its section')
				: ok({ kind: 'section', section: r.section_id });
		case 'ignored':
			if (
				r.ignored_by === undefined ||
				r.ignored_detail === undefined ||
				r.section_id !== undefined
			) {
				return invalid('an ignored bucket without who ignored it');
			}
			return andThen(ignoredBy(r.ignored_by, r.ignored_detail), (by) =>
				ok({ kind: 'ignored', by })
			);
		case 'uncategorised':
			return r.section_id === undefined && r.ignored_by === undefined
				? ok({ kind: 'uncategorised' })
				: invalid('an uncategorised bucket with a section or a reason');
	}
}

function toAssignmentRow(raw: RawRow): Result<AssignmentRow, StoredRowInvalid> {
	return andThen(parseRow('assignments', row, raw), (r) =>
		andThen(storedUnits('assignments', r), (units) =>
			andThen(bucketOf(r), (bucket) =>
				ok({ path: r.path, units, assignment: { bucket, role: r.role } })
			)
		)
	);
}

function bucketValues(
	bucket: Bucket
): readonly [string, string | null, string | null, string | null] {
	switch (bucket.kind) {
		case 'section':
			return ['section', bucket.section, null, null];
		case 'uncategorised':
			return ['uncategorised', null, null, null];
		case 'ignored':
			switch (bucket.by.kind) {
				case 'rule':
					return ['ignored', null, 'rule', bucket.by.rule];
				case 'pattern':
					return ['ignored', null, 'pattern', bucket.by.pattern];
				case 'agent':
					return ['ignored', null, 'agent', bucket.by.reason];
			}
	}
}

/** Every assignment row of a revision. */
export function assignmentRowsFor(
	q: Queries,
	revision: RevisionId
): Result<readonly AssignmentRow[], StoredRowInvalid> {
	const rows: AssignmentRow[] = [];
	for (const raw of q.all(
		'SELECT path, side, first_line, last_line, bucket, section_id, ignored_by, ignored_detail, role FROM assignments WHERE revision_id = ?',
		revision
	)) {
		const parsed = toAssignmentRow(raw);
		if (!parsed.ok) return parsed;
		rows.push(parsed.value);
	}
	return ok(rows);
}

/**
 * Replaces the rows of the given files of a revision, or of all its files, with
 * `rows`, which must belong to those files.
 */
export function replaceAssignmentRows(
	q: Queries,
	revision: RevisionId,
	files: ReadonlySet<RepoPath> | 'all',
	rows: readonly AssignmentRow[]
): void {
	if (files === 'all') q.run('DELETE FROM assignments WHERE revision_id = ?', revision);
	else {
		for (const path of files) {
			q.run(
				'DELETE FROM assignments WHERE revision_id = ? AND path = ?',
				revision,
				repoPathBytes(path)
			);
		}
	}
	for (const r of rows) {
		q.run(
			'INSERT INTO assignments (revision_id, path, side, first_line, last_line, bucket, section_id, ignored_by, ignored_detail, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			revision,
			...unitValues(r.path, r.units),
			...bucketValues(r.assignment.bucket),
			r.assignment.role
		);
	}
}
