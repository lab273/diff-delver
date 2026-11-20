import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of git objects, such as those a snapshot copied into its store. */
export type ObjectCount = Tiny<number, 'ObjectCount'>;

export interface InvalidObjectCount {
	readonly kind: 'InvalidObjectCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseObjectCount(value: number): Result<ObjectCount, InvalidObjectCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidObjectCount', value });
	return ok(value as ObjectCount);
}

/** The size of a list of objects the code has just made. A failure is a bug. */
export function objectCountOf(size: number): ObjectCount {
	const parsed = parseObjectCount(size);
	if (!parsed.ok) throw new RangeError(`Not a count of objects: ${size}`);
	return parsed.value;
}
