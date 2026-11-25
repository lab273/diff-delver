import { describe, expect, it } from 'vitest';
import {
	MAX_OVERALL_REVIEW_LENGTH,
	TEASER_LENGTH,
	describeDraftComments,
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
	});
});
