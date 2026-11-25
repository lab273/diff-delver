/**
 * Review progress (DESIGN 5): how many units and slices are reviewed, per group
 * of the view, per file and overall. Ignored is left out of the overall total
 * and counted beside it, so "everything reviewed" means everything that needs
 * reviewing. A slice counts as reviewed when every one of its units is.
 */
import { groupKeyId, type GroupKeyId } from '../group-key-id.tiny.ts';
import type { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { sliceCountOf, type SliceCount } from '../slice-count.tiny.ts';
import { unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import type { Diff } from '../diff/diff.ts';
import type { UnitProgress } from '../reports/report.ts';
import { groupOf, inReadingOrder, type GroupKey, type ViewKind } from '../diff/slices.ts';
import type { SectionId } from '../section-id.tiny.ts';
import { assignedUnits, type AssignmentState } from '../diff/state.ts';
import { fileUnitReviewed, reviewedLines, type ReviewedMarks } from './reviewed-marks.ts';

export interface Tally {
	readonly units: UnitCount;
	readonly reviewedUnits: UnitCount;
	readonly slices: SliceCount;
	readonly reviewedSlices: SliceCount;
}

export interface GroupProgress {
	readonly key: GroupKey;
	readonly tally: Tally;
}

export interface FileProgress {
	/** The file's units outside Ignored. */
	readonly tally: Tally;
	/** The file's units in Ignored. */
	readonly ignored: Tally;
}

export interface Progress {
	/** Every unit outside Ignored. */
	readonly overall: Tally;
	/** Every unit in Ignored, shown beside the total. */
	readonly ignored: Tally;
	/** Units nobody has sorted yet; they count in `overall`. */
	readonly uncategorised: UnitCount;
	/** Each group of the view that holds units, in the order the view reads them. */
	readonly groups: ReadonlyMap<GroupKeyId, GroupProgress>;
	/** Each file of the diff. */
	readonly files: ReadonlyMap<RepoPath, FileProgress>;
}

class Counter {
	units = 0;
	reviewedUnits = 0;
	slices = 0;
	reviewedSlices = 0;

	addSlice(units: number, reviewed: number): void {
		this.units += units;
		this.reviewedUnits += reviewed;
		this.slices += 1;
		if (reviewed === units) this.reviewedSlices += 1;
	}

	get tally(): Tally {
		return {
			units: unitCountOf(this.units),
			reviewedUnits: unitCountOf(this.reviewedUnits),
			slices: sliceCountOf(this.slices),
			reviewedSlices: sliceCountOf(this.reviewedSlices)
		};
	}
}

/** How many numbers from `first` to `last` are in the set. */
export function countWithin(set: RangeSet, first: number, last: number): number {
	const intervals = set.intervals;
	let count = 0;
	for (let i = set.firstEndingAtOrAfter(first); i < intervals.length; i += 1) {
		const interval = intervals[i];
		if (interval === undefined || interval.first > last) break;
		count += Math.min(interval.last, last) - Math.max(interval.first, first) + 1;
	}
	return count;
}

/**
 * The progress of a review: the state's groups in `view`, with the reviewer's
 * marks. `sections` is the sections' reading order, as the views take it.
 */
export function reviewProgress(
	diff: Diff,
	state: AssignmentState,
	marks: ReviewedMarks,
	view: ViewKind,
	sections: readonly SectionId[] = []
): Progress {
	const overall = new Counter();
	const ignored = new Counter();
	let uncategorised = 0;
	const groups = new Map<GroupKeyId, { key: GroupKey; counter: Counter }>();
	const files = new Map<RepoPath, FileProgress>();
	for (const file of diff.files) {
		const path = file.file.path;
		const slices = new Map<GroupKeyId, { key: GroupKey; units: number; reviewed: number }>();
		const old = reviewedLines(marks, path, 'old');
		const now = reviewedLines(marks, path, 'new');
		for (const units of assignedUnits(state, file)) {
			const key = groupOf(view, units.assignment);
			const id = groupKeyId(key);
			let slice = slices.get(id);
			if (slice === undefined) {
				slice = { key, units: 0, reviewed: 0 };
				slices.set(id, slice);
			}
			if (units.kind === 'file') {
				slice.units += 1;
				if (fileUnitReviewed(marks, path)) slice.reviewed += 1;
			} else {
				const { side, first, last } = units.range;
				slice.units += last - first + 1;
				slice.reviewed += countWithin(side === 'old' ? old : now, first, last);
			}
			if (units.assignment.bucket.kind === 'uncategorised') {
				uncategorised += units.kind === 'file' ? 1 : units.range.last - units.range.first + 1;
			}
		}
		const fileCounted = new Counter();
		const fileIgnored = new Counter();
		for (const [id, slice] of slices) {
			const isIgnored = slice.key.kind === 'ignored';
			(isIgnored ? ignored : overall).addSlice(slice.units, slice.reviewed);
			(isIgnored ? fileIgnored : fileCounted).addSlice(slice.units, slice.reviewed);
			let group = groups.get(id);
			if (group === undefined) {
				group = { key: slice.key, counter: new Counter() };
				groups.set(id, group);
			}
			group.counter.addSlice(slice.units, slice.reviewed);
		}
		files.set(path, { tally: fileCounted.tally, ignored: fileIgnored.tally });
	}
	return {
		overall: overall.tally,
		ignored: ignored.tally,
		uncategorised: unitCountOf(uncategorised),
		groups: new Map(
			inReadingOrder([...groups], ([, g]) => g.key, sections).map(([id, g]) => [
				id,
				{ key: g.key, tally: g.counter.tally }
			])
		),
		files
	};
}

/** The figures of a progress that the reports list shows, as a revision stores them. */
export function unitProgressOf(progress: Progress): UnitProgress {
	return {
		counted: progress.overall.units,
		reviewed: progress.overall.reviewedUnits,
		ignored: progress.ignored.units,
		uncategorised: progress.uncategorised
	};
}
