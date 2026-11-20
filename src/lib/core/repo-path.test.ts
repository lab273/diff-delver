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
		['a\0b', 'nul-byte']
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
});
