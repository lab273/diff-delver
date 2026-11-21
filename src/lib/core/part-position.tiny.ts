import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A part's place among one file's parts, counted from 1: the 2 of "part 2 of 3". */
export type PartPosition = Tiny<number, 'PartPosition'>;

export interface InvalidPartPosition {
	readonly kind: 'InvalidPartPosition';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parsePartPosition(value: number): Result<PartPosition, InvalidPartPosition> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidPartPosition', value });
	return ok(value as PartPosition);
}

/** A place the code has just counted. A failure is a bug. */
export function partPositionOf(value: number): PartPosition {
	const parsed = parsePartPosition(value);
	if (!parsed.ok) throw new RangeError(`Not a part's place: ${String(value)}`);
	return parsed.value;
}
