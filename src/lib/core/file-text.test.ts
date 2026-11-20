import { describe, expect, it } from 'vitest';
import { linesOf, looksBinary } from './file-text.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('looksBinary', () => {
	it('is true only for a NUL in the first 8000 bytes, as in git', () => {
		expect(looksBinary(bytes('plain text\n'))).toBe(false);
		expect(looksBinary(Uint8Array.of(0x50, 0x00, 0x41))).toBe(true);
		const late = new Uint8Array(9000).fill(0x61);
		late[8500] = 0;
		expect(looksBinary(late)).toBe(false);
		late[7999] = 0;
		expect(looksBinary(late)).toBe(true);
	});
});

describe('linesOf', () => {
	it('splits on newlines only, keeps carriage returns, and counts a last line with no newline', () => {
		expect(linesOf(bytes(''))).toEqual([]);
		expect(linesOf(bytes('\n'))).toEqual(['']);
		expect(linesOf(bytes('a\r\nb\n'))).toEqual(['a\r', 'b']);
		expect(linesOf(bytes('a\nb'))).toEqual(['a', 'b']);
		expect(linesOf(bytes('a\u2028b\n'))).toEqual(['a\u2028b']);
	});

	it('decodes bytes that are not UTF-8 as the replacement character', () => {
		expect(linesOf(Uint8Array.of(0x61, 0xff, 0x0a))).toEqual(['a\ufffd']);
	});
});
