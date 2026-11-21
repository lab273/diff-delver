import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** How many times searched text was found: zero or more. */
export type MatchCount = Tiny<number, 'MatchCount'>;

export interface InvalidMatchCount {
	readonly kind: 'InvalidMatchCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseMatchCount(value: number): Result<MatchCount, InvalidMatchCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidMatchCount', value });
	return ok(value as MatchCount);
}

/** A count the code has just made by counting. A failure is a bug. */
export function matchCountOf(value: number): MatchCount {
	const parsed = parseMatchCount(value);
	if (!parsed.ok) throw new RangeError(`Not a count of matches: ${String(value)}`);
	return parsed.value;
}
