import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of slices (DESIGN 4.3): one file's part within one group. Zero or more. */
export type SliceCount = Tiny<number, 'SliceCount'>;

export interface InvalidSliceCount {
	readonly kind: 'InvalidSliceCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseSliceCount(value: number): Result<SliceCount, InvalidSliceCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidSliceCount', value });
	return ok(value as SliceCount);
}

/** A count of slices the code has just made. A failure is a bug. */
export function sliceCountOf(value: number): SliceCount {
	const parsed = parseSliceCount(value);
	if (!parsed.ok) throw new RangeError(`Not a count of slices: ${value}`);
	return parsed.value;
}
