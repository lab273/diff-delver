import { describe, expect, it } from 'vitest';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';
import { logEntry, logTime } from './log-line.ts';

function at(...utc: [number, number, number, number, number, number, number?]): Timestamp {
	const [year, month, ...rest] = utc;
	const parsed = parseTimestamp(Date.UTC(year, month - 1, ...rest));
	if (!parsed.ok) throw new Error('not a time');
	return parsed.value;
}

describe('the daemon log', () => {
	it('writes the time in UTC to the second', () => {
		expect(logTime(at(2026, 11, 26, 21, 49, 22, 987))).toBe('2026-11-26T21:49:22Z');
		expect(logTime(at(2026, 1, 5, 3, 4, 5))).toBe('2026-01-05T03:04:05Z');
	});

	it('starts every line with the time and ends the entry with a line break', () => {
		const time = at(2026, 11, 26, 21, 49, 22);
		expect(logEntry(time, 'diff delver started.')).toBe(
			'2026-11-26T21:49:22Z diff delver started.\n'
		);
		expect(logEntry(time, 'Error: broke\n    at here\n')).toBe(
			'2026-11-26T21:49:22Z Error: broke\n2026-11-26T21:49:22Z     at here\n'
		);
	});
});
