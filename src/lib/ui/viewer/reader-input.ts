/**
 * Telling the reader's own moving of the page from the page's: a wheel, a
 * touch, a key or a press of the pointer, as on the scroll bar, is the reader's.
 * The page's own scrolling, `scrollIntoView` and `scrollTo`, fires only
 * `scroll` events, which are not listened for, so it is never taken for the
 * reader's.
 */

/** The events by which a reader moves the page themselves. */
export const READER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * Calls `moved` once, the first time the reader moves the page by their own
 * input on `target` (the window), leaving out input `counts` says is no moving
 * away; the function returned stops listening.
 */
export function whenReaderMoves(
	target: EventTarget,
	moved: () => void,
	counts: (input: Event) => boolean = () => true
): () => void {
	const options = { capture: true, passive: true } as const;
	const stop = (): void => {
		for (const type of READER_INPUT) target.removeEventListener(type, heard, options);
	};
	const heard = (input: Event): void => {
		if (!counts(input)) return;
		stop();
		moved();
	};
	for (const type of READER_INPUT) target.addEventListener(type, heard, options);
	return stop;
}
