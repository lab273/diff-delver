/**
 * Opening unchanged lines a part hides (DESIGN 8.3), as GitHub does: a step at
 * a time from either end of the hidden lines, or all of them. The lines below
 * the hunk above are opened downwards, the lines above the hunk below upwards,
 * and when the two meet nothing is hidden any more.
 *
 * Pure: the page keeps how many lines are open at each end, and asks the
 * daemon for the lines these say.
 */
import { lineNumberOf, type LineNumber } from '../line-number.tiny.ts';
import type { LineSpan } from './part-lines.ts';

/** How many lines one step opens. */
export const EXPANSION_STEP = 20;

/** Hidden lines and how many are open at each end. */
export interface Opened {
	/** The hidden lines, on the side they are read from. */
	readonly span: LineSpan;
	/** Lines open at the top of the span, below the hunk above. */
	readonly top: number;
	/** Lines open at the bottom of the span, above the hunk below. */
	readonly bottom: number;
}

/** How many lines of the span are still hidden. */
export function stillHidden(opened: Opened): number {
	return Math.max(0, opened.span.last - opened.span.first + 1 - opened.top - opened.bottom);
}

/** Which way to open: downwards from the top, upwards from the bottom, or all that is left. */
export type Direction = 'down' | 'up' | 'all';

/** The lines one action opens, or undefined when nothing is hidden. */
export function linesToOpen(
	opened: Opened,
	direction: Direction
): { readonly first: LineNumber; readonly last: LineNumber } | undefined {
	const left = stillHidden(opened);
	if (left === 0) return undefined;
	const first = opened.span.first + opened.top;
	const last = opened.span.last - opened.bottom;
	switch (direction) {
		case 'down':
			return {
				first: lineNumberOf(first),
				last: lineNumberOf(Math.min(last, first + EXPANSION_STEP - 1))
			};
		case 'up':
			return {
				first: lineNumberOf(Math.max(first, last - EXPANSION_STEP + 1)),
				last: lineNumberOf(last)
			};
		case 'all':
			return { first: lineNumberOf(first), last: lineNumberOf(last) };
	}
}

/** The opened state after `direction` opened `count` lines. */
export function afterOpening(opened: Opened, direction: Direction, count: number): Opened {
	switch (direction) {
		case 'down':
		case 'all':
			return { ...opened, top: opened.top + count };
		case 'up':
			return { ...opened, bottom: opened.bottom + count };
	}
}
