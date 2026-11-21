/**
 * Which keys pressed before a page is ready are kept, and what each then does:
 * only what the page itself would have handled, done once, on the page it was
 * pressed on, never into a field. The browser half is tested in
 * tests/support/journey.spec.ts, on a page slow to start.
 */
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
	earlyKeyOf,
	keepEarlyKeys,
	replayOf,
	type EarlyPress,
	type EarlyTarget,
	type KeptPress
} from './early-input.ts';
import { SHORTCUTS } from './viewer/keys.ts';

const SHORTCUT_KEYS = SHORTCUTS.flatMap((s) => s.keys);

function element(tagName: string, more: Partial<EarlyTarget> = {}): EarlyTarget {
	return { tagName, type: '', hasHref: false, isContentEditable: false, ...more };
}

const BODY = element('BODY');
const BUTTON = element('BUTTON');
const LINK = element('A', { hasHref: true });
const ANCHOR = element('A');
const CHECKBOX = element('INPUT', { type: 'checkbox' });
const RADIO = element('INPUT', { type: 'radio' });
const TEXT = element('INPUT', { type: 'text' });
const SUBMIT = element('INPUT', { type: 'submit' });

function press(
	key: string,
	target: EarlyTarget | null,
	more: Partial<EarlyPress> = {}
): EarlyPress {
	return { key, ctrlKey: false, altKey: false, metaKey: false, target, ...more };
}

describe('which keys pressed before the page is ready are kept', () => {
	it('keeps the keys the page has shortcuts for, where it has them', () => {
		for (const key of SHORTCUT_KEYS) {
			expect(earlyKeyOf(press(key, BODY), SHORTCUT_KEYS)).toBe('shortcut');
			expect(earlyKeyOf(press(key, CHECKBOX), SHORTCUT_KEYS)).toBe('shortcut');
			expect(earlyKeyOf(press(key, BODY), [])).toBe('leave');
		}
	});

	it('keeps Enter and Space on a button, Enter on a link, and Space on a tick box', () => {
		for (const target of [BUTTON, SUBMIT]) {
			expect(earlyKeyOf(press('Enter', target), [])).toBe('activate');
			expect(earlyKeyOf(press(' ', target), [])).toBe('activate');
		}
		expect(earlyKeyOf(press('Enter', LINK), [])).toBe('activate');
		expect(earlyKeyOf(press(' ', CHECKBOX), [])).toBe('activate');
		expect(earlyKeyOf(press(' ', RADIO), [])).toBe('activate');
	});

	it('leaves what the browser does itself: Enter on a tick box, Space on a link, scrolling, Tab', () => {
		expect(earlyKeyOf(press('Enter', CHECKBOX), SHORTCUT_KEYS)).toBe('leave');
		expect(earlyKeyOf(press(' ', LINK), SHORTCUT_KEYS)).toBe('leave');
		expect(earlyKeyOf(press('Enter', ANCHOR), SHORTCUT_KEYS)).toBe('leave');
		for (const key of [' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', 'Tab']) {
			expect(earlyKeyOf(press(key, BODY), SHORTCUT_KEYS)).toBe('leave');
			expect(earlyKeyOf(press(key, null), SHORTCUT_KEYS)).toBe('leave');
		}
		expect(earlyKeyOf(press('ArrowDown', BUTTON), SHORTCUT_KEYS)).toBe('leave');
	});

	it('leaves typing in a field and keys held with Control, Alt or Meta', () => {
		for (const target of [
			TEXT,
			element('TEXTAREA'),
			element('SELECT'),
			element('DIV', { isContentEditable: true })
		]) {
			for (const key of ['n', 'Enter', ' ']) {
				expect(earlyKeyOf(press(key, target), SHORTCUT_KEYS)).toBe('leave');
			}
		}
		for (const held of ['ctrlKey', 'altKey', 'metaKey'] as const) {
			expect(earlyKeyOf(press('n', BODY, { [held]: true }), SHORTCUT_KEYS)).toBe('leave');
			expect(earlyKeyOf(press('Enter', BUTTON, { [held]: true }), SHORTCUT_KEYS)).toBe('leave');
		}
	});

	it('is the same rule when run from its own text, as the page’s head runs it', () => {
		// The head runs the function as written, with nothing from this module around it.
		const rule = new Script(`(${earlyKeyOf.toString()})(given, keys)`);
		for (const target of [BODY, BUTTON, LINK, ANCHOR, CHECKBOX, RADIO, TEXT, SUBMIT, null]) {
			for (const key of ['n', '?', 'Enter', ' ', 'ArrowDown', 'Tab']) {
				const given = press(key, target);
				const alone: unknown = rule.runInNewContext({ given, keys: SHORTCUT_KEYS });
				expect(alone).toBe(earlyKeyOf(given, SHORTCUT_KEYS));
			}
		}
		expect(() => new Script(`(${keepEarlyKeys.toString()})`)).not.toThrow();
	});
});

describe('what a kept key does once the page is ready', () => {
	const shortcut: KeptPress = { key: 'n', shiftKey: false, does: 'shortcut', page: '/diffs/1' };
	const activate: KeptPress = { key: 'Enter', shiftKey: false, does: 'activate', page: '/diffs/1' };
	const here = { page: '/diffs/1', targetThere: true, focusInField: false };

	it('hands a shortcut to the page, and clicks what Enter or Space was pressed on', () => {
		expect(replayOf(shortcut, here)).toBe('key');
		expect(replayOf(activate, here)).toBe('click');
	});

	it('does nothing on another page, on an element no longer there, or into a field', () => {
		expect(replayOf(shortcut, { ...here, page: '/' })).toBe('drop');
		expect(replayOf(activate, { ...here, page: '/' })).toBe('drop');
		expect(replayOf(activate, { ...here, targetThere: false })).toBe('drop');
		expect(replayOf(shortcut, { ...here, focusInField: true })).toBe('drop');
		expect(replayOf(activate, { ...here, focusInField: true })).toBe('drop');
	});
});
