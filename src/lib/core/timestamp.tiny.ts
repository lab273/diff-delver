import { millisecondsOf, type Milliseconds } from './milliseconds.tiny.ts';
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

/** How long after `earlier` `later` is; zero when it is not after it, as when a clock was set back. */
export function timeBetween(earlier: Timestamp, later: Timestamp): Milliseconds {
	return millisecondsOf(Math.max(0, later - earlier));
}
