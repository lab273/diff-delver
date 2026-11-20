import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TIME_LIMITS } from '../../../scripts/test-time-limits.ts';
import { timed } from '../../../tests/support/measured-time.ts';
import { measurementName } from './measurement-name.tiny.ts';
import { compileGlob, parseGlobPattern } from './glob-pattern.tiny.ts';
import {
	compileGlobProgram,
	compileGlobUnion,
	globStepBound,
	MAX_GLOB_LENGTH,
	runGlobProgram
} from './glob.ts';
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
		['[!😀]', '😁', true],
		// A class never matches the "/" between folders, like "*" and "?".
		['a[.-0]b', 'a/b', false],
		['a[.-0]b', 'a.b', true],
		['a[.-0]b', 'a0b', true],
		['a[!x]b', 'a/b', false],
		['a[!x]b', 'a.b', true],
		['a[^x]b', 'a/b', false]
	])('%s against %s is %s', (pattern, path, expected) => {
		expect(matches(pattern, path)).toBe(expected);
	});

	it.each([
		['', 'empty'],
		['[abc', 'unclosed-class'],
		['{a,b', 'unclosed-brace'],
		['abc\\', 'trailing-escape'],
		['[z-a]', 'bad-range'],
		['x[b-a]y', 'bad-range'],
		['a[/]b', 'slash-in-class'],
		['a[x/]b', 'slash-in-class'],
		['a[\\/]b', 'slash-in-class'],
		['a[!/]b', 'slash-in-class'],
		['a[.-/]b', 'slash-in-class'],
		['a'.repeat(MAX_GLOB_LENGTH + 1), 'too-long'],
		['😀'.repeat(MAX_GLOB_LENGTH + 1), 'too-long']
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

	it('accepts a pattern of the longest length, counting characters, not UTF-16 units', () => {
		expect(parseGlobPattern('a'.repeat(MAX_GLOB_LENGTH)).ok).toBe(true);
		expect(parseGlobPattern('😀'.repeat(MAX_GLOB_LENGTH)).ok).toBe(true);
	});
});

/** A path of `a` and `b` that does not repeat soon, made without randomness. */
function pseudoRandomPath(length: number): string {
	let x = 1;
	let out = '';
	for (let i = 0; i < length; i += 1) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out += x % 7 < 3 ? 'a' : 'b';
	}
	return out;
}

/** The core guidance for one test, which one match of these should stay well inside. */
const CORE_GUIDANCE = TIME_LIMITS.core.guidance;

describe('glob matching time', () => {
	/** Runs a pattern against a path and checks the work against the bound. */
	function run(pattern: string, path: string): boolean {
		const program = compileGlobProgram(pattern);
		if (!program.ok) throw new Error(`bad test pattern ${pattern}`);
		const result = runGlobProgram(program.value, path);
		expect(result.steps).toBeLessThanOrEqual(globStepBound(program.value, Array.from(path).length));
		return result.matched;
	}

	// Each of these took seconds or never finished as a backtracking regular expression.
	// The step bound is what holds them; the time is guidance, reported by verify.
	it.for<readonly [string, string, string, boolean]>([
		['12 stars', '*a'.repeat(12) + '*b', 'a'.repeat(40), false],
		['40 stars', '*a'.repeat(40) + '*b', 'a'.repeat(4000), false],
		['40 stars that match', '*a'.repeat(40) + '*', 'a'.repeat(4000), true],
		['7 globstars', '**/'.repeat(7) + 'z', Array.from({ length: 30 }, () => 'a').join('/'), false],
		[
			'80 globstars',
			'**/'.repeat(80) + 'z',
			Array.from({ length: 2000 }, () => 'a').join('/'),
			false
		],
		['25 brace groups', '{*,*a,a*}'.repeat(25) + 'b', 'a'.repeat(4000), false],
		['100 stars and marks', '*?'.repeat(100) + 'b', 'a'.repeat(4000), false],
		['40 mixed stars', '**/*a'.repeat(40) + 'b', 'a/'.repeat(2000) + 'a', false],
		// A set of states for each of 2^20 tails, far more than are kept.
		['a star and 20 marks', '*a' + '?'.repeat(20) + 'c', pseudoRandomPath(4000), false]
	])('%s finish quickly on a long path', ([, pattern, path, expected], { task }) => {
		const matched = timed(task, measurementName('matching'), CORE_GUIDANCE, () =>
			run(pattern, path)
		);
		expect(matched).toBe(expected);
	});

	it('never takes more steps than the bound, whatever the pattern and path', () => {
		const piece = fc.constantFrom(
			'*',
			'**',
			'**/',
			'?',
			'a',
			'b',
			'/',
			'{',
			'}',
			',',
			'[a-c]',
			'[!a]'
		);
		const pattern = fc.array(piece, { maxLength: 60 }).map((p) => p.join(''));
		const path = fc
			.array(fc.constantFrom('a', 'b', 'c', '/'), { minLength: 1, maxLength: 300 })
			.map((p) => p.join(''));
		fc.assert(
			fc.property(pattern, path, (p, x) => {
				const program = compileGlobProgram(p);
				if (!program.ok) return;
				const result = runGlobProgram(program.value, x);
				expect(result.steps).toBeLessThanOrEqual(globStepBound(program.value, x.length));
			}),
			{ numRuns: 300 }
		);
	});

	it('keeps the bound when one program runs on many paths and reuses what it learnt', () => {
		const program = compileGlobProgram('*a' + '?'.repeat(12) + '*c');
		if (!program.ok) throw new Error('bad test pattern');
		for (let i = 0; i < 50; i += 1) {
			const path = pseudoRandomPath(200 + i) + (i % 2 === 0 ? 'c' : '');
			const result = runGlobProgram(program.value, path);
			expect(result.matched).toBe(i % 2 === 0 && path.slice(0, -13).includes('a'));
			expect(result.steps).toBeLessThanOrEqual(globStepBound(program.value, path.length));
		}
	});

	it('matches a union of patterns exactly when one of them matches', () => {
		const piece = fc.constantFrom('*', '**/', '?', 'a', 'b', '/', '[ab]', '{a,b/}');
		const pattern = fc.array(piece, { minLength: 1, maxLength: 6 }).map((p) => p.join(''));
		const path = fc
			.array(fc.constantFrom('a', 'b', '/'), { minLength: 1, maxLength: 12 })
			.map((p) => p.join(''));
		fc.assert(
			fc.property(fc.array(pattern, { minLength: 1, maxLength: 4 }), fc.array(path), (ps, xs) => {
				const union = compileGlobUnion(ps);
				const each = ps.map(compileGlobProgram);
				if (!union.ok) {
					expect(each.some((p) => !p.ok)).toBe(true);
					return;
				}
				for (const x of xs) {
					const any = each.some((p) => p.ok && runGlobProgram(p.value, x).matched);
					expect(runGlobProgram(union.value, x).matched).toBe(any);
				}
			}),
			{ numRuns: 300 }
		);
	});

	it('runs the worst pattern of the longest length against a 4,096-character path within the step bound', ({
		task
	}) => {
		const pattern = '*a'.repeat(MAX_GLOB_LENGTH / 2 - 1) + '*b';
		expect(Array.from(pattern)).toHaveLength(MAX_GLOB_LENGTH);
		const matched = timed(task, measurementName('matching'), CORE_GUIDANCE, () =>
			run(pattern, 'a'.repeat(4096))
		);
		expect(matched).toBe(false);
	});
});
