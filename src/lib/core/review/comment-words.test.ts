import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isHiddenCharacter } from '../hidden-characters.ts';
import { commentLines } from './comment-words.ts';

/** What a person reads: each line's pieces joined, the lines joined by line breaks. */
function shown(body: string): string {
	return commentLines(body)
		.map((line) => line.map((piece) => (piece.kind === 'text' ? piece.text : piece.shown)).join(''))
		.join('\n');
}

describe('a comment’s words as drawn', () => {
	it('are the words typed, with their line breaks and tabs', () => {
		const body = 'Why not\n\tconst total = 0;\n\nhere?';
		expect(shown(body)).toBe(body);
		expect(commentLines(body)).toEqual([
			[{ kind: 'text', text: 'Why not' }],
			[{ kind: 'text', text: '\tconst total = 0;' }],
			[],
			[{ kind: 'text', text: 'here?' }]
		]);
	});

	it('write out what cannot be seen and what turns text round', () => {
		expect(commentLines('safe‮txt.exe')).toEqual([
			[
				{ kind: 'text', text: 'safe' },
				{ kind: 'escape', shown: '\\u202E' },
				{ kind: 'text', text: 'txt.exe' }
			]
		]);
		expect(shown('a​b\u0007\rc d')).toBe('a\\u200Bb\\x07\\rc\\u2028d');
	});

	it('never draw a hidden character as it is, and never lose a seen one', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary' }), (body) => {
				const drawn = shown(body);
				for (const character of drawn) {
					if (character !== '\n' && character !== '\t') {
						expect(isHiddenCharacter(character)).toBe(false);
					}
				}
				const seen = Array.from(body).filter(
					(c) => c === '\n' || c === '\t' || !isHiddenCharacter(c)
				);
				let from = 0;
				for (const character of seen) {
					const at = drawn.indexOf(character, from);
					expect(at).toBeGreaterThanOrEqual(0);
					from = at + character.length;
				}
			})
		);
	});
});
