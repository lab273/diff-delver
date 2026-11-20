/**
 * Which checks for changes a diff's page starts, and which answers it takes.
 *
 * The page asks whether its diff has changed when it opens, when the person
 * comes back to it (which can fire both `focus` and `visibilitychange`), and
 * now and then. A check in the background is not started while another is under
 * way, so they never pile up. A check the page needs (it shows another diff or
 * version, or the diff was reopened) always starts, and answers to any earlier
 * check are dropped: an answer is taken only from the latest check, and only
 * while the page still shows the diff and version it was asked for, so a slow
 * answer never puts an out-of-date notice over a newer version. A check whose
 * answer has not come after `CHECK_GIVES_UP_AFTER` is no longer under way, so a
 * request that never returns cannot stop the checks that follow.
 */
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { millisecondsOf, type Milliseconds } from '#lib/core/milliseconds.tiny.ts';

/** How long a check may go unanswered before the next may start: as long as between looks. */
export const CHECK_GIVES_UP_AFTER: Milliseconds = millisecondsOf(60_000);

/** Runs something later; the page's is the browser's, a test's is fired by hand. */
export interface Timer {
	/** Runs `then` after `ms`; the function it returns stops it. */
	after(ms: Milliseconds, then: () => void): () => void;
}

/** The browser's timer. */
export const browserTimer: Timer = {
	after(ms, then) {
		const id = setTimeout(then, ms);
		return () => {
			clearTimeout(id);
		};
	}
};

/** What the page shows: a diff, and its version once loaded. */
export interface Shown {
	readonly id: ReportId;
	readonly version: RevisionNumber | undefined;
}

/** One check, from when it starts to when its answer comes. Only its own `ChangeChecks` reads it. */
export interface CheckTicket {
	readonly shown: Shown;
}

export class ChangeChecks {
	readonly #timer: Timer;
	#latest: CheckTicket | undefined;
	/** The checks under way, each with what stops its time limit. */
	readonly #underWay = new Map<CheckTicket, () => void>();

	constructor(timer: Timer = browserTimer) {
		this.#timer = timer;
	}

	/** Starts a check of what is shown; in the background, only when none is under way. */
	start(shown: Shown, background: boolean): CheckTicket | undefined {
		if (background && this.#underWay.size > 0) return undefined;
		const ticket: CheckTicket = { shown };
		this.#latest = ticket;
		this.#underWay.set(
			ticket,
			this.#timer.after(CHECK_GIVES_UP_AFTER, () => {
				this.#underWay.delete(ticket);
			})
		);
		return ticket;
	}

	/** Ends a check; whether its answer is for what the page shows now and no later check began. */
	finish(ticket: CheckTicket, now: Shown): boolean {
		this.#underWay.get(ticket)?.();
		this.#underWay.delete(ticket);
		return (
			ticket === this.#latest && ticket.shown.id === now.id && ticket.shown.version === now.version
		);
	}
}
