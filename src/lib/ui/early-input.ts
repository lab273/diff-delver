/**
 * Keys a person pressed before the page could act on them (DESIGN 1.1
 * commitment 6, "usable at once").
 *
 * The daemon sends each page drawn, so it can be read before its scripts have
 * run; on a slow or busy machine that can take a moment, and a key pressed in
 * it would be lost although the page looks ready. A small script in the page's
 * head (`keepEarlyKeys`, written into `src/app.html` by `src/hooks.server.ts`)
 * keeps those presses that only the page's scripts can act on, and leaves
 * every other key to the browser, untouched: Tab, scrolling, typing in a field,
 * keys held with Control, Alt or Meta, and anything the page has no use for.
 * Once the page is ready the layout calls `pageReady`: it marks the page ready
 * (`data-ready` on the root element, which is also what the journeys wait for
 * before they press a key) and does, in order, what each kept press asked for.
 *
 * Which press is kept, and what it then does, is `earlyKeyOf` and `replayOf`,
 * pure, so the rule is tested without a browser:
 *
 * - a key the page has a shortcut for (on a diff's page only) is kept, and
 *   then handed to the page's shortcuts where focus is;
 * - Enter or Space on a button, Enter on a link, and Space on a tick box or a
 *   radio button are kept, and then do what they would have done: the element
 *   they were pressed on is clicked, once (Enter does not tick a tick box);
 * - nothing kept is done on another page than the one it was pressed on, done
 *   twice, or sent into a field the focus has since moved to.
 *
 * If the page's scripts fail to start, or have not said they are ready a few
 * seconds on (`GIVE_UP_AFTER_MS`), the keeping stops, what was kept is let go,
 * and the keyboard is the browser's again, so a link still works without
 * scripts.
 */

import { inField, type KeyPress } from './viewer/keys.ts';

/** What `inField` needs to know of an element. */
function fieldOf(element: Element | null): KeyPress['target'] {
	if (element === null) return null;
	return {
		tagName: element.tagName,
		...(element instanceof HTMLInputElement ? { type: element.type } : {}),
		isContentEditable: element instanceof HTMLElement && element.isContentEditable
	};
}

/** The attribute on the root element that says the page can act on what a person does. */
export const READY_ATTRIBUTE = 'data-ready';

/** How long keys are kept, at most, before the keyboard is handed back to the browser. */
export const GIVE_UP_AFTER_MS = 5_000;

/** The element a key was pressed in, as far as keeping it cares. */
export interface EarlyTarget {
	readonly tagName: string;
	/** An input's type; empty for any other element. */
	readonly type: string;
	/** Whether it is a link that goes somewhere. */
	readonly hasHref: boolean;
	readonly isContentEditable: boolean;
}

/** A key press, as the page's head sees it before its scripts have run. */
export interface EarlyPress {
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly target: EarlyTarget | null;
}

/**
 * What to do with a key pressed before the page is ready: `shortcut`, keep it
 * for the page's shortcuts; `activate`, keep it to click the element it was
 * pressed on; `leave`, let the browser have it as if nothing were listening.
 *
 * Self-contained, with nothing from outside its body, because the page's head
 * runs it as written here, before any module has loaded.
 */
export function earlyKeyOf(
	press: EarlyPress,
	shortcutKeys: readonly string[]
): 'shortcut' | 'activate' | 'leave' {
	if (press.ctrlKey || press.altKey || press.metaKey) return 'leave';
	const target = press.target;
	const tag = target === null ? '' : target.tagName.toLowerCase();
	const type = target === null ? '' : target.type.toLowerCase();
	let kind: 'field' | 'button' | 'toggle' | 'link' | 'other' = 'other';
	if (target !== null && target.isContentEditable) kind = 'field';
	else if (tag === 'textarea' || tag === 'select') kind = 'field';
	else if (tag === 'input') {
		if (type === 'button' || type === 'submit' || type === 'reset') kind = 'button';
		else if (type === 'checkbox' || type === 'radio') kind = 'toggle';
		else kind = 'field';
	} else if (tag === 'button') kind = 'button';
	else if (tag === 'a' && target !== null && target.hasHref) kind = 'link';
	if (kind === 'field') return 'leave';
	const enter = press.key === 'Enter';
	const space = press.key === ' ';
	if (kind === 'button' && (enter || space)) return 'activate';
	if (kind === 'toggle' && space) return 'activate';
	if (kind === 'link' && enter) return 'activate';
	if (shortcutKeys.includes(press.key)) return 'shortcut';
	return 'leave';
}

/** A press kept until the page was ready. */
export interface KeptPress {
	readonly key: string;
	readonly shiftKey: boolean;
	readonly does: 'shortcut' | 'activate';
	/** The address of the page it was pressed on. */
	readonly page: string;
}

/** Where the page is when it is ready to do a kept press. */
export interface ReplayContext {
	/** The page's address now. */
	readonly page: string;
	/** Whether the element the press was made on is still on the page. */
	readonly targetThere: boolean;
	/** Whether the focus is now in a field, where a key would be typed. */
	readonly focusInField: boolean;
}

/** What a kept press does once the page is ready: click where it was pressed, press the key where focus is, or nothing. */
export function replayOf(press: KeptPress, now: ReplayContext): 'click' | 'key' | 'drop' {
	if (press.page !== now.page || now.focusInField) return 'drop';
	switch (press.does) {
		case 'activate':
			return now.targetThere ? 'click' : 'drop';
		case 'shortcut':
			return 'key';
	}
}

/**
 * The page head's script, run as written before anything else on the page:
 * keeps the presses `rule` (`earlyKeyOf`) says to, and lets go of them and
 * hands the keyboard back to the browser when the page fails to start or has
 * not started after `giveUpAfterMs`. Self-contained, like `earlyKeyOf`.
 */
export function keepEarlyKeys(
	rule: typeof earlyKeyOf,
	shortcutKeys: readonly string[],
	readyAttribute: string,
	giveUpAfterMs: number
): void {
	const kept: { press: KeptPress; target: Element | null }[] = [];
	const keep = (event: KeyboardEvent): void => {
		if (document.documentElement.hasAttribute(readyAttribute)) return;
		const at = event.target instanceof Element ? event.target : null;
		const does = rule(
			{
				key: event.key,
				ctrlKey: event.ctrlKey,
				altKey: event.altKey,
				metaKey: event.metaKey,
				target:
					at === null
						? null
						: {
								tagName: at.tagName,
								type: at instanceof HTMLInputElement ? at.type : '',
								hasHref: at instanceof HTMLAnchorElement && at.hasAttribute('href'),
								isContentEditable: at instanceof HTMLElement && at.isContentEditable
							}
			},
			shortcutKeys
		);
		if (does === 'leave') return;
		event.preventDefault();
		event.stopImmediatePropagation();
		kept.push({
			press: { key: event.key, shiftKey: event.shiftKey, does, page: location.href },
			target: at
		});
	};
	const stop = (): void => {
		removeEventListener('keydown', keep, true);
	};
	const giveUp = (): void => {
		stop();
		kept.length = 0;
	};
	addEventListener('keydown', keep, true);
	addEventListener('error', giveUp);
	addEventListener('unhandledrejection', giveUp);
	const timer = setTimeout(giveUp, giveUpAfterMs);
	window.diffDelverEarlyInput = {
		take: () => {
			stop();
			clearTimeout(timer);
			removeEventListener('error', giveUp);
			removeEventListener('unhandledrejection', giveUp);
			return kept.splice(0);
		}
	};
}

/** Marks the page ready and does what the keys pressed before it was asked for. */
export function pageReady(): void {
	const kept = window.diffDelverEarlyInput?.take() ?? [];
	document.documentElement.setAttribute(READY_ATTRIBUTE, '');
	for (const { press, target } of kept) {
		const at = document.activeElement ?? document.body;
		const does = replayOf(press, {
			page: location.href,
			targetThere: target?.isConnected === true,
			focusInField: inField(fieldOf(document.activeElement))
		});
		switch (does) {
			case 'drop':
				break;
			case 'click':
				if (target instanceof HTMLElement) target.click();
				break;
			case 'key':
				at.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: press.key,
						shiftKey: press.shiftKey,
						bubbles: true,
						cancelable: true
					})
				);
				break;
		}
	}
}
