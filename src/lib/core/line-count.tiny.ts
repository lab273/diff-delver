import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A count of lines, or a position before the first line: zero or a positive whole
 * number. A hunk's start and length are line counts, because git writes a start of
 * 0 for a hunk on an empty side.
 */
export type LineCount = Tiny<number, 'LineCount'>;

export interface InvalidLineCount {
	readonly kind: 'InvalidLineCount';
	readonly value: number;
}

export function parseLineCount(value: number): Result<LineCount, InvalidLineCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidLineCount', value });
	return ok(value as LineCount);
}

/** A count of lines known to be valid, such as a constant; throws otherwise. */
export function lineCountOf(value: number): LineCount {
	const parsed = parseLineCount(value);
	if (!parsed.ok) throw new RangeError(`Not a count of lines: ${String(value)}`);
	return parsed.value;
}
