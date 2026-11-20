/**
 * The `revisions_to_check` table: the revisions written before a file with
 * lines could also have a file-level unit, whose rows and stored progress the
 * report service still has to bring up to date (migration 4). Nothing adds to
 * it. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { parseRevisionId, type RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRow, text } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({ report_id: text(parseReportId), revision_id: text(parseRevisionId) });

/** A revision still to check, with its report. */
export interface RevisionToCheck {
	readonly report: ReportId;
	readonly revision: RevisionId;
}

/** Every revision still to check. */
export function revisionsToCheck(q: Queries): Result<readonly RevisionToCheck[], StoredRowInvalid> {
	const found: RevisionToCheck[] = [];
	for (const raw of q.all(
		'SELECT v.report_id, c.revision_id FROM revisions_to_check AS c JOIN revisions AS v ON v.id = c.revision_id ORDER BY v.report_id, v.number'
	)) {
		const parsed = parseRow('revisions_to_check', row, raw);
		if (!parsed.ok) return parsed;
		found.push({ report: parsed.value.report_id, revision: parsed.value.revision_id });
	}
	return ok(found);
}

/** Whether a revision is still to check. */
export function isToCheck(q: Queries, revision: RevisionId): boolean {
	return q.get('SELECT 1 FROM revisions_to_check WHERE revision_id = ?', revision) !== undefined;
}

/** Records that a revision has been checked. */
export function checkedRevision(q: Queries, revision: RevisionId): void {
	q.run('DELETE FROM revisions_to_check WHERE revision_id = ?', revision);
}
