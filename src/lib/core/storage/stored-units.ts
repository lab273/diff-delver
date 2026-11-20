/**
 * The assignment state and the reviewed marks as rows, and back (DESIGN 4.1, 5):
 * the pure half of storing them. A row is a run of units of one file: a line
 * range on one side, or the file's single file-level unit. The database tables
 * store these rows as they are; this module turns a state into rows, and rows
 * read back into a state, checking them against the diff they belong to, so a
 * damaged or mismatched table is an error rather than a wrong review.
 *
 * Round trip: for any state reachable from `initialState` by any sequence of
 * `assign` calls, `assignmentStateFromRows(diff, assignmentRowsOf(diff, state))`
 * is an equal state; likewise for reviewed marks.
 */
import { lineRangesOf, type LineRange } from '../line-range.ts';
import { RangeMap, type Segment } from '../range-map.ts';
import { RangeSet, type Interval } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import type { Side } from '../side.tiny.ts';
import { escapedRepoPath } from '../path-bytes.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { Diff, DiffFile } from '../diff/diff.ts';
import {
	assignedUnits,
	fileAssignment,
	sameAssignment,
	type Assignment,
	type AssignmentState,
	type FileAssignment
} from '../diff/state.ts';
import { fileReviewedOf, type FileReviewed, type ReviewedMarks } from '../review/reviewed-marks.ts';

/** Some units of one file: a line range on one side, or its file-level unit. */
export type StoredUnits =
	{ readonly kind: 'lines'; readonly range: LineRange } | { readonly kind: 'file' };

/** A run of units of one file with one bucket and role. */
export interface AssignmentRow {
	readonly path: RepoPath;
	readonly units: StoredUnits;
	readonly assignment: Assignment;
}

/** A run of reviewed units of one file. */
export interface ReviewedRow {
	readonly path: RepoPath;
	readonly units: StoredUnits;
}

/** Rows that do not fit the diff they are stored for. */
export interface StoredStateMismatch {
	readonly kind: 'StoredStateMismatch';
	readonly what: 'assignments' | 'reviewed marks';
	readonly path: RepoPath;
	readonly problem:
		/** A row names a file the diff does not have. */
		| 'not-in-diff'
		/** A file of the diff has no rows (assignments only: every unit has one). */
		| 'missing'
		/** Two rows cover the same unit. */
		| 'overlap'
		/** The rows cover units the file does not have, or (for assignments) not all of them. */
		| 'units-differ';
}

/** What happened and what to do next, for the reviewer. */
export function describeStoredStateMismatch(error: StoredStateMismatch): ReviewerMessage {
	const problem = ((): string => {
		switch (error.problem) {
			case 'not-in-diff':
				return 'names a file that is not in the diff';
			case 'missing':
				return 'has nothing for a file of the diff';
			case 'overlap':
				return 'covers some lines twice';
			case 'units-differ':
				return 'does not match the changed lines';
		}
	})();
	return reviewerMessage(
		`The saved ${error.what} of this diff ${problem} (${escapedRepoPath(error.path)}), so the database has been damaged or changed by hand. Delete the diff from the list of diffs and open its changes again; if it happens again, please report it as a bug.`
	);
}

/** The rows of every file of the diff, or only of `paths`, in the diff's order. */
export function assignmentRowsOf(
	diff: Diff,
	state: AssignmentState,
	paths?: ReadonlySet<RepoPath>
): readonly AssignmentRow[] {
	const rows: AssignmentRow[] = [];
	for (const file of diff.files) {
		const path = file.file.path;
		if (paths !== undefined && !paths.has(path)) continue;
		for (const units of assignedUnits(state, file)) {
			rows.push(
				units.kind === 'lines'
					? { path, units: { kind: 'lines', range: units.range }, assignment: units.assignment }
					: { path, units: { kind: 'file' }, assignment: units.assignment }
			);
		}
	}
	return rows;
}

/** The files whose assignments differ between two states of one diff. */
export function changedAssignmentPaths(
	diff: Diff,
	before: AssignmentState,
	after: AssignmentState
): ReadonlySet<RepoPath> {
	const changed = new Set<RepoPath>();
	for (const file of diff.files) {
		const a = before.files.get(file.file.path);
		const b = after.files.get(file.file.path);
		if (a === b) continue;
		if (!sameFileAssignment(fileAssignment(before, file), fileAssignment(after, file))) {
			changed.add(file.file.path);
		}
	}
	return changed;
}

function groupByPath<R extends { readonly path: RepoPath }>(
	rows: readonly R[]
): Map<RepoPath, R[]> {
	const byPath = new Map<RepoPath, R[]>();
	for (const row of rows) {
		const list = byPath.get(row.path);
		if (list === undefined) byPath.set(row.path, [row]);
		else list.push(row);
	}
	return byPath;
}

/** Sorted intervals with no overlap, or undefined when two overlap. */
function disjoint<T extends Interval>(intervals: readonly T[]): readonly T[] | undefined {
	const sorted = intervals.toSorted((a, b) => a.first - b.first);
	for (let i = 1; i < sorted.length; i += 1) {
		const previous = sorted[i - 1];
		const current = sorted[i];
		if (previous !== undefined && current !== undefined && previous.last >= current.first) {
			return undefined;
		}
	}
	return sorted;
}

/** The assignment state the rows describe, checked against the diff. */
export function assignmentStateFromRows(
	diff: Diff,
	rows: readonly AssignmentRow[]
): Result<AssignmentState, StoredStateMismatch> {
	const mismatch = (path: RepoPath, problem: StoredStateMismatch['problem']) =>
		err<StoredStateMismatch>({ kind: 'StoredStateMismatch', what: 'assignments', path, problem });
	const byPath = groupByPath(rows);
	for (const path of byPath.keys())
		if (!diff.byPath.has(path)) return mismatch(path, 'not-in-diff');
	const files = new Map<RepoPath, FileAssignment>();
	for (const file of diff.files) {
		const path = file.file.path;
		const own = byPath.get(path);
		if (own === undefined) return mismatch(path, 'missing');
		const read = fileAssignmentFromRows(file, own);
		if (!read.ok) return mismatch(path, read.error);
		files.set(path, read.value);
	}
	return ok({ files });
}

function fileAssignmentFromRows(
	file: DiffFile,
	rows: readonly AssignmentRow[]
): Result<FileAssignment, 'overlap' | 'units-differ'> {
	if (!file.hasLines) {
		const [only, ...rest] = rows;
		if (only === undefined || only.units.kind !== 'file' || rest.length > 0) {
			return err(rows.length > 1 ? 'overlap' : 'units-differ');
		}
		return ok({ kind: 'file', assignment: only.assignment });
	}
	const segments: Record<Side, Segment<Assignment>[]> = { old: [], new: [] };
	for (const row of rows) {
		if (row.units.kind !== 'lines') return err('units-differ');
		const { side, first, last } = row.units.range;
		segments[side].push({ first, last, value: row.assignment });
	}
	const old = disjoint(segments.old);
	const now = disjoint(segments.new);
	if (old === undefined || now === undefined) return err('overlap');
	const oldMap = RangeMap.fromSegments(old, sameAssignment);
	const newMap = RangeMap.fromSegments(now, sameAssignment);
	if (!oldMap.domain.equals(file.changed.old) || !newMap.domain.equals(file.changed.new)) {
		return err('units-differ');
	}
	return ok({ kind: 'lines', old: oldMap, new: newMap });
}

/** The rows of every file with marks, or only of `paths`, sorted by path as git does. */
export function reviewedRowsOf(
	marks: ReviewedMarks,
	paths?: ReadonlySet<RepoPath>
): readonly ReviewedRow[] {
	const rows: ReviewedRow[] = [];
	for (const [path, file] of marks.files) {
		if (paths !== undefined && !paths.has(path)) continue;
		switch (file.kind) {
			case 'file':
				rows.push({ path, units: { kind: 'file' } });
				break;
			case 'lines':
				for (const range of [...lineRangesOf('old', file.old), ...lineRangesOf('new', file.new)]) {
					rows.push({ path, units: { kind: 'lines', range } });
				}
				break;
		}
	}
	return rows;
}

/** The reviewed marks the rows describe, checked against the diff: only its units can be marked. */
export function reviewedMarksFromRows(
	diff: Diff,
	rows: readonly ReviewedRow[]
): Result<ReviewedMarks, StoredStateMismatch> {
	const mismatch = (path: RepoPath, problem: StoredStateMismatch['problem']) =>
		err<StoredStateMismatch>({
			kind: 'StoredStateMismatch',
			what: 'reviewed marks',
			path,
			problem
		});
	const files = new Map<RepoPath, FileReviewed>();
	for (const [path, own] of groupByPath(rows)) {
		const file = diff.byPath.get(path);
		if (file === undefined) return mismatch(path, 'not-in-diff');
		if (!file.hasLines) {
			if (own.length > 1) return mismatch(path, 'overlap');
			if (own[0]?.units.kind !== 'file') return mismatch(path, 'units-differ');
			files.set(path, { kind: 'file' });
			continue;
		}
		const intervals: Record<Side, Interval[]> = { old: [], new: [] };
		for (const row of own) {
			if (row.units.kind !== 'lines') return mismatch(path, 'units-differ');
			intervals[row.units.range.side].push(row.units.range);
		}
		if (disjoint(intervals.old) === undefined || disjoint(intervals.new) === undefined) {
			return mismatch(path, 'overlap');
		}
		const old = RangeSet.fromIntervals(intervals.old);
		const now = RangeSet.fromIntervals(intervals.new);
		if (!old.subtract(file.changed.old).isEmpty || !now.subtract(file.changed.new).isEmpty) {
			return mismatch(path, 'units-differ');
		}
		const entry = fileReviewedOf(old, now);
		if (entry !== undefined) files.set(path, entry);
	}
	return ok({ files });
}

function sameFileAssignment(a: FileAssignment, b: FileAssignment): boolean {
	if (a.kind === 'file' || b.kind === 'file') {
		return a.kind === 'file' && b.kind === 'file' && sameAssignment(a.assignment, b.assignment);
	}
	return (
		sameSegments(a.old.segments, b.old.segments) && sameSegments(a.new.segments, b.new.segments)
	);
}

function sameSegments(
	a: readonly Segment<Assignment>[],
	b: readonly Segment<Assignment>[]
): boolean {
	return (
		a.length === b.length &&
		a.every((x, i) => {
			const y = b[i];
			return (
				y !== undefined &&
				x.first === y.first &&
				x.last === y.last &&
				sameAssignment(x.value, y.value)
			);
		})
	);
}

/** Whether two states of one diff give every unit the same bucket and role. */
export function sameAssignmentState(diff: Diff, a: AssignmentState, b: AssignmentState): boolean {
	return changedAssignmentPaths(diff, a, b).size === 0;
}
