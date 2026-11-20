/**
 * The agent-facing form of line ranges: `+40..+62,-38..-45`. `+` is the new
 * side, `-` the old side; a single line is `+40`. These are exactly the labels the
 * agent-facing diff text puts on changed lines. A file's file-level unit has the
 * label `file`, which may stand among the ranges: `file,+40..+62`.
 */
import { formatLineRanges, parseLineRange, type LineRange } from '../line-range.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
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

/** The label of a file's file-level unit, in the agent text and in `lines`. */
export const FILE_UNIT_LABEL = 'file';

/** What a `lines` value names: line ranges, and perhaps the file-level unit. */
export interface UnitSpec {
	readonly ranges: readonly LineRange[];
	/** Whether `file` was among the parts. */
	readonly file: boolean;
}

/** Reads `+40..+62,-38..-45` into line ranges, in the order written. */
export function parseLineSpec(text: string): Result<readonly LineRange[], MalformedLines> {
	return parseParts(text, text);
}

/** Reads `file,+40..+62,-38..-45`: line ranges in the order written, and whether `file` is there. */
export function parseUnitSpec(text: string): Result<UnitSpec, MalformedLines> {
	const parts = text.split(',');
	const rest = parts.filter((raw) => raw.trim() !== FILE_UNIT_LABEL);
	const file = rest.length < parts.length;
	if (file && rest.length === 0) return ok({ ranges: [], file });
	const ranges = parseParts(rest.join(','), text);
	return ranges.ok ? ok({ ranges: ranges.value, file }) : ranges;
}

/** The `lines` value for some units of one file: `file,+40..+62`. */
export function formatUnitSpec(spec: UnitSpec): TextForAgent {
	const ranges = formatLineRanges(spec.ranges);
	if (!spec.file) return ranges;
	return textForAgent(spec.ranges.length === 0 ? FILE_UNIT_LABEL : `${FILE_UNIT_LABEL},${ranges}`);
}

/** Reads the ranges in `text`; a problem names `written`, the whole value the agent sent. */
function parseParts(text: string, written: string): Result<readonly LineRange[], MalformedLines> {
	const ranges: LineRange[] = [];
	for (const raw of text.split(',')) {
		const part = raw.trim();
		const fail = (problem: MalformedLinesProblem): Result<never, MalformedLines> =>
			err({ kind: 'MalformedLines', text: written, part, problem });
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
