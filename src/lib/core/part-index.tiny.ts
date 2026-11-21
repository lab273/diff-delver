import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A part's place in a diff page's reading order: 0 for the first. */
export type PartIndex = Tiny<number, 'PartIndex'>;

export interface InvalidPartIndex {
	readonly kind: 'InvalidPartIndex';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parsePartIndex(value: number): Result<PartIndex, InvalidPartIndex> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidPartIndex', value });
	return ok(value as PartIndex);
}

/**
 * The place of a part the code has just counted, such as an index into the
 * page's list of parts. Such a place is always a whole number of zero or more,
 * so a failure is a bug.
 */
export function partIndexOf(value: number): PartIndex {
	const parsed = parsePartIndex(value);
	if (!parsed.ok) throw new RangeError(`Not a place in reading order: ${String(value)}`);
	return parsed.value;
}
