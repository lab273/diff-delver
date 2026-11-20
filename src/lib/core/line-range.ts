import { parseLineNumber, type LineNumber } from './line-number.tiny.ts';
import type { RangeSet } from './range-set.ts';
import { err, ok, type Result } from './result.ts';
import { sideSign, type Side } from './side.tiny.ts';

/** Lines `first` to `last`, inclusive, on one side of a file. */
export interface LineRange {
	readonly side: Side;
	readonly first: LineNumber;
	readonly last: LineNumber;
}

export interface InvalidLineRange {
	readonly kind: 'InvalidLineRange';
	readonly first: number;
	readonly last: number;
}

/** Accepts two line numbers with `first` no later than `last`. */
export function parseLineRange(
	side: Side,
	first: number,
	last: number
): Result<LineRange, InvalidLineRange> {
	const a = parseLineNumber(first);
	const b = parseLineNumber(last);
	if (!a.ok || !b.ok || first > last) return err({ kind: 'InvalidLineRange', first, last });
	return ok({ side, first: a.value, last: b.value });
}

/** The intervals of a set of line numbers as ranges. The set must hold line numbers only. */
export function lineRangesOf(side: Side, lines: RangeSet): readonly LineRange[] {
	return lines.intervals.map(({ first, last }) => {
		const range = parseLineRange(side, first, last);
		if (!range.ok) throw new RangeError(`Not line numbers: ${first}..${last}`);
		return range.value;
	});
}

/** A range in the agent-facing form: `+40..+62`, or `+40` for one line. */
export function formatLineRange(range: LineRange): string {
	const sign = sideSign(range.side);
	return range.first === range.last
		? `${sign}${range.first}`
		: `${sign}${range.first}..${sign}${range.last}`;
}

/** Ranges in the agent-facing form, comma-separated: `+40..+62,-38..-45`. */
export function formatLineRanges(ranges: readonly LineRange[]): string {
	return ranges.map(formatLineRange).join(',');
}
