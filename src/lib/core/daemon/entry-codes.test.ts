import { describe, expect, it } from 'vitest';
import { settableClock } from '../clock.ts';
import { parseEntryCode, type EntryCode } from '../entry-code.tiny.ts';
import { parseTimestamp } from '../timestamp.tiny.ts';
import { ENTRY_CODE_LIFETIME_MS, entryCodes } from './entry-codes.ts';

function made<T>(result: { ok: true; value: T } | { ok: false }): T {
	if (!result.ok) throw new Error('did not parse');
	return result.value;
}

const code = (digit: string): EntryCode => made(parseEntryCode(digit.repeat(32)));

describe('entry codes', () => {
	it('are 32 lowercase hex digits', () => {
		expect(parseEntryCode('a'.repeat(32)).ok).toBe(true);
		expect(parseEntryCode('A'.repeat(32)).ok).toBe(false);
		expect(parseEntryCode('a'.repeat(64)).ok).toBe(false);
		expect(parseEntryCode('').ok).toBe(false);
	});

	it('work once', () => {
		const codes = entryCodes(settableClock(made(parseTimestamp(1000))));
		codes.issue(code('a'));
		expect(codes.redeem(code('b'))).toBe(false);
		expect(codes.redeem(code('a'))).toBe(true);
		expect(codes.redeem(code('a'))).toBe(false);
	});

	it('work only until their time is up', () => {
		const clock = settableClock(made(parseTimestamp(1000)));
		const codes = entryCodes(clock);
		codes.issue(code('a'));
		codes.issue(code('b'));
		clock.advance(ENTRY_CODE_LIFETIME_MS - 1);
		expect(codes.redeem(code('a'))).toBe(true);
		clock.advance(1);
		expect(codes.redeem(code('b'))).toBe(false);
	});
});
