/**
 * Where time comes from. Nothing reads the clock directly: the daemon is given a
 * `Clock`, so tests and journeys can say what time it is and screenshots stay
 * the same from run to run (README, "Testing"). The real clock is in
 * `#lib/server/system.ts`.
 */
import { parseTimestamp, type Timestamp } from './timestamp.tiny.ts';

export interface Clock {
	/** The time now. */
	now(): Timestamp;
}

/** A clock for tests and journeys: it says whatever it was last set to. */
export interface SettableClock extends Clock {
	/** Sets the time. */
	set(time: Timestamp): void;
	/** Moves the time on by `milliseconds`, a whole number of zero or more. */
	advance(milliseconds: number): void;
}

/** A clock that starts at `start` and moves only when told to. */
export function settableClock(start: Timestamp): SettableClock {
	let current = start;
	return {
		now: () => current,
		set: (time) => {
			current = time;
		},
		advance: (milliseconds) => {
			const next = parseTimestamp(current + milliseconds);
			if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !next.ok) {
				throw new RangeError(`Cannot move a clock on by ${milliseconds} ms`);
			}
			current = next.value;
		}
	};
}
