/**
 * Reviewed marks (DESIGN 5): which change units the reviewer has marked as
 * reviewed. Only the reviewer sets them. They are kept per unit, as line ranges
 * per file and side, so a slice of a file split across sections is ticked
 * exactly, and a later diff update can carry them over line by line.
 *
 * Immutable. A file with nothing marked has no entry, so two equal sets of
 * marks always look the same.
 */
import { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Side } from '../side.tiny.ts';

/** What of one file is marked: some of its lines, or its single file-level unit. */
export type FileReviewed =
	| {
			readonly kind: 'lines';
			/** Never both empty. */
			readonly old: RangeSet;
			readonly new: RangeSet;
	  }
	| { readonly kind: 'file' };

export interface ReviewedMarks {
	/** Only files with something marked. */
	readonly files: ReadonlyMap<RepoPath, FileReviewed>;
}

/** Nothing reviewed yet. */
export const NO_MARKS: ReviewedMarks = { files: new Map() };

/** The marked lines of one side of a file; empty when none are. */
export function reviewedLines(marks: ReviewedMarks, path: RepoPath, side: Side): RangeSet {
	const file = marks.files.get(path);
	if (file?.kind !== 'lines') return RangeSet.empty;
	switch (side) {
		case 'old':
			return file.old;
		case 'new':
			return file.new;
	}
}

/** Whether the file-level unit of a file without lines is marked. */
export function fileUnitReviewed(marks: ReviewedMarks, path: RepoPath): boolean {
	return marks.files.get(path)?.kind === 'file';
}

/** A file's marks from its marked lines, or no entry when there are none. */
export function fileReviewedOf(old: RangeSet, now: RangeSet): FileReviewed | undefined {
	return old.isEmpty && now.isEmpty ? undefined : { kind: 'lines', old, new: now };
}

/** Whether two sets of marks mark exactly the same units. */
export function sameReviewedMarks(a: ReviewedMarks, b: ReviewedMarks): boolean {
	if (a.files.size !== b.files.size) return false;
	for (const [path, x] of a.files) {
		const y = b.files.get(path);
		if (y === undefined || x.kind !== y.kind) return false;
		if (x.kind === 'lines' && y.kind === 'lines') {
			if (!x.old.equals(y.old) || !x.new.equals(y.new)) return false;
		}
	}
	return true;
}
