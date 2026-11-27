import { describe, expect, it } from 'vitest';
import { partIndexOf } from '../part-index.tiny.ts';
import {
	describeLeftToRead,
	nextUnreadPlace,
	summariesLeft,
	type ReadingPlace,
	type ToRead
} from './reading-places.ts';

const part = (at: number): ReadingPlace => ({ kind: 'part', at: partIndexOf(at) });
const summary = (group: number): ReadingPlace => ({ kind: 'summary', group });

/** Two sections of two parts each, both summaries and the overview unread. */
const fresh: ToRead = {
	overviewUnread: true,
	groups: [
		{ first: 0, count: 2, unreadSummary: 'app' },
		{ first: 2, count: 2, unreadSummary: 'docs' }
	],
	waiting: [true, true, true, true]
};

describe('the next unread place, with the agent’s writing', () => {
	it('reads the overview, then each section’s summary before its first part that waits', () => {
		expect(nextUnreadPlace(fresh)).toEqual({ kind: 'overview' });
		const read: ToRead = { ...fresh, overviewUnread: false };
		expect(nextUnreadPlace(read, { kind: 'overview' })).toEqual(summary(0));
		const first: ToRead = {
			...read,
			groups: [
				{ first: 0, count: 2, unreadSummary: undefined },
				{ first: 2, count: 2, unreadSummary: 'docs' }
			]
		};
		expect(nextUnreadPlace(first, summary(0))).toEqual(part(0));
		// From the last part of a section, its next section's summary comes first.
		expect(nextUnreadPlace(first, part(1))).toEqual(summary(1));
		expect(nextUnreadPlace({ ...first, waiting: [false, false, true, true] }, part(1))).toEqual(
			summary(1)
		);
	});

	it('passes over a summary once read, or once nothing it introduces waits', () => {
		const read: ToRead = {
			overviewUnread: false,
			groups: [
				{ first: 0, count: 2, unreadSummary: undefined },
				{ first: 2, count: 2, unreadSummary: 'docs' }
			],
			waiting: [true, false, false, false]
		};
		expect(nextUnreadPlace(read, part(0))).toEqual(part(0));
		expect(summariesLeft(read)).toEqual({ overview: false, summaries: 0 });
		// Nothing waits: not the overview, not a summary.
		const done: ToRead = { ...fresh, waiting: [false, false, false, false] };
		expect(nextUnreadPlace(done)).toBeUndefined();
		expect(summariesLeft(done)).toEqual({ overview: false, summaries: 0 });
	});

	it('goes round to a summary left behind, and counts a section and its tests’ summary once', () => {
		const tests: ToRead = {
			overviewUnread: false,
			groups: [
				{ first: 0, count: 1, unreadSummary: 'app' },
				{ first: 1, count: 1, unreadSummary: undefined },
				{ first: 2, count: 1, unreadSummary: 'app' }
			],
			waiting: [true, true, true]
		};
		expect(nextUnreadPlace(tests, part(1))).toEqual(summary(2));
		expect(nextUnreadPlace(tests, part(2))).toEqual(summary(0));
		expect(summariesLeft(tests)).toEqual({ overview: false, summaries: 1 });
	});

	it('says what is left with the agent’s writing apart from the changes', () => {
		expect(describeLeftToRead(12, summariesLeft(fresh))).toBe(
			'Left to read: 12 changes, the agent’s overview and 2 section summaries'
		);
		expect(describeLeftToRead(1, { overview: false, summaries: 1 })).toBe(
			'Left to read: 1 change and 1 section summary'
		);
		expect(describeLeftToRead(12, { overview: false, summaries: 0 })).toBeUndefined();
	});
});
