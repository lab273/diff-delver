import { describe, expect, it } from 'vitest';
import { parseEntryCode, type EntryCode } from '../entry-code.tiny.ts';
import { MOST_ENTRY_CODES_KEPT, entryCodes } from './entry-codes.ts';

function made<T>(result: { ok: true; value: T } | { ok: false }): T {
	if (!result.ok) throw new Error('did not parse');
	return result.value;
}

const code = (digit: string): EntryCode => made(parseEntryCode(digit.repeat(32)));
const numbered = (n: number): EntryCode => made(parseEntryCode(n.toString(16).padStart(32, '0')));

describe('entry codes', () => {
	it('are 32 lowercase hex digits', () => {
		expect(parseEntryCode('a'.repeat(32)).ok).toBe(true);
		expect(parseEntryCode('A'.repeat(32)).ok).toBe(false);
		expect(parseEntryCode('a'.repeat(64)).ok).toBe(false);
		expect(parseEntryCode('').ok).toBe(false);
	});

	it('work once', () => {
		const codes = entryCodes();
		codes.issue(code('a'), 'review');
		expect(codes.redeem(code('b'))).toBeUndefined();
		expect(codes.redeem(code('a'))).toBe('review');
		expect(codes.redeem(code('a'))).toBeUndefined();
	});

	it('keeps the session grant the code was issued with', () => {
		const codes = entryCodes();
		codes.issue(code('a'), 'view');
		expect(codes.redeem(code('a'))).toBe('view');
	});

	it('still work long after they were made, while others come and go', () => {
		const codes = entryCodes();
		codes.issue(code('a'), 'review');
		for (let n = 1; n < MOST_ENTRY_CODES_KEPT; n += 1) {
			codes.issue(numbered(n), 'view');
			expect(codes.redeem(numbered(n))).toBe('view');
		}
		expect(codes.redeem(code('a'))).toBe('review');
		expect(codes.redeem(code('a'))).toBeUndefined();
	});

	it('forget the oldest unused code past the most they keep', () => {
		const codes = entryCodes();
		codes.issue(numbered(0), 'view');
		codes.issue(numbered(1), 'review');
		codes.issue(numbered(2), 'view');
		// A used code no longer counts towards the most kept.
		expect(codes.redeem(numbered(1))).toBe('review');
		for (let n = 3; n <= MOST_ENTRY_CODES_KEPT + 1; n += 1) codes.issue(numbered(n), 'view');
		expect(codes.redeem(numbered(0))).toBeUndefined();
		expect(codes.redeem(numbered(2))).toBe('view');
		expect(codes.redeem(numbered(3))).toBe('view');
		expect(codes.redeem(numbered(MOST_ENTRY_CODES_KEPT + 1))).toBe('view');
	});

	it('keep as many unused codes as the bound', () => {
		const codes = entryCodes();
		for (let n = 0; n <= MOST_ENTRY_CODES_KEPT; n += 1) codes.issue(numbered(n), 'view');
		expect(codes.redeem(numbered(0))).toBeUndefined();
		expect(codes.redeem(numbered(1))).toBe('view');
		expect(codes.redeem(numbered(MOST_ENTRY_CODES_KEPT))).toBe('view');
	});
});
