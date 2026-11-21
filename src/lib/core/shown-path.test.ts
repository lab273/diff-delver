import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodePathBytes } from './path-codec.ts';
import { parseRepoPath, type RepoPath } from './repo-path.tiny.ts';
import { escapedRepoPath } from './escaped-path.tiny.ts';
import { pathPieces, shownRepoPath } from './shown-path.tiny.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

describe('a path as a person is shown it', () => {
	it('writes what cannot be seen, or turns text round, as escapes', () => {
		expect(shownRepoPath(path('report‮txt.exe'))).toBe('report\\u202Etxt.exe');
		expect(shownRepoPath(path('a​b.txt'))).toBe('a\\u200Bb.txt');
		expect(shownRepoPath(path('bell\u0007.txt'))).toBe('bell\\x07.txt');
		expect(shownRepoPath(path('src/app.ts'))).toBe('src/app.ts');
		expect(pathPieces(escapedRepoPath(path('a​b')))).toEqual([
			{ kind: 'text', text: 'a' },
			{ kind: 'escape', shown: '\\u200B' },
			{ kind: 'text', text: 'b' }
		]);
	});

	it('keeps the escaped form of names that are not valid UTF-8, and of backslashes', () => {
		const latin1 = path(decodePathBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9])));
		expect(shownRepoPath(latin1)).toBe('caf\\xE9');
		expect(shownRepoPath(path('src\\app.ts'))).toBe('src\\\\app.ts');
		// A C1 control is valid UTF-8, so it is never shown as an odd byte's \xHH.
		expect(shownRepoPath(path('a\u0085b'))).toBe('a\\u0085b');
	});

	it('shows no two paths alike', () => {
		const char = fc.constantFrom(
			'a',
			'/',
			'\\',
			'x',
			'u',
			'2',
			'0',
			'E',
			'‮',
			'​',
			'\u0007',
			'\u0085'
		);
		fc.assert(
			fc.property(
				fc.array(char, { minLength: 1, maxLength: 8 }),
				fc.array(char, { minLength: 1, maxLength: 8 }),
				(a, b) => {
					const one = parseRepoPath(a.join(''));
					const two = parseRepoPath(b.join(''));
					if (!one.ok || !two.ok || one.value === two.value) return;
					expect(shownRepoPath(one.value)).not.toBe(shownRepoPath(two.value));
				}
			)
		);
	});
});
