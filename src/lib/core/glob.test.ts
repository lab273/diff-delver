import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileGlob, parseGlobPattern } from './glob-pattern.tiny.ts';
import { parseRepoPath } from './repo-path.tiny.ts';

function matches(pattern: string, path: string): boolean {
	const glob = parseGlobPattern(pattern);
	const repoPath = parseRepoPath(path);
	if (!glob.ok || !repoPath.ok) throw new Error(`bad test input ${pattern} ${path}`);
	return compileGlob(glob.value)(repoPath.value);
}

describe('glob patterns', () => {
	it.each([
		['*.ts', 'index.ts', true],
		['*.ts', 'src/lib/index.ts', true],
		['*.ts', 'index.tsx', false],
		['src/*.ts', 'src/index.ts', true],
		['src/*.ts', 'src/lib/index.ts', false],
		['src/**/*.ts', 'src/index.ts', true],
		['src/**/*.ts', 'src/a/b/c.ts', true],
		['src/**', 'src/a/b/c.ts', true],
		['src/**', 'srcx/a.ts', false],
		['**/fixtures/**', 'fixtures/a.json', true],
		['**/fixtures/**', 'test/fixtures/recorded/a.json', true],
		['fixtures/recorded/**', 'fixtures/recorded/http/1.json', true],
		['fixtures/recorded/**', 'other/fixtures/recorded/1.json', false],
		['/README.md', 'README.md', true],
		['/README.md', 'docs/README.md', false],
		['vendor/', 'vendor/lib/a.go', true],
		['file?.txt', 'file1.txt', true],
		['file?.txt', 'file10.txt', false],
		['[ab].txt', 'a.txt', true],
		['[!ab].txt', 'c.txt', true],
		['[!ab].txt', 'a.txt', false],
		['[a-c]x', 'bx', true],
		['*.{js,ts}', 'a/b.ts', true],
		['*.{js,ts}', 'a/b.rs', false],
		['{src,lib}/**/*.{ts,js}', 'lib/x/y.js', true],
		['a{b,c{d,e}}f', 'acef', true],
		['\\*.txt', '*.txt', true],
		['\\*.txt', 'a.txt', false],
		['odd names/*', 'odd names/ünïcödé "quoted".txt', true],
		['a+b(c).txt', 'a+b(c).txt', true],
		['Makefile', 'makefile', false],
		// Only `/` separates; line terminators are ordinary characters in a path.
		['src/**', 'src/new\nline.txt', true],
		['**/x.txt', 'a\u2028b/x.txt', true],
		['*.txt', 'odd\ndir/a\rb.txt', true],
		['src/**/*.ts', 'src/a\u2029/b.ts', true],
		// Inside a class every member is literal, escaped or not.
		['[\\d].ts', 'd.ts', true],
		['[\\d].ts', '1.ts', false],
		['[\\w]', 'w', true],
		['[\\w]', 'a', false],
		['[\\q]', 'q', true],
		['[\\]].txt', '].txt', true],
		['[]a].txt', '].txt', true],
		['[a-].txt', '-.txt', true],
		['[-a].txt', '-.txt', true],
		['[\\^x]', '^', true],
		['[$.|]', '|', true],
		['[$.|]', 'a', false],
		['[😀]', '😀', true],
		['[😀-😂]', '😁', true],
		['[!😀]', '😁', true]
	])('%s against %s is %s', (pattern, path, expected) => {
		expect(matches(pattern, path)).toBe(expected);
	});

	it.each([
		['', 'empty'],
		['[abc', 'unclosed-class'],
		['{a,b', 'unclosed-brace'],
		['abc\\', 'trailing-escape'],
		['[z-a]', 'bad-range'],
		['x[b-a]y', 'bad-range']
	])('rejects %j as %s', (value, problem) => {
		expect(parseGlobPattern(value)).toEqual({
			ok: false,
			error: { kind: 'InvalidGlobPattern', value, problem }
		});
	});

	it('never throws, whatever the pattern, and a pattern that parses always compiles', () => {
		const anyString = fc.oneof(
			fc.string({ unit: 'binary', maxLength: 12 }),
			fc
				.array(
					fc.constantFrom('[', ']', '!', '^', '-', '\\', '{', '}', ',', '*', '/', 'a', 'z', 'd'),
					{
						maxLength: 12
					}
				)
				.map((chars) => chars.join(''))
		);
		const path = parseRepoPath('src/a-b/[x].ts');
		if (!path.ok) throw new Error('bad test path');
		fc.assert(
			fc.property(anyString, (pattern) => {
				const glob = parseGlobPattern(pattern);
				if (glob.ok) expect(typeof compileGlob(glob.value)(path.value)).toBe('boolean');
				else expect(glob.error.kind).toBe('InvalidGlobPattern');
			}),
			{ numRuns: 2000 }
		);
	});

	it('matches any path when the path is escaped character by character', () => {
		const segment = fc
			.string({ minLength: 1, maxLength: 8 })
			.filter((s) => !s.includes('/') && !s.includes('\0') && s !== '.' && s !== '..');
		fc.assert(
			fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
				const path = segments.join('/');
				const escaped = Array.from(path, (c) => (c === '/' ? '/' : `\\${c}`)).join('');
				expect(matches(escaped, path)).toBe(true);
			})
		);
	});
});
