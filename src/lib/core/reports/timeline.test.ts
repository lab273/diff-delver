import { describe, expect, it } from 'vitest';
import { parseCommentCount } from '../comment-count.tiny.ts';
import { fileCountOf } from '../file-count.tiny.ts';
import { parseGitHubReviewAddress } from '../github/github-review-address.tiny.ts';
import { parseHandoverCount } from '../handover-count.tiny.ts';
import { lineNumberOf } from '../line-number.tiny.ts';
import { parseRepoPath } from '../repo-path.tiny.ts';
import type { Result } from '../result.ts';
import { parseReviewNumber } from '../review-number.tiny.ts';
import type { FinishedReview } from '../review/review-export.ts';
import { parseRevisionNumber } from '../revision-number.tiny.ts';
import { textForAgent } from '../text-for-agent.tiny.ts';
import { parseThreadId } from '../thread-id.tiny.ts';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import {
	describeArrival,
	describeDeliveries,
	describeItemKind,
	describeToday,
	reviewItems,
	startedBy,
	timelineOf,
	type ThreadToday,
	type TimelineVersion
} from './timeline.ts';

function sure<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

const HOUR = 3_600_000;
const NOW = sure(parseTimestamp(100 * HOUR));
const ago = (hours: number): Timestamp => sure(parseTimestamp(NOW - hours * HOUR));
const revision = (n: number) => sure(parseRevisionNumber(n));
const number = (n: number) => sure(parseReviewNumber(n));

function version(n: number, update?: TimelineVersion['update']): TimelineVersion {
	return { number: revision(n), arrivedAt: ago(10 - n), update };
}

function review(n: number, on: number, log: Partial<FinishedReview> = {}): FinishedReview {
	return {
		number: number(n),
		version: revision(on),
		submittedAt: ago(5),
		progress: {
			counted: unitCountOf(4),
			reviewed: unitCountOf(2),
			ignored: unitCountOf(0),
			uncategorised: unitCountOf(4)
		},
		comments: sure(parseCommentCount(1)),
		flags: sure(parseCommentCount(0)),
		overall: false,
		text: textForAgent('# Review\n'),
		posted: undefined,
		copied: undefined,
		read: undefined,
		...log
	};
}

const anchor = {
	path: sure(parseRepoPath('src/a.ts')),
	side: 'new' as const,
	first: lineNumberOf(1),
	last: lineNumberOf(2)
};

function thread(
	id: number,
	messages: readonly [number, number][],
	extra: Partial<ThreadToday> = {}
): ThreadToday {
	return {
		id: sure(parseThreadId(id)),
		kind: 'comment',
		messages: messages.map(([r, v]) => ({
			review: number(r),
			kind: 'comment',
			version: revision(v),
			anchor,
			body: `from ${String(r)}`,
			writtenAt: ago(6)
		})),
		resolutions: [],
		status: 'open',
		...extra
	};
}

describe('the timeline', () => {
	it('puts each review after the version it was finished on, by number', () => {
		const entries = timelineOf(
			[version(2), version(1), version(3)],
			[review(3, 3), review(1, 1), review(2, 1)]
		);
		expect(
			entries.map((e) =>
				e.kind === 'version' ? `v${String(e.version.number)}` : `r${String(e.review.number)}`
			)
		).toEqual(['v1', 'r1', 'r2', 'v2', 'v3', 'r3']);
	});

	it('says what a version brought', () => {
		expect(describeArrival(version(1))).toBe('The first version.');
		expect(
			describeArrival(
				version(2, {
					filesChanged: fileCountOf(1),
					filesGone: fileCountOf(0),
					newToReview: unitCountOf(2),
					newIgnored: unitCountOf(0),
					gone: unitCountOf(0),
					reviewedBefore: unitCountOf(0),
					reviewedKept: unitCountOf(0)
				})
			)
		).toBe('1 file changed: 2 changes new to review.');
	});

	it('says how a review was handed over, each way once', () => {
		expect(describeDeliveries(review(1, 1), NOW)).toEqual([]);
		const twice = { times: sure(parseHandoverCount(2)), first: ago(3), last: ago(1) };
		const once = { times: sure(parseHandoverCount(1)), first: ago(2), last: ago(2) };
		expect(
			describeDeliveries(
				review(1, 1, {
					posted: {
						postedAs: 'comment',
						address: sure(
							parseGitHubReviewAddress('https://github.com/acme/shop/pull/1#pullrequestreview-9')
						),
						inText: sure(parseCommentCount(0)),
						at: ago(4)
					},
					copied: twice,
					read: once
				}),
				NOW
			)
		).toEqual([
			'Posted to GitHub as a comment 4 hours ago',
			'Copied 2 times, last 1 hour ago',
			'Read by an agent 2 hours ago'
		]);
	});

	it('counts where the comments a review started stand today, leaving out replies', () => {
		const threads = [
			thread(1, [[1, 1]], { status: 'resolved' }),
			thread(
				2,
				[
					[1, 1],
					[2, 2]
				],
				{ status: 'changed' }
			),
			thread(3, [[2, 2]])
		];
		expect(describeToday(startedBy(threads, number(1)))).toBe(
			'Today: 1 code changed since, 1 resolved'
		);
		expect(describeToday(startedBy(threads, number(3)))).toBeUndefined();
	});

	it("lists a review's comments and replies against their versions, and what it resolved", () => {
		const threads = [
			thread(1, [[1, 1]], {
				status: 'resolved',
				resolutions: [{ review: number(2), resolved: true, version: revision(2) }]
			}),
			thread(
				2,
				[
					[1, 1],
					[2, 2]
				],
				{ status: 'changed' }
			)
		];
		const { items, resolutions } = reviewItems(threads, number(2));
		expect(items).toMatchObject([{ kind: 'reply', answers: 1, version: 2, status: 'changed' }]);
		expect(items.map(describeItemKind)).toEqual(['Reply to review 1']);
		expect(resolutions).toMatchObject([{ resolved: true, from: 1, status: 'resolved' }]);
		expect(reviewItems(threads, number(1)).items.map(describeItemKind)).toEqual([
			'Comment',
			'Comment'
		]);
	});
});
