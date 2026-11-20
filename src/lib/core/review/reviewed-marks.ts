/**
 * Reviewed marks (DESIGN 5): which change units the reviewer has marked as
 * reviewed. Only the reviewer sets them. They are kept per unit, as line ranges
 * per file and side, so a slice of a file split across sections is ticked
 * exactly, and a diff update carries them over line by line
 * (`#lib/core/update/carry-over.ts`).
 *
 * They are a set of units (`#lib/core/diff/unit-set.ts`); the names here say
 * what the set means.
 */
import {
	EMPTY_UNIT_SET,
	fileUnitsOf,
	fileUnitInSet,
	linesInSet,
	sameUnitSet,
	type FileUnitSet,
	type UnitSet
} from '../diff/unit-set.ts';
import type { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Side } from '../side.tiny.ts';

/** What of one file is marked: some of its lines, its file-level unit, or both. */
export type FileReviewed = FileUnitSet;

/** The marked units; only files with something marked have an entry. */
export type ReviewedMarks = UnitSet;

/** Nothing reviewed yet. */
export const NO_MARKS: ReviewedMarks = EMPTY_UNIT_SET;

/** The marked lines of one side of a file; empty when none are. */
export function reviewedLines(marks: ReviewedMarks, path: RepoPath, side: Side): RangeSet {
	return linesInSet(marks, path, side);
}

/** Whether the file-level unit of a file is marked. */
export function fileUnitReviewed(marks: ReviewedMarks, path: RepoPath): boolean {
	return fileUnitInSet(marks, path);
}

/** A file's marks from its marked units, or no entry when there are none. */
export function fileReviewedOf(
	old: RangeSet,
	now: RangeSet,
	file = false
): FileReviewed | undefined {
	return fileUnitsOf(old, now, file);
}

/** Whether two sets of marks mark exactly the same units. */
export function sameReviewedMarks(a: ReviewedMarks, b: ReviewedMarks): boolean {
	return sameUnitSet(a, b);
}
