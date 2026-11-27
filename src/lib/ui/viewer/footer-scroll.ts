/**
 * Bringing something into view inside the draft's footer (`OverallReview.svelte`),
 * whose body scrolls within itself: only that body is scrolled, never the
 * page, which keeps clear of the footer with its scroll padding and would
 * otherwise move the diff behind it.
 */

/** The attribute that marks the footer's scrolling body. */
export const FOOTER_BODY = 'data-footer-body';

/**
 * Scrolls the footer's body so `element` is in it, as little as it takes, its
 * top first when it is taller than the body. Outside the footer, the nearest
 * scrolling the browser does.
 */
export function revealInFooter(element: Element): void {
	const body = element.closest(`[${FOOTER_BODY}]`);
	if (!(body instanceof HTMLElement)) {
		element.scrollIntoView({ block: 'nearest' });
		return;
	}
	const box = element.getBoundingClientRect();
	const view = body.getBoundingClientRect();
	if (box.bottom > view.bottom) {
		body.scrollTop += Math.min(box.bottom - view.bottom, box.top - view.top);
	} else if (box.top < view.top) {
		body.scrollTop -= view.top - box.top;
	}
}
