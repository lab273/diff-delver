import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	decodePathBytes,
	escapedRepoPath,
	hasOddBytes,
	repoPathBytes,
	repoPathFromBytes,
	resolveEscapedPath
} from './path-bytes.ts';
import { parseRepoPath, type RepoPath } from './repo-path.tiny.ts';

const bytes = (...parts: readonly (string | number)[]): Uint8Array =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === 'number' ? [p] : [...new TextEncoder().encode(p)]))
	);

function repoPath(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(`bad test path ${text}`);
	return parsed.value;
}

function pathOf(value: Uint8Array): RepoPath {
	const parsed = repoPathFromBytes(value);
	if (!parsed.ok) throw new Error('not a path');
	return parsed.value;
}

describe('paths from bytes', () => {
	it('keeps a valid UTF-8 path exactly as it is', () => {
		for (const text of [
			'\u{10080}\u{100FF}.txt',
			'\uFEFFbom.txt',
			'a.txt',
			'odd names/ünïcödé "quoted".txt',
			'tab\there',
			'caf\\xE9.txt'
		]) {
			expect(decodePathBytes(new TextEncoder().encode(text))).toBe(text);
		}
	});

	it('keeps paths that differ only in bytes that are not UTF-8 apart', () => {
		const e9 = pathOf(bytes('caf', 0xe9, '.txt'));
		const e8 = pathOf(bytes('caf', 0xe8, '.txt'));
		expect(e9).not.toBe(e8);
		expect(e9).not.toBe(pathOf(bytes('café.txt')));
	});

	it('does not take half of a real surrogate pair for an odd byte', () => {
		const astral = pathOf(bytes('\u{10080}', 0xe9));
		expect(escapedRepoPath(astral)).toBe('\u{10080}\\xE9');
		expect(repoPathBytes(astral)).toEqual(bytes('\u{10080}', 0xe9));
		expect(hasOddBytes(pathOf(bytes('\u{10080}')))).toBe(false);
	});

	it('gives the exact bytes back', () => {
		const odd = bytes('dir', 0xff, '/caf', 0xe9, '.txt');
		expect(repoPathBytes(pathOf(odd))).toEqual(odd);
	});

	it('escapes the odd bytes for display, and reads the escaped form back', () => {
		const odd = pathOf(bytes('a\\b/caf', 0xe9, '.txt'));
		expect(escapedRepoPath(odd)).toBe('a\\\\b/caf\\xE9.txt');
		expect(resolveEscapedPath('a\\\\b/caf\\xE9.txt')).toBe(odd);
		expect(resolveEscapedPath('a\\\\b/caf\\xe9.txt')).toBe(odd);
	});

	it('shows a path without backslashes or odd bytes unchanged', () => {
		for (const text of ['plain.txt', 'odd names/ünïcödé "quoted".txt', 'tab\there', '\u{10080}']) {
			expect(escapedRepoPath(repoPath(text))).toBe(text);
			expect(resolveEscapedPath(text)).toBe(text);
		}
	});

	it('escapes the backslashes of a valid path that has any, so it cannot pass for an odd one', () => {
		const literal = repoPath('caf\\xE9.txt');
		const odd = pathOf(bytes('caf', 0xe9, '.txt'));
		expect(escapedRepoPath(literal)).toBe('caf\\\\xE9.txt');
		expect(escapedRepoPath(odd)).toBe('caf\\xE9.txt');
		expect(resolveEscapedPath('caf\\\\xE9.txt')).toBe(literal);
		expect(resolveEscapedPath('caf\\xE9.txt')).toBe(odd);
	});

	it('takes text whose backslashes start no escape as the literal path', () => {
		// \x41 is ASCII, which is never escaped, and \q is no escape at all.
		expect(resolveEscapedPath('caf\\x41.txt')).toBe('caf\\x41.txt');
		expect(resolveEscapedPath('src\\app.ts')).toBe('src\\app.ts');
		expect(resolveEscapedPath('bad\\q\\xE9')).toBe('bad\\q\\xE9');
		expect(resolveEscapedPath('end\\')).toBe('end\\');
	});

	it('reads escaped bytes that spell valid UTF-8 as that text, and refuses what is no path', () => {
		expect(resolveEscapedPath('caf\\xC3\\xA9.txt')).toBe('café.txt');
		expect(resolveEscapedPath('a/\\x2E')).toBe('a/\\x2E');
		expect(resolveEscapedPath('a//b')).toBeUndefined();
	});

	it('gives distinct paths distinct escaped forms, each read back to its path', () => {
		const unit = fc.constantFrom(
			'\\',
			'x',
			'X',
			'E',
			'e',
			'9',
			'8',
			'F',
			'a',
			'/',
			'é',
			'\uDC80',
			'\uDCE9',
			'\uDCFF',
			'\uDCC3'
		);
		const text = fc.array(unit, { minLength: 1, maxLength: 8 }).map((u) => u.join(''));
		// Many paths a run, so each run checks every pair of them.
		fc.assert(
			fc.property(fc.array(text, { maxLength: 60 }), (texts) => {
				const byForm = new Map<string, RepoPath>();
				for (const t of texts) {
					const parsed = parseRepoPath(t);
					if (!parsed.ok) continue;
					const path = parsed.value;
					const form = escapedRepoPath(path);
					expect(resolveEscapedPath(form)).toBe(path);
					expect(byForm.get(form) ?? path).toBe(path);
					byForm.set(form, path);
				}
			}),
			{ numRuns: 300 }
		);
	});

	it('treats overlong forms, encoded surrogates and stray bytes as odd bytes', () => {
		for (const odd of [
			bytes(0xc0, 0x80),
			bytes(0xed, 0xb3, 0xa9),
			bytes(0xf4, 0x90, 0x80, 0x80),
			bytes(0x80),
			bytes(0xe2, 0x82)
		]) {
			const decoded = decodePathBytes(odd);
			expect(Array.from(decoded).every((c) => (c.codePointAt(0) ?? 0) >= 0xdc80)).toBe(true);
			expect(repoPathBytes(pathOf(bytes('x', ...odd)))).toEqual(bytes('x', ...odd));
		}
	});

	it('round-trips any bytes, and decodes valid UTF-8 as the platform does', () => {
		const segmentBytes = fc
			.uint8Array({ minLength: 1, maxLength: 12 })
			.filter((b) => !b.includes(0) && !b.includes(0x2f))
			.filter((b) => !(b.length === 1 && b[0] === 0x2e))
			.filter((b) => !(b.length === 2 && b[0] === 0x2e && b[1] === 0x2e));
		fc.assert(
			fc.property(segmentBytes, (raw) => {
				const path = pathOf(raw);
				expect(repoPathBytes(path)).toEqual(raw);
				expect(resolveEscapedPath(escapedRepoPath(path))).toBe(path);
				if (!hasOddBytes(path) && !path.includes('\\')) expect(escapedRepoPath(path)).toBe(path);
				const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
				let valid: string | undefined;
				try {
					valid = strict.decode(raw);
				} catch {
					valid = undefined;
				}
				if (valid !== undefined) expect(path).toBe(valid);
			}),
			{ numRuns: 1000 }
		);
	});
});
