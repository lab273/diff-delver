import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A moment in time: whole milliseconds since 1970-01-01T00:00:00Z, as
 * `Date.now()` gives them. Read only from a `Clock` (`clock.ts`), so tests and
 * journeys decide what time it is.
 */
export type Timestamp = Tiny<number, 'Timestamp'>;

export interface InvalidTimestamp {
	readonly kind: 'InvalidTimestamp';
	readonly value: number;
}

/** Accepts a whole number of zero or more. */
export function parseTimestamp(value: number): Result<Timestamp, InvalidTimestamp> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidTimestamp', value });
	return ok(value as Timestamp);
}

/** How many milliseconds `later` is after `earlier`; negative when it is before. */
export function millisecondsBetween(earlier: Timestamp, later: Timestamp): number {
	return later - earlier;
}
