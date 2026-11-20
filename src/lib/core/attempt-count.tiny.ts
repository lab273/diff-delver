import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** How many times something was tried: a whole number of one or more. */
export type AttemptCount = Tiny<number, 'AttemptCount'>;

export interface InvalidAttemptCount {
	readonly kind: 'InvalidAttemptCount';
	readonly value: number;
}

export function parseAttemptCount(value: number): Result<AttemptCount, InvalidAttemptCount> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidAttemptCount', value });
	return ok(value as AttemptCount);
}

/** One the code has just counted, which cannot be invalid, so a failure is a bug. */
export function attemptCountOf(value: number): AttemptCount {
	const parsed = parseAttemptCount(value);
	if (!parsed.ok) throw new RangeError(`Not a valid AttemptCount: ${String(value)}`);
	return parsed.value;
}
