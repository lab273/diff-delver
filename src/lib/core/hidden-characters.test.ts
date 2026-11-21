import { describe, expect, it } from 'vitest';
import { escapeCharacter, isHiddenCharacter, visibleText } from './hidden-characters.ts';

describe('hidden characters', () => {
	it('are written as escapes, \\x below U+0080 and \\u from there up', () => {
		expect([escapeCharacter('\u0007'), escapeCharacter('\r'), escapeCharacter('\u0085')]).toEqual([
			'\\x07',
			'\\r',
			'\\u0085'
		]);
		expect(isHiddenCharacter('a')).toBe(false);
		expect(visibleText('shop‮gnp.exe')).toBe('shop\\u202Egnp.exe');
	});
});
