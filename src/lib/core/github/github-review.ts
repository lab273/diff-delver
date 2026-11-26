/**
 * A finished review as one GitHub pull request review (DESIGN 8.6, the
 * GitHub bullet), pure: which of its comments GitHub can place on their
 * lines, and the review's text, which holds the overall review, every
 * comment GitHub cannot place, so nothing is left out, and the lines the
 * reviewer flagged to look at again, which are never threads on GitHub.
 *
 * **Which lines GitHub can take a comment on.** GitHub takes a line comment
 * only on a line its pull request's diff shows: a changed line, or one of the
 * unchanged lines around a change, three on each side, within one hunk. A
 * Delve of a pull request compares the same two trees GitHub does (the head,
 * and its merge base with the base branch) with three lines of context
 * (`CONTEXT_LINES`), so the hunks of the version reviewed are the lines
 * GitHub shows. A comment goes on its lines when every one of them is in
 * one hunk of the file on its side; a run takes `start_line` as well, and
 * GitHub asks that both ends are in the same hunk. Otherwise it goes in the
 * review's text, with its file, its lines and the code it is on:
 *
 * - its lines are in an earlier version than the one reviewed, since GitHub
 *   places comments on the reviewed version's commit;
 * - they are unchanged lines outside every hunk, opened from the folded
 *   lines, or a run that reaches outside a hunk or across two;
 * - the file has no lines GitHub shows: a binary file, an image, a submodule;
 * - they are the old side of a copy, which GitHub shows as a new file;
 * - its path is not valid UTF-8, which GitHub cannot name.
 *
 * The two diffs could still differ: diff delver's uses the histogram
 * algorithm and detects copies, GitHub's may place a hunk's edge a line
 * apart, or not see a rename. GitHub then refuses the whole review, and the
 * service posts it again with every comment in its text (`allInText`).
 */
import { commentCountOf, type CommentCount } from '../comment-count.tiny.ts';
import type { Diff, DiffFile } from '../diff/diff.ts';
import { hunksOf } from '../diff/file-diff.ts';
import { agentPath } from '../diff/agent-text.ts';
import { languageOf } from '../highlight/language.ts';
import type { LineNumber } from '../line-number.tiny.ts';
import { hasOddBytes } from '../path-codec.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { ReportId } from '../report-id.tiny.ts';
import type { ReviewNumber } from '../review-number.tiny.ts';
import type { ReviewMark } from './review-mark.tiny.ts';
import { closingOpenBlocks } from './open-blocks.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { isWritten } from '../review/overall-review.ts';
import { longestRun, quotedLine, type SubmittedComment } from '../review/review-export.ts';
import { countOf } from '../viewer/words.ts';

/** What a review posted to GitHub says of the pull request, the reviewer's choice. */
export type GitHubReviewKind = 'comment' | 'approve' | 'request-changes';

/** The kinds in the order the page offers them, Comment first, as it starts. */
export const GITHUB_REVIEW_KINDS: readonly GitHubReviewKind[] = [
	'comment',
	'approve',
	'request-changes'
];

/**
 * How a review is posted: published at once as `kind`, or left as a draft on
 * GitHub, a pending review only the reviewer sees until they submit it there,
 * when GitHub asks what kind it is, so `kind` is set aside.
 */
export interface GitHubPosting {
	readonly kind: GitHubReviewKind;
	readonly draft: boolean;
}

/** What a posted review was on GitHub: published as one of the kinds, or a draft. */
export type PostedAs = GitHubReviewKind | 'draft';

export function postedAs(posting: GitHubPosting): PostedAs {
	return posting.draft ? 'draft' : posting.kind;
}

/** The `event` GitHub's API takes for a kind; a draft is posted with none. */
export function gitHubEvent(kind: GitHubReviewKind): 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' {
	switch (kind) {
		case 'comment':
			return 'COMMENT';
		case 'approve':
			return 'APPROVE';
		case 'request-changes':
			return 'REQUEST_CHANGES';
	}
}

/** A kind as the page names it: "Comment", "Approve", "Request changes". */
export function gitHubReviewKindName(kind: GitHubReviewKind): string {
	switch (kind) {
		case 'comment':
			return 'Comment';
		case 'approve':
			return 'Approve';
		case 'request-changes':
			return 'Request changes';
	}
}

/** How a review was posted, in words that follow "Posted to GitHub": "as a comment". */
export function describePostedAs(posted: PostedAs): string {
	switch (posted) {
		case 'comment':
			return 'as a comment';
		case 'approve':
			return 'as an approval';
		case 'request-changes':
			return 'as a request for changes';
		case 'draft':
			return 'as a draft';
	}
}

/** GitHub's name for a side of a file's diff: LEFT is before the change, RIGHT after. */
export type GitHubSide = 'LEFT' | 'RIGHT';

function gitHubSide(side: Side): GitHubSide {
	return side === 'old' ? 'LEFT' : 'RIGHT';
}

/** A comment as GitHub takes it on its lines: the last line, and the first of a run. */
export interface GitHubLineComment {
	/** The file's path in the pull request: its new path, or its old one when it was deleted. */
	readonly path: RepoPath;
	readonly side: GitHubSide;
	readonly line: LineNumber;
	/** The first line of a run of more than one; undefined for a single line. */
	readonly startLine: LineNumber | undefined;
	readonly body: string;
}

/** Why a comment goes in the review's text and not on its lines; a flag always does. */
export type InTextBecause =
	'earlier-version' | 'outside-the-diff' | 'no-lines-shown' | 'copied' | 'path-not-shown' | 'flag';

/** Where a comment goes on GitHub: on its lines, or in the review's text, and why. */
export type Placement =
	| { readonly kind: 'line'; readonly comment: GitHubLineComment }
	| { readonly kind: 'text'; readonly because: InTextBecause };

/**
 * The file of the diff a comment's lines are in: the one whose side has the
 * comment's path. The old side of a file that was copied has its source's
 * path, as the source itself has, so the source is preferred.
 */
function fileOf(diff: Diff, path: RepoPath, side: Side): DiffFile | undefined {
	let copy: DiffFile | undefined;
	for (const file of diff.files) {
		if (file.file[side]?.path !== path) continue;
		if (file.file.status !== 'copied') return file;
		copy ??= file;
	}
	return copy;
}

/** Where `comment` goes on GitHub, when the review is posted on `version`, whose diff is `diff`. */
export function placeComment(
	diff: Diff,
	version: RevisionNumber,
	comment: SubmittedComment
): Placement {
	// A flag is the reviewer's note to look again, listed in the text, never a thread on GitHub.
	if (comment.kind === 'flag') return { kind: 'text', because: 'flag' };
	if (comment.version !== version) return { kind: 'text', because: 'earlier-version' };
	const { path, side, first, last } = comment.anchor;
	const file = fileOf(diff, path, side);
	if (file === undefined) return { kind: 'text', because: 'outside-the-diff' };
	if (hasOddBytes(file.file.path)) return { kind: 'text', because: 'path-not-shown' };
	if (file.file.content.kind !== 'text') return { kind: 'text', because: 'no-lines-shown' };
	if (side === 'old' && file.file.status === 'copied') return { kind: 'text', because: 'copied' };
	const inOneHunk = hunksOf(file.file).some((hunk) => {
		const span = hunk[side];
		return span.length > 0 && first >= span.start && last <= span.start + span.length - 1;
	});
	if (!inOneHunk) return { kind: 'text', because: 'outside-the-diff' };
	return {
		kind: 'line',
		comment: {
			path: file.file.path,
			side: gitHubSide(side),
			line: last,
			startLine: first === last ? undefined : first,
			body: comment.body
		}
	};
}

/** The review as GitHub's API takes it: its text, and the comments on their lines. */
export interface GitHubReviewDraft {
	readonly body: string;
	readonly comments: readonly GitHubLineComment[];
	/** How many comments are in the text instead of on their lines; flags are not counted. */
	readonly inText: CommentCount;
}

export interface GitHubReviewInput {
	readonly report: ReportId;
	readonly number: ReviewNumber;
	readonly diff: Diff;
	/** The version the review is finished on, whose head commit it is posted on. */
	readonly version: RevisionNumber;
	/** The overall review, exactly as typed; '' when none was written. */
	readonly overall: string;
	/** Its comments and flags, in the order they were made. */
	readonly comments: readonly SubmittedComment[];
	/** Every comment in the text, as when GitHub refused to place them on their lines. */
	readonly allInText: boolean;
	/**
	 * The secret part of the review's mark, made for this post; undefined to
	 * leave the mark out, as what will be posted is shown before it is made.
	 */
	readonly mark: ReviewMark | undefined;
}

/**
 * The mark at the end of every review diff delver posts, which GitHub does
 * not show (an HTML comment): it names the Delve and the review, with a
 * secret made for the post, so a post that GitHub took, but whose answer
 * never came, is found on GitHub before it would be posted again, and a
 * review someone else wrote to look like it cannot be, since its secret
 * is not known until it is posted.
 */
export function reviewMarker(report: ReportId, number: ReviewNumber, mark: ReviewMark): string {
	return `<!-- diff delver: review ${String(number)} of ${report}, ${mark} -->`;
}

/** Whether a review's text on GitHub carries the mark of review `number` of `report`, made for one post. */
export function hasReviewMarker(
	body: string,
	report: ReportId,
	number: ReviewNumber,
	mark: ReviewMark
): boolean {
	return body.includes(reviewMarker(report, number, mark));
}

/**
 * The most characters GitHub takes in a review's text, and in each comment
 * on its lines; it refuses a review with more.
 */
export const GITHUB_TEXT_LIMIT = 65_536;

/** How many characters GitHub counts in text: one for each character, however it is encoded. */
export function gitHubLength(text: string): number {
	const pairs = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
	return text.length - pairs;
}

/**
 * Whether the review is too long for GitHub: its text, or a comment on its
 * lines, past `GITHUB_TEXT_LIMIT`, and how long the longest is; undefined
 * when GitHub takes it.
 */
export function tooLongForGitHub(review: GitHubReviewDraft): number | undefined {
	const longest = Math.max(
		gitHubLength(review.body),
		...review.comments.map((c) => gitHubLength(c.body))
	);
	return longest > GITHUB_TEXT_LIMIT ? longest : undefined;
}

/** The heading over the comments in the review's text. */
export const IN_TEXT_HEADING = '**Comments on lines GitHub does not show**';

/** The heading over the flags in the review's text. */
export const FLAGS_HEADING = '**Flagged for another look**';

/**
 * The review as GitHub takes it: the overall review, the comments it cannot
 * place, the flags, and the mark.
 */
export function gitHubReview(input: GitHubReviewInput): GitHubReviewDraft {
	const onLines: GitHubLineComment[] = [];
	const inText: SubmittedComment[] = [];
	const flags: SubmittedComment[] = [];
	for (const comment of input.comments) {
		if (comment.kind === 'flag') {
			flags.push(comment);
			continue;
		}
		const placed: Placement = input.allInText
			? { kind: 'text', because: 'outside-the-diff' }
			: placeComment(input.diff, input.version, comment);
		if (placed.kind === 'line') onLines.push(placed.comment);
		else inText.push(comment);
	}
	const parts: string[] = [];
	if (isWritten(input.overall)) {
		// Whatever the overall review leaves open is ended, so nothing after it is swallowed or hidden.
		const closing = closingOpenBlocks(input.overall);
		parts.push(closing === '' ? input.overall : `${input.overall}\n${closing}`);
	}
	if (inText.length > 0) {
		parts.push(
			[IN_TEXT_HEADING, ...inText.map((c) => inTextComment(c, input.version))].join('\n\n')
		);
	}
	if (flags.length > 0) {
		parts.push([FLAGS_HEADING, ...flags.map((f) => inTextFlag(f, input.version))].join('\n\n'));
	}
	if (input.mark !== undefined) parts.push(reviewMarker(input.report, input.number, input.mark));
	return { body: parts.join('\n\n'), comments: onLines, inText: commentCountOf(inText.length) };
}

/**
 * A comment in the review's text: its file and lines, the code it is on, as
 * the text copied quotes it, and the reviewer's words as a quote, so nothing
 * in them opens structure in the text around them.
 */
function inTextComment(comment: SubmittedComment, version: RevisionNumber): string {
	const { path, first, last } = comment.anchor;
	const code = comment.quoted.map(quotedLine);
	const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
	const total = last - first + 1;
	const out = [placeInText(comment, version), ''];
	if (code.length > 0) out.push(`${fence}${languageOf(path) ?? ''}`, ...code, fence);
	if (code.length < total && code.length > 0) {
		out.push(`(The first ${countOf(code.length, 'line', 'lines')} of ${String(total)}.)`);
	}
	out.push(...comment.body.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)));
	return out.join('\n');
}

/** Where a comment or a flag is, in the review's text: its file, its lines and their side. */
function placeInText(comment: SubmittedComment, version: RevisionNumber): string {
	const { path, side, first, last } = comment.anchor;
	const lines = first === last ? `line ${String(first)}` : `lines ${String(first)}–${String(last)}`;
	const shownSide = side === 'old' ? 'before the change' : 'after the change';
	const earlier = comment.version === version ? '' : `, in version ${String(comment.version)}`;
	return `${inlineCode(agentPath(path))}, ${lines} (${shownSide}${earlier})`;
}

/** A flag in the review's text: where it is, and the reviewer's words, if any, as a quote. */
function inTextFlag(flag: SubmittedComment, version: RevisionNumber): string {
	const out = [placeInText(flag, version)];
	if (flag.body.trim() !== '') {
		out.push('', ...flag.body.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)));
	}
	return out.join('\n');
}

/** Text as Markdown's inline code, with enough backticks round it that none inside closes it. */
function inlineCode(text: string): string {
	const ticks = '`'.repeat(longestRun([text], '`') + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${ticks}${pad}${text}${pad}${ticks}`;
}
