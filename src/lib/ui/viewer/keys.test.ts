import { describe, expect, it } from 'vitest';
import { isFindKey, SHORTCUTS, shortcutOf, type KeyPress } from './keys.ts';

function press(
	key: string,
	target: KeyPress['target'] = { tagName: 'BUTTON' },
	held = {}
): KeyPress {
	return { key, ctrlKey: false, altKey: false, metaKey: false, target, ...held };
}

describe('the diff page’s shortcuts', () => {
	it('maps the keys people know to what the page does', () => {
		expect(shortcutOf(press('n'))).toBe('next-unread');
		expect(shortcutOf(press('j'))).toBe('next-part');
		expect(shortcutOf(press(']'))).toBe('next-part');
		expect(shortcutOf(press('k'))).toBe('previous-part');
		expect(shortcutOf(press('r'))).toBe('toggle-reviewed');
		expect(shortcutOf(press('s'))).toBe('side-by-side');
		expect(shortcutOf(press('w'))).toBe('white-space');
		expect(shortcutOf(press('?'))).toBe('help');
		expect(shortcutOf(press('/'))).toBe('search');
		expect(shortcutOf(press('x'))).toBeUndefined();
		// On a checkbox a letter types nothing, so the shortcut works there too.
		expect(shortcutOf(press('r', { tagName: 'INPUT', type: 'checkbox' }))).toBe('toggle-reviewed');
	});

	it('never fires while typing in a field, or with Control, Alt or Meta held', () => {
		expect(shortcutOf(press('n', { tagName: 'INPUT', type: 'text' }))).toBeUndefined();
		expect(shortcutOf(press('n', { tagName: 'INPUT' }))).toBeUndefined();
		expect(shortcutOf(press('n', { tagName: 'TEXTAREA' }))).toBeUndefined();
		expect(shortcutOf(press('n', { tagName: 'SELECT' }))).toBeUndefined();
		expect(shortcutOf(press('n', { tagName: 'DIV', isContentEditable: true }))).toBeUndefined();
		expect(shortcutOf(press('r', undefined, { ctrlKey: true }))).toBeUndefined();
		expect(shortcutOf(press('r', undefined, { metaKey: true }))).toBeUndefined();
		expect(shortcutOf(press('r', undefined, { altKey: true }))).toBeUndefined();
	});

	it('gives every key one action', () => {
		const keys = SHORTCUTS.flatMap((s) => s.keys);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('opens the diff’s search for the browser’s find key, and leaves it to the browser in the search box', () => {
		expect(isFindKey(press('f', undefined, { ctrlKey: true }), false)).toBe(true);
		expect(isFindKey(press('f', undefined, { metaKey: true }), false)).toBe(true);
		expect(isFindKey(press('F', undefined, { ctrlKey: true }), false)).toBe(true);
		expect(isFindKey(press('f', undefined, { ctrlKey: true }), true)).toBe(false);
		expect(isFindKey(press('f'), false)).toBe(false);
		expect(isFindKey(press('f', undefined, { ctrlKey: true, altKey: true }), false)).toBe(false);
		expect(isFindKey(press('g', undefined, { ctrlKey: true }), false)).toBe(false);
	});
});
