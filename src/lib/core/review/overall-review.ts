/**
 * The reviewer's overall review of a Delve (DESIGN 6.3, "an optional
 * summary"): their own words on the change as a whole, part of the draft like
 * its comments, handed over first when the review is finished. Its words are
 * kept exactly as typed; words that are only white space are nothing written,
 * so clearing the box and saving empties it.
 */
import type { EditCount } from '../edit-count.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { countOf, formatCount } from '../viewer/words.ts';

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

/**
 * How many comments and flags the draft holds, in words: "No comments yet",
 * "1 comment", "3 comments and 1 flag", "2 flags".
 */
export function describeDraftComments(count: number, flags = 0): string {
	if (count === 0 && flags === 0) return 'No comments yet';
	return inWords([
		count === 0 ? undefined : countOf(count, 'comment', 'comments'),
		flags === 0 ? undefined : countOf(flags, 'flag', 'flags')
	]);
}

/** What the draft holds besides its overall review, as its footer counts it put away. */
export interface DraftCounts {
	/** Saved comments that are not replies to an earlier review's thread. */
	readonly comments: number;
	readonly flags: number;
	/** Saved replies to threads of earlier reviews. */
	readonly replies: number;
	/** Threads of earlier reviews the draft resolves or opens again. */
	readonly resolutions: number;
	/** Comments being written and not saved yet, with words worth keeping. */
	readonly beingWritten: number;
}

/**
 * The draft in words, on one line: "No comments yet", "3 comments, 1 flag
 * and 1 reply", "2 comments and 1 earlier comment resolved or reopened",
 * "1 comment being written", "1 comment, 2 more being written", "1 flag, 2
 * comments being written".
 */
export function describeDraft({
	comments,
	flags,
	replies,
	resolutions,
	beingWritten
}: DraftCounts): string {
	const saved = inWords([
		comments === 0 ? undefined : countOf(comments, 'comment', 'comments'),
		flags === 0 ? undefined : countOf(flags, 'flag', 'flags'),
		replies === 0 ? undefined : countOf(replies, 'reply', 'replies'),
		resolutions === 0
			? undefined
			: countOf(
					resolutions,
					'earlier comment resolved or reopened',
					'earlier comments resolved or reopened'
				)
	]);
	if (beingWritten === 0) return saved === '' ? 'No comments yet' : saved;
	const writing = `${countOf(beingWritten, 'comment', 'comments')} being written`;
	if (saved === '') return writing;
	// "More" only after comments alone, so it never reads as more flags or replies.
	const onlyComments = flags === 0 && replies === 0 && resolutions === 0;
	return onlyComments
		? `${saved}, ${formatCount(beingWritten)} more being written`
		: `${saved}, ${writing}`;
}

/** What a review holds: how many comments and flags, and whether an overall review. */
export interface ReviewContents {
	readonly comments: number;
	readonly flags: number;
	readonly overall: boolean;
	/** How many comments of earlier reviews it resolves or opens again; left out, none. */
	readonly resolutions?: number;
}

/**
 * What a review holds, in words: "your overall review and 2 comments", "your
 * 1 comment", "your overall review", "your 2 comments and 1 flag"; as a
 * finished one is listed, "an overall review and 2 comments", "1 comment".
 */
export function describeReviewContents(
	{ comments, flags, overall, resolutions = 0 }: ReviewContents,
	as: 'yours' | 'listed' = 'yours'
): string {
	const what = inWords([
		overall ? 'overall review' : undefined,
		comments > 0 || (!overall && flags === 0 && resolutions === 0)
			? countOf(comments, 'comment', 'comments')
			: undefined,
		flags === 0 ? undefined : countOf(flags, 'flag', 'flags'),
		resolutions === 0
			? undefined
			: countOf(
					resolutions,
					'earlier comment resolved or reopened',
					'earlier comments resolved or reopened'
				)
	]);
	if (as === 'yours') return `your ${what}`;
	return overall ? `an ${what}` : what;
}

/** Things in words, as a list is said: "a", "a and b", "a, b and c". */
function inWords(things: readonly (string | undefined)[]): string {
	const said = things.filter((t) => t !== undefined);
	const last = said.at(-1) ?? '';
	return said.length <= 1 ? last : `${said.slice(0, -1).join(', ')} and ${last}`;
}
