/**
 * Keys a person pressed before the page could act on them (DESIGN 1.1
 * commitment 6, "usable at once").
 *
 * The daemon sends each page drawn, so it can be read before its scripts have
 * run; on a slow or busy machine that can take a moment, and a key pressed in
 * it would be lost although the page looks ready. A small script in
 * `src/app.html` keeps those presses (all but Tab and typing in a field, which
 * the browser handles itself), and once the page is ready the layout calls
 * `pageReady`: it marks the page ready (`data-ready` on the root element,
 * which is also what the journeys wait for before they press a key) and hands
 * the kept presses to the page, in order, where focus is now. Enter on a
 * button or link and Space on a button or tick box do what they would have
 * done; any other key goes to the page's own shortcuts.
 */

/** The attribute on the root element that says the page can act on what a person does. */
export const READY_ATTRIBUTE = 'data-ready';

function activates(element: Element, key: string): boolean {
	const isButton =
		element instanceof HTMLButtonElement ||
		(element instanceof HTMLInputElement && ['checkbox', 'radio', 'button'].includes(element.type));
	if (key === ' ') return isButton;
	if (key === 'Enter') return isButton || element instanceof HTMLAnchorElement;
	return false;
}

/** Marks the page ready and hands it the keys pressed before it was. */
export function pageReady(): void {
	const early = window.diffDelverEarlyInput;
	early?.stop();
	document.documentElement.setAttribute(READY_ATTRIBUTE, '');
	for (const press of early?.kept ?? []) {
		const at = document.activeElement ?? document.body;
		if (activates(at, press.key) && at instanceof HTMLElement) {
			at.click();
			continue;
		}
		at.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: press.key,
				shiftKey: press.shiftKey,
				bubbles: true,
				cancelable: true
			})
		);
	}
}
