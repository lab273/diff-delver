/**
 * Telling the reader's own moving of the page from the page's: a wheel, a
 * touch, a key or a press of the pointer, as on the scroll bar, is the reader's.
 * The page's own scrolling, `scrollIntoView`, `scrollTo` and the frames of a
 * move easing into place (`page-mover.ts`), fires only `scroll` events, which
 * are not listened for, so it is never taken for the reader's. A click on a
 * line, which puts the keyboard there, starts with a press of the pointer, so
 * it is the reader's too.
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

/**
 * What a press keeps doing for itself, never taken for the reader saying
 * where they are: a control, a comment or note under a line, a form.
 */
export const OWN_CONTROLS =
	'button, a, input, textarea, select, label, summary, [contenteditable], [role="button"], form, tr.under';

/** A press of the pointer, as a click on the page reports it. */
export interface Press {
	readonly button: number;
	/** The click's count: 1 for one click, 2 for the second of a double click; 0 for a key's. */
	readonly detail: number;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
}

/**
 * Whether a click only says where the reader is looking, so the keyboard may
 * follow it: one plain click of the main button, with no text selected when it
 * was pressed nor when it ended. A drag that selects text, a double or triple
 * click selecting words, a click that puts a selection away, and a click with
 * Shift, which extends one, are left to the browser.
 */
export function isPlainClick(
	press: Press,
	selectedAtPress: boolean,
	selectedNow: boolean
): boolean {
	return (
		press.button === 0 &&
		press.detail === 1 &&
		!press.shiftKey &&
		!press.altKey &&
		!press.ctrlKey &&
		!press.metaKey &&
		!selectedAtPress &&
		!selectedNow
	);
}

/** Whether the page holds a selection of text, not just a caret. */
export function textSelected(): boolean {
	const selection = window.getSelection();
	return selection !== null && !selection.isCollapsed && selection.toString() !== '';
}

/** The control a press was on, within `boundary`, if it was on one. */
export function ownControlAt(target: EventTarget | null, boundary: Element): Element | undefined {
	const control = target instanceof Element ? target.closest(OWN_CONTROLS) : null;
	return control !== null && boundary.contains(control) ? control : undefined;
}
