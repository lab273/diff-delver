/**
 * Which change lines of a new version sit near a change (DESIGN 6.2 step 3), so
 * that their reviewed marks are not carried over. The rule, and the distance, are
 * stated at the top of `carry-over.ts`; this is the measuring.
 *
 * Distance is counted in the lines of one hunk of the new diff as it is shown:
 * its context, deleted and added lines in git's order, both sides together. A
 * place where lines were removed lies between two shown lines, one line from
 * each. Lines in different hunks are never near each other: git joins hunks
 * whose context would touch, so hunks are at least seven lines of the file apart.
 *
 * Work is in proportion to the lines of the file's hunks and the edits, with a
 * binary search per edit.
 */
import type { DiffFile, SideLines } from '../diff/diff.ts';
import { hunksOf, type DiffLine, type FileDiff, type Hunk } from '../diff/file-diff.ts';
import { RangeSet } from '../range-set.ts';

/**
 * Where git's diff between two versions' trees edited one file, in the later
 * tree's line numbers: the lines it added, and the places where it removed lines,
 * each given as the number of the line that now follows the removal.
 */
export interface EditPlaces {
	readonly added: readonly number[];
	readonly removedBefore: readonly number[];
}

/** No edits: the file is the same in both trees. */
export const NO_EDITS: EditPlaces = { added: [], removedBefore: [] };

/** Where git's diff of one file between two trees edited it, in the later tree's numbers. */
export function editPlaces(change: FileDiff): EditPlaces {
	const added: number[] = [];
	const removedBefore: number[] = [];
	for (const hunk of hunksOf(change)) {
		let nextNew = hunk.new.length === 0 ? hunk.new.start + 1 : hunk.new.start;
		let removing = false;
		for (const line of hunk.lines) {
			switch (line.kind) {
				case 'context':
				case 'added':
					if (line.kind === 'added') added.push(line.new);
					nextNew = line.new + 1;
					removing = false;
					break;
				case 'deleted':
					if (!removing) removedBefore.push(nextNew);
					removing = true;
					break;
			}
		}
	}
	return { added, removedBefore };
}

/** What near a change means for one file of the new version. */
export interface NearInput {
	readonly file: DiffFile;
	/** The file's change lines new in this version. */
	readonly fresh: SideLines;
	/** Edits between the two versions' heads, in the new head's numbers: the file's new side. */
	readonly heads: EditPlaces;
	/** Edits between the two versions' bases, in the new base's numbers: the file's old side. */
	readonly bases: EditPlaces;
	/** How many shown lines away still counts as near. */
	readonly distance: number;
}

/** The change lines of the file within `distance` shown lines of a new line or an edit. */
export function linesNearChanges(input: NearInput): SideLines {
	const old: number[] = [];
	const now: number[] = [];
	for (const hunk of input.file.hunks.values()) {
		const near = nearInHunk(hunk, input);
		for (const [i, line] of hunk.lines.entries()) {
			if (near[i] !== true) continue;
			if (line.kind === 'deleted') old.push(line.old);
			else if (line.kind === 'added') now.push(line.new);
		}
	}
	return { old: RangeSet.fromNumbers(old), new: RangeSet.fromNumbers(now) };
}

/** One side's line numbers in a hunk, with the index of each shown line, in order. */
interface Numbered {
	readonly numbers: readonly number[];
	readonly at: readonly number[];
}

function numberedSide(hunk: Hunk, side: 'old' | 'new'): Numbered {
	const numbers: number[] = [];
	const at: number[] = [];
	for (const [i, line] of hunk.lines.entries()) {
		const n = lineNumberOn(line, side);
		if (n === undefined) continue;
		numbers.push(n);
		at.push(i);
	}
	return { numbers, at };
}

/** A shown line's number on one side, if it has one there. */
function lineNumberOn(line: DiffLine, side: 'old' | 'new'): number | undefined {
	switch (line.kind) {
		case 'context':
			return side === 'old' ? line.old : line.new;
		case 'deleted':
			return side === 'old' ? line.old : undefined;
		case 'added':
			return side === 'new' ? line.new : undefined;
	}
}

/** The first position in sorted `numbers` holding `n` or more. */
function firstAtLeast(numbers: readonly number[], n: number): number {
	let low = 0;
	let high = numbers.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((numbers[middle] ?? 0) < n) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * For each shown line of the hunk, whether it is within `distance` of a change.
 * Positions are counted in halves, so a place between two lines is a position
 * of its own: line `i` is at `2i`, and a removal between lines `a` and `b` covers
 * `2a + 1` to `2b - 1`.
 */
function nearInHunk(hunk: Hunk, input: NearInput): readonly boolean[] {
	const count = hunk.lines.length;
	// +1 where a near stretch starts and -1 after it ends, by line index.
	const steps: number[] = Array.from({ length: count + 1 }, () => 0);
	const reach = 2 * input.distance;
	const hot = (low: number, high: number): void => {
		const first = Math.max(0, Math.ceil((low - reach) / 2));
		const last = Math.min(count - 1, Math.floor((high + reach) / 2));
		if (first > last) return;
		steps[first] = (steps[first] ?? 0) + 1;
		steps[last + 1] = (steps[last + 1] ?? 0) - 1;
	};
	for (const [i, line] of hunk.lines.entries()) {
		const fresh =
			(line.kind === 'added' && input.fresh.new.has(line.new)) ||
			(line.kind === 'deleted' && input.fresh.old.has(line.old));
		if (fresh) hot(2 * i, 2 * i);
	}
	const sides = [
		[numberedSide(hunk, 'new'), input.heads],
		[numberedSide(hunk, 'old'), input.bases]
	] as const;
	for (const [side, edits] of sides) {
		const first = side.numbers[0];
		const last = side.numbers.at(-1);
		if (first === undefined || last === undefined) continue;
		for (const n of edits.added) {
			const k = firstAtLeast(side.numbers, n);
			const index = side.at[k];
			if (side.numbers[k] === n && index !== undefined) hot(2 * index, 2 * index);
		}
		for (const n of edits.removedBefore) {
			if (n < first || n > last + 1) continue;
			const k = firstAtLeast(side.numbers, n);
			const before = k === 0 ? -1 : (side.at[k - 1] ?? -1);
			const after = side.at[k] ?? count;
			hot(2 * before + 1, 2 * after - 1);
		}
	}
	const near: boolean[] = [];
	let depth = 0;
	for (let i = 0; i < count; i += 1) {
		depth += steps[i] ?? 0;
		near.push(depth > 0);
	}
	return near;
}
