/**
 * Where comments are drawn among a file's lines, pure, so the page and its
 * tests agree: a comment sits under the last line of its range, on its side;
 * a range is one run of lines on one side; and a comment whose lines are in
 * another version than the page shows says so in plain words.
 */
import type { LineNumber } from '../line-number.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { Side } from '../side.tiny.ts';

/** A run of lines on one side of a file. */
export interface LineSelection {
	readonly side: Side;
	readonly first: LineNumber;
	readonly last: LineNumber;
}

/** The lines from where a selection started to where it has got, whichever way it went. */
export function selectionBetween(side: Side, from: LineNumber, to: LineNumber): LineSelection {
	return from <= to ? { side, first: from, last: to } : { side, first: to, last: from };
}

export function inSelection(
	selection: LineSelection | undefined,
	side: Side,
	line: LineNumber
): boolean {
	return (
		selection !== undefined &&
		selection.side === side &&
		line >= selection.first &&
		line <= selection.last
	);
}

/** One line of one side, as a key: what a comment is drawn under. */
export function lineKey(side: Side, line: LineNumber): string {
	return `${side}:${String(line)}`;
}

/**
 * Comments by the line each is drawn under, the last of its range, in the
 * order given: a file's lines look each of theirs up as they are drawn, so
 * drawing costs nothing where there are no comments.
 */
export function byLastLine<T>(
	items: readonly T[],
	selectionOf: (item: T) => LineSelection
): ReadonlyMap<string, readonly T[]> {
	const found = new Map<string, T[]>();
	for (const item of items) {
		const { side, last } = selectionOf(item);
		const key = lineKey(side, last);
		const there = found.get(key);
		if (there === undefined) found.set(key, [item]);
		else there.push(item);
	}
	return found;
}

/**
 * Why a comment is not among the lines the page shows, in plain words, or
 * undefined when it is written on the version shown. Its lines are those of
 * the version it was written on (DESIGN 6.3), which another version may have
 * moved, changed or dropped.
 */
export function describeOtherVersion(
	written: RevisionNumber,
	shown: RevisionNumber
): string | undefined {
	if (written === shown) return undefined;
	return written < shown
		? `Written on version ${String(written)}, an earlier version than the one shown here, so it is not among the lines of the diff.`
		: `Written on version ${String(written)}, a newer version than the one shown here, so it is not among the lines of the diff.`;
}
