import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRepoPath, type InvalidRepoPathReason } from './repo-path.tiny.ts';

const segment = fc
	.string({ minLength: 1, unit: 'grapheme' })
	.filter((s) => !s.includes('/') && !s.includes('\0') && s !== '.' && s !== '..');

describe('parseRepoPath', () => {
	it.each(['README.md', 'src/lib/core/tiny.ts', '.github/workflows/ci.yml', 'a b/c\\d'])(
		'accepts %s',
		(value) => {
			expect(parseRepoPath(value)).toEqual({ ok: true, value });
		}
	);

	it.each<[string, InvalidRepoPathReason]>([
		['', 'empty'],
		['/etc/passwd', 'absolute'],
		['src/', 'trailing-slash'],
		['src//index.ts', 'empty-segment'],
		['./src', 'dot-segment'],
		['src/../secret', 'dot-segment'],
		['a\0b', 'nul-byte'],
		['a\uD800', 'unpaired-surrogate'],
		['a\uDBFF.txt', 'unpaired-surrogate'],
		['\uDC00', 'unpaired-surrogate'],
		['a\uDC7F', 'unpaired-surrogate'],
		['a\uDCC3\uDCA9', 'escapes-spell-text'],
		['\uDCE2\uDC82\uDCAC.txt', 'escapes-spell-text']
	])('rejects %j as %s', (value, reason) => {
		expect(parseRepoPath(value)).toEqual({
			ok: false,
			error: { kind: 'InvalidRepoPath', value, reason }
		});
	});

	it('accepts any path built from valid parts', () => {
		fc.assert(
			fc.property(fc.array(segment, { minLength: 1, maxLength: 6 }), (segments) => {
				const value = segments.join('/');
				expect(parseRepoPath(value)).toEqual({ ok: true, value });
			})
		);
	});

	it('rejects any path that climbs out of the tree', () => {
		fc.assert(
			fc.property(
				fc.array(segment, { maxLength: 3 }),
				fc.array(segment, { maxLength: 3 }),
				(before, after) => {
					const value = [...before, '..', ...after].join('/');
					expect(parseRepoPath(value).ok).toBe(false);
				}
			)
		);
	});

	it('accepts odd bytes that do not spell valid UTF-8, and a real surrogate pair', () => {
		for (const value of ['a\uDCFF', 'caf\uDCE9.txt', '\uDCC3A', '\uDCE2\uDC82', '\u{10080}']) {
			expect(parseRepoPath(value)).toEqual({ ok: true, value });
		}
	});

	it('gives two paths that differ as strings different bytes', () => {
		const unit = fc.constantFrom(
			'a',
			'é',
			'\uFFFD',
			'\uD800',
			'\uDBFF',
			'\uDC00',
			'\uDC80',
			'\uDCC3',
			'\uDCA9',
			'\uDCFF',
			'\u{10080}'
		);
		const encoder = new TextEncoder();
		const bytesOf = (text: string): string =>
			Array.from(text, (c) => {
				const code = c.codePointAt(0) ?? 0;
				return code >= 0xdc80 && code <= 0xdcff
					? `<${String(code - 0xdc00)}>`
					: [...encoder.encode(c)].map((b) => `<${String(b)}>`).join('');
			}).join('');
		fc.assert(
			fc.property(
				fc.array(unit, { minLength: 1, maxLength: 5 }),
				fc.array(unit, { minLength: 1, maxLength: 5 }),
				(a, b) => {
					const p = parseRepoPath(a.join(''));
					const q = parseRepoPath(b.join(''));
					if (p.ok && q.ok && p.value !== q.value)
						expect(bytesOf(p.value)).not.toBe(bytesOf(q.value));
				}
			),
			{ numRuns: 2000 }
		);
	});
});
