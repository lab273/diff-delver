/** The `revisions` table: one row per revision of a report (DESIGN 6.2). The only code that sees its rows. */
import { z } from 'zod';
import { parseByteSize } from '#lib/core/byte-size.tiny.ts';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { parseFileCount } from '#lib/core/file-count.tiny.ts';
import { parseLineCount } from '#lib/core/line-count.tiny.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import type { BinaryFiles, DiffSize } from '#lib/core/reports/diff-size.ts';
import type { Revision, UnitProgress } from '#lib/core/reports/report.ts';
import { map, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { parseRevisionId, type RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseSnapshotId, type SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { parseSourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import { parseTreeId } from '#lib/core/tree-id.tiny.ts';
import { parseUnitCount } from '#lib/core/unit-count.tiny.ts';
import { nullable, parseRow, parseRows, text, timestamp, whole } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const COLUMNS =
	'id, report_id, number, store_id, snapshot_id, base_tree, head_tree, fingerprint, base_commit, head_commit, left_out, taken_at, file_count, added_lines, deleted_lines, test_added_lines, test_deleted_lines, binary_added_files, binary_added_bytes, binary_removed_files, binary_removed_bytes, binary_changed_files, binary_changed_before, binary_changed_after, counted_units, reviewed_units, ignored_units, uncategorised_units';

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
const files = nullable(whole(parseFileCount));
const bytes = nullable(whole(parseByteSize));

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
	test_added_lines: whole(parseLineCount),
	test_deleted_lines: whole(parseLineCount),
	binary_added_files: files,
	binary_added_bytes: bytes,
	binary_removed_files: files,
	binary_removed_bytes: bytes,
	binary_changed_files: files,
	binary_changed_before: bytes,
	binary_changed_after: bytes,
	counted_units: units,
	reviewed_units: units,
	ignored_units: units,
	uncategorised_units: units
});

/** The binary files as stored, or undefined while they have not been counted. */
function binaryOf(r: z.output<typeof row>): BinaryFiles | undefined {
	const {
		binary_added_files: added,
		binary_added_bytes: addedBytes,
		binary_removed_files: removed,
		binary_removed_bytes: removedBytes,
		binary_changed_files: changed,
		binary_changed_before: before,
		binary_changed_after: after
	} = r;
	if (
		added === undefined ||
		addedBytes === undefined ||
		removed === undefined ||
		removedBytes === undefined ||
		changed === undefined ||
		before === undefined ||
		after === undefined
	) {
		return undefined;
	}
	return {
		added: { files: added, bytes: addedBytes },
		removed: { files: removed, bytes: removedBytes },
		changed: { files: changed, before, after }
	};
}

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
		size: {
			files: r.file_count,
			addedLines: r.added_lines,
			deletedLines: r.deleted_lines,
			testLines: { added: r.test_added_lines, removed: r.test_deleted_lines }
		},
		binary: binaryOf(r),
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
		`INSERT INTO revisions (${COLUMNS}) VALUES (${COLUMNS.split(',')
			.map(() => '?')
			.join(', ')})`,
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
		revision.size.testLines.added,
		revision.size.testLines.removed,
		...binaryColumns(revision.binary),
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

/** One pinned revision without reading the report's history. */
export function revisionAt(
	q: Queries,
	report: ReportId,
	number: RevisionNumber
): Result<Revision | undefined, StoredRowInvalid> {
	const raw = q.get(
		`SELECT ${COLUMNS} FROM revisions WHERE report_id = ? AND number = ?`,
		report,
		number
	);
	return raw === undefined ? ok(undefined) : toRevision(raw);
}

const reportOnly = z.object({ report_id: text(parseReportId) });

/**
 * Every report's newest revision, by report, each read on its own: a row that
 * cannot be read is an error under its report, so the others can still be
 * listed. A row whose report id cannot be read is left out, and its report
 * then has no revision here.
 */
export function currentRevisions(
	q: Queries
): ReadonlyMap<ReportId, Result<Revision, StoredRowInvalid>> {
	const raws = q.all(
		`SELECT ${COLUMNS} FROM revisions AS r WHERE number = (SELECT max(number) FROM revisions WHERE report_id = r.report_id)`
	);
	const byReport = new Map<ReportId, Result<Revision, StoredRowInvalid>>();
	for (const raw of raws) {
		const report = parseRow('revisions', reportOnly, raw);
		if (report.ok) byReport.set(report.value.report_id, toRevision(raw));
	}
	return byReport;
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

const uncounted = z.object({ report_id: text(parseReportId), id: text(parseRevisionId) });

/** A revision whose binary files an earlier diff delver did not count, with its report. */
export interface UncountedRevision {
	readonly report: ReportId;
	readonly revision: RevisionId;
}

/**
 * The revisions whose binary files have not been counted yet, each report's
 * newest first, since those are the ones the list shows, then the rest.
 */
export function revisionsWithoutBinary(
	q: Queries
): Result<readonly UncountedRevision[], StoredRowInvalid> {
	const found: UncountedRevision[] = [];
	for (const raw of q.all(
		`SELECT report_id, id FROM revisions AS r WHERE binary_added_files IS NULL
		ORDER BY number = (SELECT max(number) FROM revisions WHERE report_id = r.report_id) DESC, report_id, number DESC`
	)) {
		const parsed = parseRow('revisions', uncounted, raw);
		if (!parsed.ok) return parsed;
		found.push({ report: parsed.value.report_id, revision: parsed.value.id });
	}
	return ok(found);
}

function binaryColumns(binary: BinaryFiles | undefined): readonly (number | null)[] {
	if (binary === undefined) return [null, null, null, null, null, null, null];
	return [
		binary.added.files,
		binary.added.bytes,
		binary.removed.files,
		binary.removed.bytes,
		binary.changed.files,
		binary.changed.before,
		binary.changed.after
	];
}

/**
 * Replaces a revision's progress and its count of test lines, which follow its
 * sorting and marks, after a write that changed them.
 */
export function setRevisionProgress(
	q: Queries,
	id: RevisionId,
	progress: UnitProgress,
	size: DiffSize
): void {
	q.run(
		'UPDATE revisions SET counted_units = ?, reviewed_units = ?, ignored_units = ?, uncategorised_units = ?, test_added_lines = ?, test_deleted_lines = ? WHERE id = ?',
		progress.counted,
		progress.reviewed,
		progress.ignored,
		progress.uncategorised,
		size.testLines.added,
		size.testLines.removed,
		id
	);
}

/** Records a revision's binary files, once they have been counted, unless they were already. */
export function setRevisionBinary(q: Queries, id: RevisionId, binary: BinaryFiles): void {
	q.run(
		'UPDATE revisions SET binary_added_files = ?, binary_added_bytes = ?, binary_removed_files = ?, binary_removed_bytes = ?, binary_changed_files = ?, binary_changed_before = ?, binary_changed_after = ? WHERE id = ? AND binary_added_files IS NULL',
		...binaryColumns(binary),
		id
	);
}

/** A snapshot a revision refers to. */
export interface SnapshotUse {
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
}

const use = z.object({ store_id: text(parseStoreId), snapshot_id: text(parseSnapshotId) });

/**
 * The snapshots a report's revisions refer to, read from those two columns
 * alone, so a report whose rows are otherwise damaged can still be deleted.
 * A row whose two columns cannot be read is left out; its snapshot is then
 * removed once nothing refers to it (`unreferenced_snapshots`).
 */
export function snapshotsOfReport(q: Queries, report: ReportId): readonly SnapshotUse[] {
	return q
		.all('SELECT DISTINCT store_id, snapshot_id FROM revisions WHERE report_id = ?', report)
		.flatMap((raw) => {
			const row = parseRow('revisions', use, raw);
			return row.ok ? [{ store: row.value.store_id, snapshot: row.value.snapshot_id }] : [];
		});
}

/** Whether any revision refers to the snapshot. */
export function snapshotInUse(q: Queries, snapshot: SnapshotUse): boolean {
	return (
		q.get(
			'SELECT 1 AS found FROM revisions WHERE store_id = ? AND snapshot_id = ?',
			snapshot.store,
			snapshot.snapshot
		) !== undefined
	);
}

/** Every snapshot some revision refers to. */
export function snapshotsInUse(q: Queries): Result<readonly SnapshotUse[], StoredRowInvalid> {
	return map(
		parseRows('revisions', use, q.all('SELECT DISTINCT store_id, snapshot_id FROM revisions')),
		(rows) => rows.map((r) => ({ store: r.store_id, snapshot: r.snapshot_id }))
	);
}

/** A snapshot a revision of a report refers to, in one store. */
export interface ReportSnapshot {
	readonly report: ReportId;
	readonly snapshot: SnapshotId;
}

const reportSnapshot = z.object({
	report_id: text(parseReportId),
	snapshot_id: text(parseSnapshotId)
});

/**
 * The snapshots every report's revisions refer to in the store, for measuring
 * what each Delve takes there. A row whose two columns cannot be read is left
 * out, as `snapshotsOfReport` leaves it out.
 */
export function snapshotsInStore(q: Queries, store: StoreId): readonly ReportSnapshot[] {
	return q
		.all('SELECT DISTINCT report_id, snapshot_id FROM revisions WHERE store_id = ?', store)
		.flatMap((raw) => {
			const row = parseRow('revisions', reportSnapshot, raw);
			return row.ok ? [{ report: row.value.report_id, snapshot: row.value.snapshot_id }] : [];
		});
}
