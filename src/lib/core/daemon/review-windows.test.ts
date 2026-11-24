import { describe, expect, it } from 'vitest';
import { settableClock } from '../clock.ts';
import { parseTimestamp } from '../timestamp.tiny.ts';
import { REVIEW_WINDOW_EVERY_MS, reviewWindows } from './review-windows.ts';

function clockAt(time: number) {
	const parsed = parseTimestamp(time);
	if (!parsed.ok) throw new Error('not a time');
	return settableClock(parsed.value);
}

describe('windows that may write drafts', () => {
	it('are asked for at most once in a few seconds, however often one is wanted', () => {
		const clock = clockAt(1_000);
		const windows = reviewWindows(clock);
		expect(windows.mayAsk()).toBe(true);
		for (let asked = 0; asked < 100; asked += 1) expect(windows.mayAsk()).toBe(false);
		clock.advance(REVIEW_WINDOW_EVERY_MS - 1);
		expect(windows.mayAsk()).toBe(false);
		clock.advance(1);
		expect(windows.mayAsk()).toBe(true);
		expect(windows.mayAsk()).toBe(false);
	});

	it('counts from the last one asked for, not from one held back', () => {
		const clock = clockAt(1_000);
		const windows = reviewWindows(clock);
		expect(windows.mayAsk()).toBe(true);
		clock.advance(REVIEW_WINDOW_EVERY_MS - 1);
		expect(windows.mayAsk()).toBe(false);
		clock.advance(1);
		expect(windows.mayAsk()).toBe(true);
	});

	it('each daemon keeps its own count', () => {
		const clock = clockAt(1_000);
		const one = reviewWindows(clock);
		const other = reviewWindows(clock);
		expect(one.mayAsk()).toBe(true);
		expect(other.mayAsk()).toBe(true);
	});
});
