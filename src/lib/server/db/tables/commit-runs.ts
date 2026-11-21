/**
 * The `commit_runs` table: for a report whose source is a run of commits, how
 * many commits it is and the subjects of its oldest and newest, read from the
 * repository once, when the report was opened (`core/history/commit-run.ts`).
 * The report's title is made from them. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseCommitCount } from '#lib/core/history/commit-count.tiny.ts';
import type { CommitRun } from '#lib/core/history/commit-run.ts';
import { parseRunSubject } from '#lib/core/history/run-subject.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { parseRows, text, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({
	// A run is at least one commit; the count's own type allows none.
	commits: whole(parseCommitCount).refine((n) => n >= 1, 'a run has at least one commit'),
	oldest_subject: text(parseRunSubject),
	newest_subject: text(parseRunSubject)
});

/** What is kept of a report's run of commits; undefined when the report has none. */
export function commitRunOf(
	q: Queries,
	report: ReportId
): Result<CommitRun | undefined, StoredRowInvalid> {
	const rows = parseRows(
		'commit_runs',
		row,
		q.all(
			'SELECT commits, oldest_subject, newest_subject FROM commit_runs WHERE report_id = ?',
			report
		)
	);
	if (!rows.ok) return rows;
	const found = rows.value[0];
	return ok(
		found === undefined
			? undefined
			: { commits: found.commits, oldest: found.oldest_subject, newest: found.newest_subject }
	);
}

/** Keeps a report's run of commits. A report has at most one, written with the report. */
export function insertCommitRun(q: Queries, report: ReportId, run: CommitRun): void {
	q.run(
		'INSERT INTO commit_runs (report_id, commits, oldest_subject, newest_subject) VALUES (?, ?, ?, ?)',
		report,
		run.commits,
		run.oldest,
		run.newest
	);
}
