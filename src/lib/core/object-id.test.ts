import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseBlobId } from './blob-id.tiny.ts';
import { parseCommitId } from './commit-id.tiny.ts';
import { isNullObjectId } from './object-id.ts';
import { parseTreeId } from './tree-id.tiny.ts';

const sha1 = 'a'.repeat(40);
const sha256 = '0123456789abcdef'.repeat(4);

describe('object ids', () => {
	it.each([parseTreeId, parseBlobId, parseCommitId])('accept SHA-1 and SHA-256 ids', (parse) => {
		expect(parse(sha1)).toEqual({ ok: true, value: sha1 });
		expect(parse(sha256)).toEqual({ ok: true, value: sha256 });
	});

	it.each(['', 'abc1234', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41), `${sha1}\n`])(
		'reject %j',
		(value) => {
			expect(parseTreeId(value).ok).toBe(false);
			expect(parseBlobId(value).ok).toBe(false);
			expect(parseCommitId(value).ok).toBe(false);
		}
	);

	it('accept any 40 or 64 lowercase hex digits', () => {
		const hex = fc.constantFrom(
			'0',
			'1',
			'2',
			'3',
			'4',
			'5',
			'6',
			'7',
			'8',
			'9',
			'a',
			'b',
			'c',
			'd',
			'e',
			'f'
		);
		const id = fc.oneof(
			fc.string({ unit: hex, minLength: 40, maxLength: 40 }),
			fc.string({ unit: hex, minLength: 64, maxLength: 64 })
		);
		fc.assert(
			fc.property(id, (value) => {
				expect(parseTreeId(value).ok).toBe(true);
			})
		);
	});

	it('recognise the all-zero id', () => {
		expect(isNullObjectId('0'.repeat(40))).toBe(true);
		expect(isNullObjectId(sha1)).toBe(false);
	});
});
