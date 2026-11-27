import { describe, expect, it } from 'vitest';
import { parseRevisionNumber, type RevisionNumber } from '../revision-number.tiny.ts';
import { parseReviewNumber, type ReviewNumber } from '../review-number.tiny.ts';
import { describeEarlierThreads, threadStatus, type ThreadPlace } from './threads.ts';

function review(n: number): ReviewNumber {
	const parsed = parseReviewNumber(n);
	if (!parsed.ok) throw new Error(String(n));
	return parsed.value;
}

function v(n: number): RevisionNumber {
	const parsed = parseRevisionNumber(n);
	if (!parsed.ok) throw new Error(String(n));
	return parsed.value;
}

function place(version: number, edited: boolean): ThreadPlace {
	return { version: v(version), anchor: undefined, edited };
}

describe("a thread's status", () => {
	const started = [{ version: v(1) }];

	it('is open while its code has not changed since it was written', () => {
		expect(threadStatus(started, [], [place(1, false), place(2, false)], v(2))).toBe('open');
	});

	it('is changed once its code changed in a later version, and not on an earlier one', () => {
		const places = [place(1, false), place(2, false), place(3, true)];
		expect(threadStatus(started, [], places, v(3))).toBe('changed');
		expect(threadStatus(started, [], places, v(2))).toBe('open');
	});

	it('is open again once replied to on the changed version, until it changes again', () => {
		const places = [place(1, false), place(2, true), place(3, false), place(4, true)];
		const replied = [...started, { version: v(2) }];
		expect(threadStatus(replied, [], places, v(3))).toBe('open');
		expect(threadStatus(replied, [], places, v(4))).toBe('changed');
	});

	it('is resolved when the last review that resolved or reopened it resolved it', () => {
		const places = [place(1, false), place(2, true)];
		const resolved = [{ review: review(2), resolved: true, version: v(2) }];
		expect(threadStatus(started, resolved, places, v(2))).toBe('resolved');
		const reopened = [...resolved, { review: review(3), resolved: false, version: v(2) }];
		expect(threadStatus(started, reopened, places, v(2))).toBe('open');
	});

	it('is counted in words', () => {
		expect(
			describeEarlierThreads([{ status: 'open' }, { status: 'changed' }, { status: 'open' }])
		).toBe('From earlier reviews: 2 open, 1 code changed since');
	});
});
