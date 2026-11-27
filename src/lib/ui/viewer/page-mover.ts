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

	/** Moves the window's scroll to `target`, eased, or at once with reduced motion. */
	move(target: ScrollTarget): Move {
		this.#run?.stop();
		const to = target();
		if (to === undefined) return { running: false, done: Promise.resolve() };
		if (prefersReducedMotion() || Math.abs(to - window.scrollY) < TOO_SHORT_TO_EASE) {
			window.scrollTo(0, to);
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
				if (there !== undefined) window.scrollTo(0, there);
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
				window.scrollTo(0, there);
				run.stop();
				return;
			}
			// This frame's share of what is left, so the page's own scrolling meanwhile is kept.
			const share = (along - covered) / (1 - covered);
			covered = along;
			window.scrollTo(0, window.scrollY + (there - window.scrollY) * share);
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		this.#run = run;
		return run;
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

/**
 * Scrolls whatever holds an element, the rail or the page, only as far as it
 * takes to show it, smoothly, or at once with reduced motion.
 */
export function revealNearest(element: Element): void {
	element.scrollIntoView({
		block: 'nearest',
		behavior: prefersReducedMotion() ? 'instant' : 'smooth'
	});
}
