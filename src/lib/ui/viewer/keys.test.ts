import { describe, expect, it } from 'vitest';
import { actsOnRepeat, isFindKey, SHORTCUTS, shortcutOf, type KeyPress } from './keys.ts';

function press(
	key: string,
	target: KeyPress['target'] = { tagName: 'BUTTON' },
	held = {}
): KeyPress {
	return { key, ctrlKey: false, altKey: false, metaKey: false, target, ...held };
}

describe('the diff page’s shortcuts', () => {
	it('repeat only to move, while their key is held down', () => {
		expect(actsOnRepeat('next-part')).toBe(true);
		expect(actsOnRepeat('previous-part')).toBe(true);
		expect(actsOnRepeat('next-unread')).toBe(true);
		expect(actsOnRepeat('mark-reviewed')).toBe(false);
		expect(actsOnRepeat('toggle-open')).toBe(false);
		expect(actsOnRepeat('help')).toBe(false);
	});

	it('maps the keys people know to what the page does', () => {
		expect(shortcutOf(press('n'))).toBe('next-unread');
		expect(shortcutOf(press('j'))).toBe('next-part');
		expect(shortcutOf(press(']'))).toBe('next-part');
		expect(shortcutOf(press('k'))).toBe('previous-part');
		expect(shortcutOf(press('r'))).toBe('mark-reviewed');
		expect(shortcutOf(press('s'))).toBe('side-by-side');
		expect(shortcutOf(press('w'))).toBe('white-space');
		expect(shortcutOf(press('d'))).toBe('other-delves');
		expect(shortcutOf(press('v'))).toBe('overall-review');
		expect(shortcutOf(press('?'))).toBe('help');
		expect(shortcutOf(press('/'))).toBe('search');
		expect(shortcutOf(press('x'))).toBeUndefined();
		// On a checkbox a letter types nothing, so the shortcut works there too.
		expect(shortcutOf(press('r', { tagName: 'INPUT', type: 'checkbox' }))).toBe('mark-reviewed');
		// Nor on a slider, which takes only the arrow keys and the like.
		expect(shortcutOf(press('i', { tagName: 'INPUT', type: 'range' }))).toBe('compare-images');
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
