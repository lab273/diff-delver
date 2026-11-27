/**
 * Moving the page to a place, eased (DESIGN 8.1): a short, quiet scroll so
 * the reader sees where they went, and a jump when they prefer reduced motion.
 * Every move the page makes on its own goes through one `PageMover`, so a new
 * move takes over from one under way and only one runs at a time.
 *
 * Where a move goes is worked out again every frame, from the layout as it is
 * then: the page grows while parts above the destination fetch their lines,
 * and the move follows. Each frame covers its share of what is left, not of
 * the whole way, so a scroll the page makes meanwhile to keep the reader's
 * place (`window.scrollBy`) never throws it off. The reader's own input (a
 * wheel, a touch, a key, a press, `reader-input.ts`) stops it where it is; the
 * frames it scrolls fire only `scroll` events, never taken for the reader's.
 */
import { whenReaderMoves } from './reader-input.ts';

/** How long a move takes, in milliseconds: brief, so it never holds the reader up. */
export const EASE_MS = 240;

/** Moves fewer pixels than this are made at once. */
const TOO_SHORT_TO_EASE = 2;

/** Whether the person prefers reduced motion, when moves jump. */
export function prefersReducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** How far along a move is, from 0 to 1, for how much of its time has passed: quick, then settling. */
export function easeOut(time: number): number {
	const left = 1 - Math.min(1, Math.max(0, time));
	return 1 - left * left * left;
}

/** Where the window's scroll is to be, worked out now; undefined when where it was going is gone. */
export type ScrollTarget = () => number | undefined;

/** A move under way, or made. */
export interface Move {
	/** Whether it is still easing: until then its frames place the page, not anyone else's. */
	readonly running: boolean;
	/** Ends when the move has arrived or was stopped. */
	readonly done: Promise<void>;
}

interface Run extends Move {
	running: boolean;
	stop(): void;
	/** Puts the page where the move is going, at once, and ends it. */
	finish(): void;
}

export class PageMover {
	#run: Run | undefined;

	/** Whether a move is easing now. */
	get moving(): boolean {
		return this.#run?.running === true;
	}

	/**
	 * Moves the window's scroll, or with `scroller` another's, to `target`,
	 * eased, or at once with reduced motion.
	 */
	move(target: ScrollTarget, scroller: Scroller = WINDOW): Move {
		this.#run?.stop();
		const to = target();
		if (to === undefined) return { running: false, done: Promise.resolve() };
		if (prefersReducedMotion() || Math.abs(to - scroller.at()) < TOO_SHORT_TO_EASE) {
			scroller.to(to);
			return { running: false, done: Promise.resolve() };
		}
		let end = (): void => {};
		const done = new Promise<void>((resolve) => {
			end = resolve;
		});
		let frame = 0;
		let start: number | undefined;
		let covered = 0;
		const run: Run = {
			running: true,
			done,
			stop: () => {
				if (!run.running) return;
				run.running = false;
				cancelAnimationFrame(frame);
				stopListening();
				if (this.#run === run) this.#run = undefined;
				end();
			},
			finish: () => {
				const there = target();
				run.stop();
				if (there !== undefined) scroller.to(there);
			}
		};
		const stopListening = whenReaderMoves(window, () => {
			run.stop();
		});
		const step = (now: number): void => {
			start ??= now;
			const there = target();
			if (there === undefined) {
				run.stop();
				return;
			}
			const along = easeOut((now - start) / EASE_MS);
			if (along >= 1) {
				scroller.to(there);
				run.stop();
				return;
			}
			// This frame's share of what is left, so the page's own scrolling meanwhile is kept.
			const share = (along - covered) / (1 - covered);
			covered = along;
			scroller.to(scroller.at() + (there - scroller.at()) * share);
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		this.#run = run;
		return run;
	}

	/**
	 * Scrolls whatever holds an element, the rail or the page, only as far as
	 * it takes to show it, as a move.
	 */
	reveal(element: Element): Move {
		const scroller = scrollerOf(element);
		return this.move(() => {
			if (!element.isConnected) return undefined;
			const view = scroller.view();
			const box = element.getBoundingClientRect();
			const at = scroller.at();
			if (box.top < view.top) return at + box.top - view.top;
			if (box.bottom > view.bottom)
				return at + Math.min(box.bottom - view.bottom, box.top - view.top);
			return at;
		}, scroller);
	}

	/**
	 * Ends a move under way where it was going, at once: before the page measures
	 * where the reader is, so it measures where they are going.
	 */
	settle(): void {
		this.#run?.finish();
	}

	/** Stops a move under way where it is. */
	stop(): void {
		this.#run?.stop();
	}
}

/** What a move scrolls: the window, or an element that scrolls on its own, such as the rail. */
export interface Scroller {
	at(): number;
	to(y: number): void;
	/** The part of the screen it shows, top and bottom, as `getBoundingClientRect` gives them. */
	view(): { top: number; bottom: number };
}

const WINDOW: Scroller = {
	at: () => window.scrollY,
	to: (y) => {
		window.scrollTo(0, y);
	},
	view: () => ({ top: 0, bottom: window.innerHeight })
};

/** The nearest element holding `element` that scrolls on its own, or the window. */
function scrollerOf(element: Element): Scroller {
	for (let at = element.parentElement; at !== null; at = at.parentElement) {
		const overflow = getComputedStyle(at).overflowY;
		if ((overflow === 'auto' || overflow === 'scroll') && at.scrollHeight > at.clientHeight) {
			const box = at;
			return {
				at: () => box.scrollTop,
				to: (y) => {
					box.scrollTop = y;
				},
				view: () => {
					const { top, bottom } = box.getBoundingClientRect();
					return { top, bottom };
				}
			};
		}
	}
	return WINDOW;
}
