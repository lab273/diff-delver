/**
 * How often the daemon asks the system to open a window that may write the
 * person's drafts (DESIGN 9). Anything let in by a link can ask for one, and
 * each asking starts a program, so one is opened at most every few seconds,
 * by the daemon's clock, whoever asks: a page, or an agent's new report. What
 * is held back is only said so; asking again a moment later works.
 */
import type { Clock } from '../clock.ts';
import { timeBetween, type Timestamp } from '../timestamp.tiny.ts';

/** The least time between two windows: five seconds. */
export const REVIEW_WINDOW_EVERY_MS = 5_000;

/**
 * What became of asking for a window: the system was asked and took it, there
 * is no browser to ask (as on a machine with no screen), or one was asked for
 * too short a while ago.
 */
export type ReviewWindowOutcome = 'opened' | 'no-browser' | 'too-soon';

export interface ReviewWindows {
	/** Whether a window may be asked for now; saying yes counts as asking. */
	mayAsk(): boolean;
}

export function reviewWindows(clock: Clock): ReviewWindows {
	let last: Timestamp | undefined;
	return {
		mayAsk() {
			const now = clock.now();
			if (last !== undefined && timeBetween(last, now) < REVIEW_WINDOW_EVERY_MS) return false;
			last = now;
			return true;
		}
	};
}
