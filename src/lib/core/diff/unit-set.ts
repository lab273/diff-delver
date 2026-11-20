/**
 * A set of change units of one diff (DESIGN 4.1): line ranges per file and side,
 * and file-level units. Reviewed marks are one such set (DESIGN 5);
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

/** What of one file is in the set: some of its lines, its file-level unit, or both. */
export interface FileUnitSet {
	readonly old: RangeSet;
	readonly new: RangeSet;
	/** Whether its file-level unit is in the set. */
	readonly file: boolean;
}

export interface UnitSet {
	/** Only files with something in the set: never an entry with nothing in it. */
	readonly files: ReadonlyMap<RepoPath, FileUnitSet>;
}

/** The set with nothing in it. */
export const EMPTY_UNIT_SET: UnitSet = { files: new Map() };

/** The lines of one side of a file in the set; empty when none are. */
export function linesInSet(set: UnitSet, path: RepoPath, side: Side): RangeSet {
	const file = set.files.get(path);
	if (file === undefined) return RangeSet.empty;
	switch (side) {
		case 'old':
			return file.old;
		case 'new':
			return file.new;
	}
}

/** Whether the file-level unit of a file is in the set. */
export function fileUnitInSet(set: UnitSet, path: RepoPath): boolean {
	return set.files.get(path)?.file === true;
}

/** A file's entry from its units in the set, or no entry when there are none. */
export function fileUnitsOf(old: RangeSet, now: RangeSet, file = false): FileUnitSet | undefined {
	return old.isEmpty && now.isEmpty && !file ? undefined : { old, new: now, file };
}

/** How many units of one file are in the set. */
export function fileUnitSetSize(file: FileUnitSet | undefined): UnitCount {
	if (file === undefined) return NO_UNITS;
	const lines = unitCountOf(file.old.size + file.new.size);
	return file.file ? addUnits(lines, ONE_UNIT) : lines;
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
		if (y === undefined || x.file !== y.file) return false;
		if (!x.old.equals(y.old) || !x.new.equals(y.new)) return false;
	}
	return true;
}
