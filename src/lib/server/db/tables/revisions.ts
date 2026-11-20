/** The `revisions` table: one row per revision of a report (DESIGN 6.2). The only code that sees its rows. */
import { z } from 'zod';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { parseFileCount } from '#lib/core/file-count.tiny.ts';
import { parseLineCount } from '#lib/core/line-count.tiny.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import type { Revision, UnitProgress } from '#lib/core/reports/report.ts';
import { map, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { parseRevisionId, type RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseSnapshotId, type SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { parseSourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import { parseTreeId } from '#lib/core/tree-id.tiny.ts';
import { parseUnitCount } from '#lib/core/unit-count.tiny.ts';
import { nullable, parseRow, parseRows, text, timestamp, whole } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const COLUMNS =
	'id, report_id, number, store_id, snapshot_id, base_tree, head_tree, fingerprint, base_commit, head_commit, left_out, taken_at, file_count, added_lines, deleted_lines, counted_units, reviewed_units, ignored_units, uncategorised_units';

/** What could not be included: a JSON array of sentences. */
const leftOut = z
	.string()
	.transform((value, context) => {
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed;
		} catch {
			context.addIssue({ code: 'custom', message: 'is not JSON' });
			return z.NEVER;
		}
	})
	.pipe(z.array(z.string()))
	.transform((sentences) => sentences.map(reviewerMessage));

const units = whole(parseUnitCount);

const row = z.object({
	id: text(parseRevisionId),
	report_id: text(parseReportId),
	number: whole(parseRevisionNumber),
	store_id: text(parseStoreId),
	snapshot_id: text(parseSnapshotId),
	base_tree: text(parseTreeId),
	head_tree: text(parseTreeId),
	fingerprint: text(parseSourceIdentity),
	base_commit: nullable(text(parseCommitId)),
	head_commit: nullable(text(parseCommitId)),
	left_out: leftOut,
	taken_at: timestamp,
	file_count: whole(parseFileCount),
	added_lines: whole(parseLineCount),
	deleted_lines: whole(parseLineCount),
	counted_units: units,
	reviewed_units: units,
	ignored_units: units,
	uncategorised_units: units
});

function toRevision(raw: RawRow): Result<Revision, StoredRowInvalid> {
	return map(parseRow('revisions', row, raw), (r) => ({
		id: r.id,
		report: r.report_id,
		number: r.number,
		store: r.store_id,
		snapshot: r.snapshot_id,
		baseTree: r.base_tree,
		headTree: r.head_tree,
		fingerprint: r.fingerprint,
		baseCommit: r.base_commit,
		headCommit: r.head_commit,
		leftOut: r.left_out,
		takenAt: r.taken_at,
		size: { files: r.file_count, addedLines: r.added_lines, deletedLines: r.deleted_lines },
		progress: {
			counted: r.counted_units,
			reviewed: r.reviewed_units,
			ignored: r.ignored_units,
			uncategorised: r.uncategorised_units
		}
	}));
}

/** Adds a revision. */
export function insertRevision(q: Queries, revision: Revision): void {
	q.run(
		`INSERT INTO revisions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		revision.id,
		revision.report,
		revision.number,
		revision.store,
		revision.snapshot,
		revision.baseTree,
		revision.headTree,
		revision.fingerprint,
		revision.baseCommit ?? null,
		revision.headCommit ?? null,
		JSON.stringify(revision.leftOut),
		revision.takenAt,
		revision.size.files,
		revision.size.addedLines,
		revision.size.deletedLines,
		revision.progress.counted,
		revision.progress.reviewed,
		revision.progress.ignored,
		revision.progress.uncategorised
	);
}

/** A report's newest revision, which is the one the reviewer sees; undefined when it has none. */
export function currentRevision(
	q: Queries,
	report: ReportId
): Result<Revision | undefined, StoredRowInvalid> {
	const raw = q.get(
		`SELECT ${COLUMNS} FROM revisions WHERE report_id = ? ORDER BY number DESC LIMIT 1`,
		report
	);
	return raw === undefined ? ok(undefined) : toRevision(raw);
}

/** Every report's newest revision, by report. */
export function currentRevisions(
	q: Queries
): Result<ReadonlyMap<ReportId, Revision>, StoredRowInvalid> {
	const raws = q.all(
		`SELECT ${COLUMNS} FROM revisions AS r WHERE number = (SELECT max(number) FROM revisions WHERE report_id = r.report_id)`
	);
	const byReport = new Map<ReportId, Revision>();
	for (const raw of raws) {
		const revision = toRevision(raw);
		if (!revision.ok) return revision;
		byReport.set(revision.value.report, revision.value);
	}
	return ok(byReport);
}

/** Every revision of a report, oldest first. */
export function revisionsOf(
	q: Queries,
	report: ReportId
): Result<readonly Revision[], StoredRowInvalid> {
	const revisions: Revision[] = [];
	for (const raw of q.all(
		`SELECT ${COLUMNS} FROM revisions WHERE report_id = ? ORDER BY number`,
		report
	)) {
		const revision = toRevision(raw);
		if (!revision.ok) return revision;
		revisions.push(revision.value);
	}
	return ok(revisions);
}

/** Replaces a revision's progress, after a write that changed it. */
export function setRevisionProgress(q: Queries, id: RevisionId, progress: UnitProgress): void {
	q.run(
		'UPDATE revisions SET counted_units = ?, reviewed_units = ?, ignored_units = ?, uncategorised_units = ? WHERE id = ?',
		progress.counted,
		progress.reviewed,
		progress.ignored,
		progress.uncategorised,
		id
	);
}

/** A snapshot a revision refers to. */
export interface SnapshotUse {
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
}

const use = z.object({ store_id: text(parseStoreId), snapshot_id: text(parseSnapshotId) });

/** Every snapshot some revision refers to. */
export function snapshotsInUse(q: Queries): Result<readonly SnapshotUse[], StoredRowInvalid> {
	return map(
		parseRows('revisions', use, q.all('SELECT DISTINCT store_id, snapshot_id FROM revisions')),
		(rows) => rows.map((r) => ({ store: r.store_id, snapshot: r.snapshot_id }))
	);
}
