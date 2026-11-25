/**
 * The `reports` table: one row per report (DESIGN 6.1). The only code that
 * sees its rows. A report of a run of commits has what its title is made of
 * in `commit_runs`, and a report of a pull request its title and description
 * in `pull_requests`, which their own modules read and write; a report is
 * given back with them, and stored with them.
 */
import { z } from 'zod';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { parseReportIdentity, type ReportIdentity } from '#lib/core/report-identity.tiny.ts';
import type { Report, ReportSource, ReportState } from '#lib/core/reports/report.ts';
import { parsePullRequestUrl, pullRequestUrl } from '#lib/core/github/pull-request.ts';
import { parseRepositoryName } from '#lib/core/repository-name.tiny.ts';
import { andThen, err, map, ok, type Result } from '#lib/core/result.ts';
import { formatGitSourceSpec, parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { parseStoreId } from '#lib/core/store-id.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { nullable, parseRow, parseRows, text, timestamp } from '../columns.ts';
import { commitRunOf, insertCommitRun } from './commit-runs.ts';
import { pullRequestTextOf, writePullRequestText } from './pull-requests.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const COLUMNS =
	'id, identity, source_kind, source, store_id, repository_name, repository_path, state, closed_reason, created_at, last_activity_at';

const row = z.object({
	id: text(parseReportId),
	identity: text(parseReportIdentity),
	source_kind: z.enum(['git', 'github']),
	source: z.string(),
	store_id: text(parseStoreId),
	repository_name: text(parseRepositoryName),
	repository_path: text(parseAbsolutePath),
	state: z.enum(['open', 'closed']),
	closed_reason: nullable(z.enum(['reviewer', 'source-empty', 'snapshot-gone'])),
	created_at: timestamp,
	last_activity_at: timestamp
});

function toReport(q: Queries, raw: RawRow): Result<Report, StoredRowInvalid> {
	return andThen(parseRow('reports', row, raw), (r) => {
		const state: ReportState | undefined =
			r.state === 'open'
				? r.closed_reason === undefined
					? { kind: 'open' }
					: undefined
				: r.closed_reason === undefined
					? undefined
					: { kind: 'closed', reason: r.closed_reason };
		if (state === undefined) {
			return err({
				kind: 'StoredRowInvalid',
				table: 'reports',
				detail: 'state and closed_reason disagree'
			});
		}
		return map(sourceOf(q, r.id, r.source_kind, r.source), (source) => ({
			id: r.id,
			identity: r.identity,
			source,
			store: r.store_id,
			repositoryName: r.repository_name,
			repositoryPath: r.repository_path,
			state,
			createdAt: r.created_at,
			lastActivityAt: r.last_activity_at
		}));
	});
}

/** A report's source from its row and the rows that belong to it. */
function sourceOf(
	q: Queries,
	id: ReportId,
	kind: 'git' | 'github',
	written: string
): Result<ReportSource, StoredRowInvalid> {
	const invalid = (): Result<ReportSource, StoredRowInvalid> =>
		err({ kind: 'StoredRowInvalid', table: 'reports', detail: 'its source cannot be read' });
	switch (kind) {
		case 'git': {
			const spec = parseGitSourceSpec(written);
			if (!spec.ok) return invalid();
			return map(commitRunOf(q, id), (run) => ({ kind: 'git', spec: spec.value, run }));
		}
		case 'github': {
			const pull = parsePullRequestUrl(written);
			if (!pull.ok) return invalid();
			return map(pullRequestTextOf(q, id), (kept) => ({
				kind: 'github',
				pullRequest: pull.value,
				title: kept.title,
				description: kept.description
			}));
		}
	}
}

/** A report's source in its one written form, for its row. */
function sourceColumn(source: ReportSource): string {
	return source.kind === 'git'
		? formatGitSourceSpec(source.spec)
		: pullRequestUrl(source.pullRequest);
}

function stateColumns(state: ReportState): readonly [string, string | null] {
	switch (state.kind) {
		case 'open':
			return ['open', null];
		case 'closed':
			return ['closed', state.reason];
	}
}

/** Adds a report, with its run of commits when it has one. */
export function insertReport(q: Queries, report: Report): void {
	q.run(
		`INSERT INTO reports (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		report.id,
		report.identity,
		report.source.kind,
		sourceColumn(report.source),
		report.store,
		report.repositoryName,
		report.repositoryPath,
		...stateColumns(report.state),
		report.createdAt,
		report.lastActivityAt
	);
	const { source } = report;
	if (source.kind === 'git' && source.run !== undefined) insertCommitRun(q, report.id, source.run);
	if (source.kind === 'github') {
		writePullRequestText(q, report.id, { title: source.title, description: source.description });
	}
}

/** The report with this id, if there is one. */
export function reportById(q: Queries, id: ReportId): Result<Report | undefined, StoredRowInvalid> {
	const raw = q.get(`SELECT ${COLUMNS} FROM reports WHERE id = ?`, id);
	return raw === undefined ? ok(undefined) : toReport(q, raw);
}

/** The open report for a source, if there is one; there is never more than one. */
export function openReportFor(
	q: Queries,
	identity: ReportIdentity
): Result<Report | undefined, StoredRowInvalid> {
	const raw = q.get(
		`SELECT ${COLUMNS} FROM reports WHERE identity = ? AND state = 'open'`,
		identity
	);
	return raw === undefined ? ok(undefined) : toReport(q, raw);
}

/** A report row that could not be read: its id, when that much can be read, and why. */
export interface UnreadableReport {
	readonly id: ReportId | undefined;
	readonly error: StoredRowInvalid;
}

const idOnly = z.object({ id: text(parseReportId) });

/**
 * Every report, most recently active first, each read on its own: a row that
 * cannot be read is an error in its place, so the others can still be listed.
 */
export function everyReport(q: Queries): readonly Result<Report, UnreadableReport>[] {
	return q
		.all(`SELECT ${COLUMNS} FROM reports ORDER BY last_activity_at DESC, created_at DESC, id`)
		.map((raw) => {
			const report = toReport(q, raw);
			if (report.ok) return report;
			const id = parseRow('reports', idOnly, raw);
			return err({ id: id.ok ? id.value.id : undefined, error: report.error });
		});
}

/** Whether there is a report with this id, whether or not its row can be read. */
export function reportExists(q: Queries, id: ReportId): boolean {
	return q.get('SELECT 1 AS found FROM reports WHERE id = ?', id) !== undefined;
}

/** Sets a report's state, and its last activity to `at`. Says whether the report exists. */
export function setReportState(
	q: Queries,
	id: ReportId,
	state: ReportState,
	at: Timestamp
): boolean {
	return (
		q.run(
			'UPDATE reports SET state = ?, closed_reason = ?, last_activity_at = ? WHERE id = ?',
			...stateColumns(state),
			at,
			id
		) > 0
	);
}

/**
 * Moves a report to another folder of its repository: a pull request's Delve
 * opened from a second clone once the first is gone. Its store stays its own.
 */
export function setReportRepository(
	q: Queries,
	id: ReportId,
	repository: { readonly name: Report['repositoryName']; readonly path: Report['repositoryPath'] }
): void {
	q.run(
		'UPDATE reports SET repository_name = ?, repository_path = ? WHERE id = ?',
		repository.name,
		repository.path,
		id
	);
}

/** Records activity on a report at `at`. */
export function touchReport(q: Queries, id: ReportId, at: Timestamp): void {
	q.run('UPDATE reports SET last_activity_at = max(last_activity_at, ?) WHERE id = ?', at, id);
}

/** Deletes a report and, through the schema's cascades, everything that belongs to it. */
export function deleteReportRow(q: Queries, id: ReportId): boolean {
	return q.run('DELETE FROM reports WHERE id = ?', id) > 0;
}

/** How many reports there are, for tests and the Storage page. */
export function countReports(q: Queries): Result<number, StoredRowInvalid> {
	return map(
		parseRows(
			'reports',
			z.object({ n: z.number().int() }),
			q.all('SELECT count(*) AS n FROM reports')
		),
		(rows) => rows[0]?.n ?? 0
	);
}
