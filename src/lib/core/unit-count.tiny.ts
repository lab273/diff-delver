import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of change units (DESIGN 4.1): changed lines, or file-level units. Zero or more. */
export type UnitCount = Tiny<number, 'UnitCount'>;

export interface InvalidUnitCount {
	readonly kind: 'InvalidUnitCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseUnitCount(value: number): Result<UnitCount, InvalidUnitCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidUnitCount', value });
	return ok(value as UnitCount);
}

export const NO_UNITS = 0 as UnitCount;

/** The one unit of a file whose change has no lines. */
export const ONE_UNIT = 1 as UnitCount;

/**
 * The count of a set the code has just measured, such as a `RangeSet`'s size.
 * Such a size is always a whole number of zero or more, so a failure is a bug.
 */
export function unitCountOf(size: number): UnitCount {
	const parsed = parseUnitCount(size);
	if (!parsed.ok) throw new RangeError(`Not a count of units: ${size}`);
	return parsed.value;
}

/** The sum of counts. */
export function addUnits(...counts: readonly UnitCount[]): UnitCount {
	return counts.reduce<number>((sum, count) => sum + count, 0) as UnitCount;
}
