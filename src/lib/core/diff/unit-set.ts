/**
 * A set of change units of one diff (DESIGN 4.1): line ranges per file and side,
 * or a file's single file-level unit. Reviewed marks are one such set (DESIGN 5);
 * the units an update brought in that the previous version did not have are
 * another (DESIGN 6.2).
 *
 * Immutable. A file with no units in the set has no entry, so two equal sets
 * always look the same.
 */
import { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { addUnits, NO_UNITS, ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';

/** What of one file is in the set: some of its lines, or its single file-level unit. */
export type FileUnitSet =
	| {
			readonly kind: 'lines';
			/** Never both empty. */
			readonly old: RangeSet;
			readonly new: RangeSet;
	  }
	| { readonly kind: 'file' };

export interface UnitSet {
	/** Only files with something in the set. */
	readonly files: ReadonlyMap<RepoPath, FileUnitSet>;
}

/** The set with nothing in it. */
export const EMPTY_UNIT_SET: UnitSet = { files: new Map() };

/** The lines of one side of a file in the set; empty when none are. */
export function linesInSet(set: UnitSet, path: RepoPath, side: Side): RangeSet {
	const file = set.files.get(path);
	if (file?.kind !== 'lines') return RangeSet.empty;
	switch (side) {
		case 'old':
			return file.old;
		case 'new':
			return file.new;
	}
}

/** Whether the file-level unit of a file without lines is in the set. */
export function fileUnitInSet(set: UnitSet, path: RepoPath): boolean {
	return set.files.get(path)?.kind === 'file';
}

/** A file's entry from its lines in the set, or no entry when there are none. */
export function fileLinesOf(old: RangeSet, now: RangeSet): FileUnitSet | undefined {
	return old.isEmpty && now.isEmpty ? undefined : { kind: 'lines', old, new: now };
}

/** How many units of one file are in the set. */
export function fileUnitSetSize(file: FileUnitSet | undefined): UnitCount {
	if (file === undefined) return NO_UNITS;
	switch (file.kind) {
		case 'file':
			return ONE_UNIT;
		case 'lines':
			return unitCountOf(file.old.size + file.new.size);
	}
}

/** How many units the set holds. */
export function unitSetSize(set: UnitSet): UnitCount {
	let total = NO_UNITS;
	for (const file of set.files.values()) total = addUnits(total, fileUnitSetSize(file));
	return total;
}

/** Whether two sets hold exactly the same units. */
export function sameUnitSet(a: UnitSet, b: UnitSet): boolean {
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
