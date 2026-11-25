/**
 * The reviewer's overall review of a Delve (DESIGN 6.3, "an optional
 * summary"): their own words on the change as a whole, part of the draft like
 * its comments, handed over first when the review is finished. Its words are
 * kept exactly as typed; words that are only white space are nothing written,
 * so clearing the box and saving empties it.
 */
import type { EditCount } from '../edit-count.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { countOf } from '../viewer/words.ts';

/** The most characters an overall review holds. */
export const MAX_OVERALL_REVIEW_LENGTH = 20_000;

/** The most characters of a teaser, before its ellipsis. */
export const TEASER_LENGTH = 90;

/** The draft's overall review: its words ('' for none), when they last changed, and how often. */
export interface OverallReview {
	readonly body: string;
	/** When its words last changed; undefined when they never have. */
	readonly changedAt: Timestamp | undefined;
	/**
	 * How many times its words have been changed, on this Delve, ever: it is
	 * never reset, so a page that read an older count changes nothing.
	 */
	readonly edits: EditCount;
}

/** Whether `body` holds anything: words that are only white space hold nothing. */
export function isWritten(body: string): boolean {
	return body.trim() !== '';
}

/** Whether `body` can be saved as the overall review: nothing, or words that are not too long. */
export function isOverallReviewBody(body: string): boolean {
	return body.length <= MAX_OVERALL_REVIEW_LENGTH;
}

/** The words as stored: as typed, or nothing when they are only white space. */
export function storedOverallReview(body: string): string {
	return isWritten(body) ? body : '';
}

/**
 * The first words of an overall review, on one line, as a bar shows it put
 * away: every run of white space one space, cut at the last space before
 * `TEASER_LENGTH` characters with an ellipsis. Undefined when nothing is written.
 */
export function teaserOf(body: string): string | undefined {
	const line = body.replace(/\s+/g, ' ').trim();
	if (line === '') return undefined;
	const chars = Array.from(line);
	if (chars.length <= TEASER_LENGTH) return line;
	const cut = chars.slice(0, TEASER_LENGTH).join('');
	const space = cut.lastIndexOf(' ');
	// A first word longer than a teaser is cut where it reaches the end.
	const kept = space > TEASER_LENGTH / 2 ? cut.slice(0, space) : cut;
	return `${kept.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** How many comments the draft holds, in words: "No comments yet", "1 comment", "3 comments". */
export function describeDraftComments(count: number): string {
	return count === 0 ? 'No comments yet' : countOf(count, 'comment', 'comments');
}

/**
 * What a review holds, in words: "your overall review and 2 comments", "your
 * 1 comment", "your overall review"; as a finished one is listed, "an overall
 * review and 2 comments", "1 comment".
 */
export function describeReviewContents(
	comments: number,
	overall: boolean,
	as: 'yours' | 'listed' = 'yours'
): string {
	const counted = countOf(comments, 'comment', 'comments');
	if (!overall) return as === 'yours' ? `your ${counted}` : counted;
	const what = comments === 0 ? 'overall review' : `overall review and ${counted}`;
	return as === 'yours' ? `your ${what}` : `an ${what}`;
}
