/**
 * The `pull_requests` table: for a report of a GitHub pull request, its title
 * and description as GitHub gave them when the report was opened or last
 * brought up to date. The report's title is made from the title; the
 * description is given to an agent. The only code that sees its rows.
 */
import { z } from 'zod';
import {
	parsePullRequestDescription,
	type PullRequestDescription
} from '#lib/core/github/pull-request-description.tiny.ts';
import {
	parsePullRequestTitle,
	type PullRequestTitle
} from '#lib/core/github/pull-request-title.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { nullable, parseRows, text } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

/** What a report of a pull request keeps of it. */
export interface PullRequestText {
	readonly title: PullRequestTitle;
	readonly description: PullRequestDescription | undefined;
}

const row = z.object({
	title: text(parsePullRequestTitle),
	description: nullable(text(parsePullRequestDescription))
});

/** What is kept of a report's pull request; an error when the report has none, which only a damaged file lacks. */
export function pullRequestTextOf(
	q: Queries,
	report: ReportId
): Result<PullRequestText, StoredRowInvalid> {
	const rows = parseRows(
		'pull_requests',
		row,
		q.all('SELECT title, description FROM pull_requests WHERE report_id = ?', report)
	);
	if (!rows.ok) return rows;
	const found = rows.value[0];
	if (found === undefined) {
		return err({
			kind: 'StoredRowInvalid',
			table: 'pull_requests',
			detail: 'a report of a pull request has no row'
		});
	}
	return ok({ title: found.title, description: found.description });
}

/** Keeps a report's pull request's title and description, replacing what was kept. */
export function writePullRequestText(q: Queries, report: ReportId, kept: PullRequestText): void {
	q.run(
		'INSERT INTO pull_requests (report_id, title, description) VALUES (?, ?, ?) ON CONFLICT (report_id) DO UPDATE SET title = excluded.title, description = excluded.description',
		report,
		kept.title,
		kept.description ?? null
	);
}
