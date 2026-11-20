/**
 * The agent-facing form of line ranges: `+40..+62,-38..-45`. `+` is the new
 * side, `-` the old side; a single line is `+40`. These are exactly the labels the
 * agent-facing diff text puts on changed lines.
 */
import { parseLineRange, type LineRange } from '../line-range.ts';
import { err, ok, type Result } from '../result.ts';
import type { Side } from '../side.tiny.ts';

export type MalformedLinesProblem =
	/** Nothing between two commas, or nothing at all. */
	| 'empty'
	/** Not `+N`, `-N`, `+N..+M` or `-N..-M`. */
	| 'unreadable'
	/** A range that starts on one side and ends on the other, such as `+3..-5`. */
	| 'mixed-sides'
	/** A range that ends before it starts, or a line number below 1. */
	| 'bad-range';

export interface MalformedLines {
	readonly kind: 'MalformedLines';
	readonly text: string;
	/** The comma-separated part that could not be read. */
	readonly part: string;
	readonly problem: MalformedLinesProblem;
}

const PART = /^([+-])(\d+)(?:\s*\.\.\s*([+-])?(\d+))?$/;

/** Reads `+40..+62,-38..-45` into line ranges, in the order written. */
export function parseLineSpec(text: string): Result<readonly LineRange[], MalformedLines> {
	const ranges: LineRange[] = [];
	for (const raw of text.split(',')) {
		const part = raw.trim();
		const fail = (problem: MalformedLinesProblem): Result<never, MalformedLines> =>
			err({ kind: 'MalformedLines', text, part, problem });
		if (part === '') return fail('empty');
		const match = PART.exec(part);
		if (match === null) return fail('unreadable');
		const [, sign, first, endSign, last] = match;
		if (endSign !== undefined && endSign !== sign) return fail('mixed-sides');
		const side: Side = sign === '+' ? 'new' : 'old';
		const range = parseLineRange(side, Number(first), Number(last ?? first));
		if (!range.ok) return fail('bad-range');
		ranges.push(range.value);
	}
	return ok(ranges);
}
