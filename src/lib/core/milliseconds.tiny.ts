import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A length of time in milliseconds: a finite number of zero or more, fractions allowed. */
export type Milliseconds = Tiny<number, 'Milliseconds'>;

export interface InvalidMilliseconds {
	readonly kind: 'InvalidMilliseconds';
	readonly value: number;
}

export function parseMilliseconds(value: number): Result<Milliseconds, InvalidMilliseconds> {
	if (!Number.isFinite(value) || value < 0) return err({ kind: 'InvalidMilliseconds', value });
	return ok(value as Milliseconds);
}

/**
 * A length of time the code has just measured or states as a constant, which is
 * always finite and never negative, so a failure is a bug.
 */
export function millisecondsOf(value: number): Milliseconds {
	const parsed = parseMilliseconds(value);
	if (!parsed.ok) throw new RangeError(`Not a length of time in milliseconds: ${value}`);
	return parsed.value;
}
