/**
 * Marking units reviewed, or not (DESIGN 5). The reviewer ticks a slice, a whole
 * file, or a whole group (a section, the tests of a section, Ignored or Not
 * sorted yet); the mark goes on each change unit the target covers, so a file
 * split across sections is ticked exactly where it was ticked.
 */
import { escapedRepoPath } from '../path-bytes.ts';
import { RangeSet, type Interval } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { addUnits, NO_UNITS, ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import { groupKeyId } from '../group-key-id.tiny.ts';
import type { Diff, DiffFile } from '../diff/diff.ts';
import { groupOf, type GroupKey, type ViewKind } from '../diff/slices.ts';
import { assignedUnits, type AssignmentState } from '../diff/state.ts';
import {
	fileReviewedOf,
	fileUnitReviewed,
	reviewedLines,
	type FileReviewed,
	type ReviewedMarks
} from './reviewed-marks.ts';

/** What the reviewer ticks. */
export type ReviewTarget =
	/** One file's part within one group of the view. */
	| { readonly kind: 'slice'; readonly group: GroupKey; readonly path: RepoPath }
	/** Every unit of one file, in whatever groups. */
	| { readonly kind: 'file'; readonly path: RepoPath }
	/** Every slice of one group of the view. */
	| { readonly kind: 'group'; readonly group: GroupKey };

export type MarkError =
	/** The target names a file that is not in the diff. */
	| { readonly kind: 'FileNotInDiff'; readonly path: RepoPath }
	/** The target holds no units: the file has no part in that group, or the group is empty. */
	| { readonly kind: 'NothingToMark'; readonly target: ReviewTarget };

/** What happened and what to do next, for the reviewer. */
export function describeMarkError(error: MarkError): ReviewerMessage {
	switch (error.kind) {
		case 'FileNotInDiff':
			return reviewerMessage(
				`${escapedRepoPath(error.path)} is not one of the files this version of the diff changes. Reload the page to see the files it changes now.`
			);
		case 'NothingToMark':
			return reviewerMessage(
				'There is nothing here to mark as reviewed: this part has no changed lines any more. Reload the page to see the current breakdown.'
			);
	}
}

export interface Marked {
	readonly marks: ReviewedMarks;
	/** The files whose marks may have changed. */
	readonly files: ReadonlySet<RepoPath>;
	/** How many units the target covers. */
	readonly units: UnitCount;
}

/** The units of one file a target covers: some lines per side, its file-level unit, or nothing. */
interface Covered {
	readonly old: RangeSet;
	readonly new: RangeSet;
	readonly file: boolean;
}

function coveredIn(
	file: DiffFile,
	state: AssignmentState,
	view: ViewKind,
	group: GroupKey | undefined
): Covered {
	const wanted = group === undefined ? undefined : groupKeyId(group);
	const inTarget = (units: ReturnType<typeof assignedUnits>[number]): boolean =>
		wanted === undefined || groupKeyId(groupOf(view, units.assignment)) === wanted;
	const old: Interval[] = [];
	const now: Interval[] = [];
	let whole = false;
	for (const units of assignedUnits(state, file)) {
		if (!inTarget(units)) continue;
		if (units.kind === 'file') whole = true;
		else (units.range.side === 'old' ? old : now).push(units.range);
	}
	return { old: RangeSet.fromIntervals(old), new: RangeSet.fromIntervals(now), file: whole };
}

function sizeOf(covered: Covered): UnitCount {
	const lines = unitCountOf(covered.old.size + covered.new.size);
	return covered.file ? addUnits(lines, ONE_UNIT) : lines;
}

function applied(
	marks: ReviewedMarks,
	path: RepoPath,
	covered: Covered,
	reviewed: boolean
): FileReviewed | undefined {
	const change = (side: 'old' | 'new', lines: RangeSet): RangeSet => {
		const before = reviewedLines(marks, path, side);
		return reviewed ? before.union(lines) : before.subtract(lines);
	};
	const file = covered.file ? reviewed : fileUnitReviewed(marks, path);
	return fileReviewedOf(change('old', covered.old), change('new', covered.new), file);
}

/**
 * Marks every unit the target covers as reviewed, or as not reviewed. Groups
 * and slices are those of `view`. Marks on other units do not change.
 */
export function markReviewed(
	diff: Diff,
	state: AssignmentState,
	marks: ReviewedMarks,
	target: ReviewTarget,
	reviewed: boolean,
	view: ViewKind
): Result<Marked, MarkError> {
	const coverage: { file: DiffFile; covered: Covered }[] = [];
	switch (target.kind) {
		case 'slice':
		case 'file': {
			const file = diff.byPath.get(target.path);
			if (file === undefined) return err({ kind: 'FileNotInDiff', path: target.path });
			coverage.push({
				file,
				covered: coveredIn(file, state, view, target.kind === 'slice' ? target.group : undefined)
			});
			break;
		}
		case 'group':
			for (const file of diff.files) {
				const covered = coveredIn(file, state, view, target.group);
				if (sizeOf(covered) > 0) coverage.push({ file, covered });
			}
			break;
	}
	let units = NO_UNITS;
	const files = new Map(marks.files);
	const touched = new Set<RepoPath>();
	for (const { file, covered } of coverage) {
		const size = sizeOf(covered);
		if (size === 0) continue;
		const path = file.file.path;
		units = addUnits(units, size);
		const entry = applied(marks, path, covered, reviewed);
		if (entry === undefined) files.delete(path);
		else files.set(path, entry);
		touched.add(path);
	}
	if (units === 0) return err({ kind: 'NothingToMark', target });
	return ok({ marks: { files }, files: touched, units });
}
