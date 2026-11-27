import { describe, expect, it } from 'vitest';
import {
	MAX_OVERALL_REVIEW_LENGTH,
	TEASER_LENGTH,
	describeDraft,
	describeDraftComments,
	describeReviewContents,
	isOverallReviewBody,
	isWritten,
	storedOverallReview,
	teaserOf
} from './overall-review.ts';

describe('the teaser of an overall review', () => {
	it('is undefined when nothing is written, white space included', () => {
		expect(teaserOf('')).toBeUndefined();
		expect(teaserOf(' \n\t ')).toBeUndefined();
	});

	it('is short words as they are, on one line', () => {
		expect(teaserOf('  Looks good.\n\nShip it\tafter the fix. ')).toBe(
			'Looks good. Ship it after the fix.'
		);
	});

	it('cuts long words at a space before the limit, with an ellipsis', () => {
		const words =
			'The discount code path is right, but the totals need a test for negative amounts and for rounding to cents.';
		const teaser = teaserOf(words) ?? '';
		expect(teaser.endsWith('…')).toBe(true);
		expect(Array.from(teaser).length).toBeLessThanOrEqual(TEASER_LENGTH + 1);
		expect(words.startsWith(teaser.slice(0, -1))).toBe(true);
		expect(teaser.at(-2)).not.toBe(' ');
		expect(teaser).toBe(
			'The discount code path is right, but the totals need a test for negative amounts and for…'
		);
	});

	it('cuts a word longer than the limit where it reaches it, by characters, not code units', () => {
		const long = '😀'.repeat(TEASER_LENGTH + 5);
		expect(teaserOf(long)).toBe(`${'😀'.repeat(TEASER_LENGTH)}…`);
	});
});

describe('the words of an overall review', () => {
	it('count as written only when more than white space', () => {
		expect(isWritten('a')).toBe(true);
		expect(isWritten(' \n')).toBe(false);
	});

	it('are stored as typed, or as nothing when only white space', () => {
		expect(storedOverallReview('  Keep\n  this ')).toBe('  Keep\n  this ');
		expect(storedOverallReview('\n \n')).toBe('');
	});

	it('may be nothing, and up to the limit', () => {
		expect(isOverallReviewBody('')).toBe(true);
		expect(isOverallReviewBody('x'.repeat(MAX_OVERALL_REVIEW_LENGTH))).toBe(true);
		expect(isOverallReviewBody('x'.repeat(MAX_OVERALL_REVIEW_LENGTH + 1))).toBe(false);
	});
});

describe('the draft’s comments in words', () => {
	it('says none, one, or how many', () => {
		expect(describeDraftComments(0)).toBe('No comments yet');
		expect(describeDraftComments(1)).toBe('1 comment');
		expect(describeDraftComments(1234)).toBe('1,234 comments');
		expect(describeDraftComments(3, 1)).toBe('3 comments and 1 flag');
		expect(describeDraftComments(0, 2)).toBe('2 flags');
	});
});

describe('the draft on one line', () => {
	const of = (counts: Partial<Parameters<typeof describeDraft>[0]>) =>
		describeDraft({
			comments: 0,
			flags: 0,
			replies: 0,
			resolutions: 0,
			beingWritten: 0,
			...counts
		});
	it('says none, or what is saved, then what is being written', () => {
		expect(of({})).toBe('No comments yet');
		expect(of({ comments: 3, flags: 1, replies: 1 })).toBe('3 comments, 1 flag and 1 reply');
		expect(of({ replies: 2, resolutions: 1 })).toBe(
			'2 replies and 1 earlier comment resolved or reopened'
		);
		expect(of({ beingWritten: 1 })).toBe('1 comment being written');
		expect(of({ comments: 1, beingWritten: 2 })).toBe('1 comment, 2 more being written');
	});
});

describe('what a review holds, in words', () => {
	it('names the overall review first, and counts the comments', () => {
		const of = (comments: number, overall: boolean, flags = 0) => ({ comments, flags, overall });
		expect(describeReviewContents(of(2, true))).toBe('your overall review and 2 comments');
		expect(describeReviewContents(of(1, false))).toBe('your 1 comment');
		expect(describeReviewContents(of(0, true))).toBe('your overall review');
		expect(describeReviewContents(of(0, true), 'listed')).toBe('an overall review');
		expect(describeReviewContents(of(3, true), 'listed')).toBe('an overall review and 3 comments');
		expect(describeReviewContents(of(3, false), 'listed')).toBe('3 comments');
		expect(describeReviewContents(of(2, true, 1))).toBe(
			'your overall review, 2 comments and 1 flag'
		);
		expect(describeReviewContents(of(0, false, 2))).toBe('your 2 flags');
		expect(describeReviewContents(of(0, true, 1), 'listed')).toBe('an overall review and 1 flag');
	});
});
