import { describe, expect, it } from 'vitest';
import { parseTimestamp, type Timestamp } from './timestamp.tiny.ts';
import { describeTimeAgo } from './time-ago.ts';

const at = (ms: number): Timestamp => {
	const parsed = parseTimestamp(ms);
	if (!parsed.ok) throw new Error('bad time');
	return parsed.value;
};

const now = at(1_800_000_000_000);
const before = (ms: number): string => describeTimeAgo(at(now - ms), now);

describe('describeTimeAgo', () => {
	it.each([
		[0, 'just now'],
		[59_999, 'just now'],
		[60_000, '1 minute ago'],
		[59 * 60_000, '59 minutes ago'],
		[3_600_000, '1 hour ago'],
		[23 * 3_600_000, '23 hours ago'],
		[86_400_000, '1 day ago'],
		[29 * 86_400_000, '29 days ago'],
		[30 * 86_400_000, '1 month ago'],
		[364 * 86_400_000, '12 months ago'],
		[365 * 86_400_000, '1 year ago'],
		[800 * 86_400_000, '2 years ago']
	])('says %d ms ago is "%s"', (ms, text) => {
		expect(before(ms)).toBe(text);
	});

	it('says just now for a time after now, from a clock set back', () => {
		expect(describeTimeAgo(at(now + 5000), now)).toBe('just now');
	});
});
