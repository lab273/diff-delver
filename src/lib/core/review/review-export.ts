/**
 * A finished review as text written for a language model (DESIGN 8.6): what
 * the reviewer copies with "Finish and copy" and what `get_review` gives an
 * agent, the same text. The reviewer's overall review, when they wrote one,
 * comes first, under its own heading. Each comment names its file, its lines and the side
 * they are on, quotes the code it is on as the snapshot held it when the
 * review was finished, then gives the reviewer's words exactly as typed, quoted. The
 * lines the reviewer flagged to look at again follow, under "Flagged for
 * another look", each with any words they wrote, quoted the same way. Last
 * comes what was not reviewed, group by group.
 *
 * Threads from earlier reviews (`threads.ts`) come before the comments, under
 * "Still open from earlier reviews": each one open, or whose code changed
 * since, at its lines in the version the review is finished on, with the
 * review it is from, whether its code changed since and the words said in it,
 * then this review's reply, if any. Those resolved in this review follow,
 * under "Resolved in this review". A thread whose lines are gone names them
 * as they were, on its version, and quotes the code it was on.
 *
 * Text from the repository (paths, section titles, code) is written as the
 * agent's other answers write it: paths as `agentPath` does, and each
 * character that cannot be seen, or turns text round, as an escape, so code
 * can never pass for the review's own lines. Only the reviewer's words are
 * kept as they are, since they are the review, and given as a blockquote, so
 * nothing in them can pass for the review's own lines either.
 */
import type { CommitId } from '../commit-id.tiny.ts';
import type { Diff } from '../diff/diff.ts';
import { jsonQuoted } from '../json-quoted.ts';
import { agentPath, hiddenShown } from '../diff/agent-text.ts';
import { groupOf, inReadingOrder, type GroupKey } from '../diff/slices.ts';
import { assignedUnits, type AssignmentState } from '../diff/state.ts';
import { groupKeyId, type GroupKeyId } from '../group-key-id.tiny.ts';
import { visibleText } from '../hidden-characters.ts';
import { languageOf } from '../highlight/language.ts';
import type { LineText } from '../line-text.tiny.ts';
import type { UnitProgress, Section } from '../reports/report.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { ReportId } from '../report-id.tiny.ts';
import type { ReviewNumber } from '../review-number.tiny.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { SectionTitle } from '../section-title.tiny.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import type { CommentCount } from '../comment-count.tiny.ts';
import type { GitHubReviewAddress } from '../github/github-review-address.tiny.ts';
import type { PostedAs } from '../github/github-review.ts';
import { countOf, formatCount } from '../viewer/words.ts';
import type { CommentAnchor, ThreadKind } from './draft-comment.ts';
import { isWritten } from './overall-review.ts';
import type { ThreadStatus } from './threads.ts';
import { countWithin } from './progress.ts';
import { fileUnitReviewed, reviewedLines, type ReviewedMarks } from './reviewed-marks.ts';

/** At most this many lines of code are quoted with a comment; the rest are counted. */
export const MAX_QUOTED_LINES = 40;

/** A quoted line longer than this is cut, saying so. */
export const MAX_QUOTED_LINE_LENGTH = 500;

/** At most this many files are named for each group under "Not reviewed"; the rest are counted. */
export const MAX_FILES_NAMED = 30;

/**
 * One comment or flag of a finished review, with the code a comment is on as
 * it was when the review was finished.
 */
export interface SubmittedComment {
	readonly kind: ThreadKind;
	readonly anchor: CommentAnchor;
	/** The version of the report its lines are in. */
	readonly version: RevisionNumber;
	/** The reviewer's words, exactly as typed; a flag's may be ''. */
	readonly body: string;
	/** The first `MAX_QUOTED_LINES` lines of its range, from its version's snapshot; none for a flag. */
	readonly quoted: readonly LineText[];
}

/**
 * A thread from an earlier review as a finished review hands it over: the
 * comment or flag that started it, what was said in it since, where it is in
 * the version the review is finished on and how it stood there, and what this
 * review did to it.
 */
export interface ExportedThread {
	/** The comment or flag that started it, with the code it was on. */
	readonly start: SubmittedComment;
	/** The review it started in. */
	readonly from: ReviewNumber;
	/** Replies to it in earlier reviews, oldest first. */
	readonly replies: readonly { readonly review: ReviewNumber; readonly body: string }[];
	/** Its lines in the version the review is finished on; undefined when they are gone. */
	readonly at: CommentAnchor | undefined;
	/** How it stood in that version before this review. */
	readonly status: ThreadStatus;
	/** This review's reply to it, exactly as typed. */
	readonly reply: string | undefined;
	/** Whether this review resolved it, opened it again, or neither. */
	readonly action: 'resolved' | 'reopened' | undefined;
}

/** A group with changes nobody marked reviewed, and its files that have them. */
export interface NotReviewedGroup {
	readonly group:
		{ readonly kind: 'section'; readonly title: SectionTitle } | { readonly kind: 'uncategorised' };
	readonly files: readonly NotReviewedFile[];
}

export interface NotReviewedFile {
	readonly path: RepoPath;
	/** Whether some of its changes in the group are marked reviewed. */
	readonly partly: boolean;
}

/**
 * The groups of the sections view, in reading order, whose changes are not all
 * marked reviewed, each with those files. Ignored is left out: it is not
 * counted as something to review.
 */
export function notReviewed(
	diff: Diff,
	state: AssignmentState,
	marks: ReviewedMarks,
	sections: readonly Section[]
): readonly NotReviewedGroup[] {
	const titles = new Map(sections.map((s) => [s.id, s.title]));
	const groups = new Map<GroupKeyId, { key: GroupKey; files: NotReviewedFile[] }>();
	for (const file of diff.files) {
		const path = file.file.path;
		const old = reviewedLines(marks, path, 'old');
		const now = reviewedLines(marks, path, 'new');
		const tallies = new Map<GroupKeyId, { key: GroupKey; units: number; reviewed: number }>();
		for (const units of assignedUnits(state, file)) {
			const key = groupOf('sections', units.assignment);
			if (key.kind === 'ignored') continue;
			const id = groupKeyId(key);
			const tally = tallies.get(id) ?? { key, units: 0, reviewed: 0 };
			tallies.set(id, tally);
			if (units.kind === 'file') {
				tally.units += 1;
				if (fileUnitReviewed(marks, path)) tally.reviewed += 1;
			} else {
				const { side, first, last } = units.range;
				tally.units += last - first + 1;
				tally.reviewed += countWithin(side === 'old' ? old : now, first, last);
			}
		}
		for (const [id, tally] of tallies) {
			if (tally.reviewed === tally.units) continue;
			const group = groups.get(id) ?? { key: tally.key, files: [] };
			groups.set(id, group);
			group.files.push({ path, partly: tally.reviewed > 0 });
		}
	}
	return inReadingOrder(
		[...groups.values()],
		(g) => g.key,
		sections.map((s) => s.id)
	).flatMap((g): NotReviewedGroup[] => {
		switch (g.key.kind) {
			case 'section': {
				const title = titles.get(g.key.section);
				return title === undefined ? [] : [{ group: { kind: 'section', title }, files: g.files }];
			}
			case 'uncategorised':
				return [{ group: { kind: 'uncategorised' }, files: g.files }];
			case 'tests':
			case 'ignored':
				return [];
		}
	});
}

/** Everything a finished review's text is made from. */
export interface ReviewExportInput {
	readonly number: ReviewNumber;
	readonly report: ReportId;
	/** The source in plain words, such as "Uncommitted changes". */
	readonly title: ReviewerMessage;
	/** The repository's folder name. */
	readonly repository: ReviewerMessage;
	/** The version the review was finished on. */
	readonly version: RevisionNumber;
	/** The commit that version's new side is, when it is one: not for uncommitted changes. */
	readonly headCommit: CommitId | undefined;
	/** The reviewer's overall review, exactly as typed; '' when they wrote none. */
	readonly overall: string;
	readonly comments: readonly SubmittedComment[];
	/** Threads from earlier reviews, in the order they were started; left out, none. */
	readonly threads?: readonly ExportedThread[];
	readonly notReviewed: readonly NotReviewedGroup[];
	readonly progress: UnitProgress;
}

/**
 * Whether a thread is listed as still open by this review: open, or with its
 * code changed since, or replied to or opened again in it, and not resolved by it.
 */
export function stillOpen(thread: ExportedThread): boolean {
	if (thread.action === 'resolved') return false;
	return thread.status !== 'resolved' || thread.action === 'reopened';
}

/** Whether this review replied to a thread resolved earlier, and left it resolved. */
export function repliedWhileResolved(thread: ExportedThread): boolean {
	return thread.status === 'resolved' && thread.action === undefined && thread.reply !== undefined;
}

/**
 * Whether this review did something to a thread: replied to it, resolved it
 * or opened it again. Only those go to GitHub, whose text would otherwise
 * repeat every open thread in every review.
 */
export function touchedByReview(thread: ExportedThread): boolean {
	return thread.reply !== undefined || thread.action !== undefined;
}

/** A finished review as Markdown written for a language model. */
export function renderReviewExport(input: ReviewExportInput): TextForAgent {
	const written = isWritten(input.overall);
	const comments = input.comments.filter((c) => c.kind === 'comment');
	const flags = input.comments.filter((c) => c.kind === 'flag');
	const threads = input.threads ?? [];
	const open = threads.filter(stillOpen);
	const resolved = threads.filter((t) => t.action === 'resolved');
	const answered = threads.filter(repliedWhileResolved);
	const out: string[] = [
		`# Review ${String(input.number)} of ${visibleText(input.title)} in ${visibleText(input.repository)}`,
		'',
		`A code review from diff delver: report ${input.report}, version ${String(input.version)}${input.headCommit === undefined ? '' : `, whose new side is commit ${input.headCommit.slice(0, 7)}`}. Each comment names a file, its lines, and the side they are on: (new) is the file after the change, (old) before it. The code each comment is on is quoted as it was when the review was finished, and the reviewer’s words follow it, each line after a >.${written ? ' The reviewer’s overall review of the change comes first, quoted the same way.' : ''}${open.length > 0 ? ' Comments from earlier reviews that are still open come before this review’s own, each at its lines in this version, with the review it is from and whether its code changed since then; it may have been dealt with.' : ''}${flags.length > 0 ? ' Lines the reviewer flagged to look at again are listed after the comments, named the same way, with any words they wrote quoted the same way.' : ''}`,
		''
	];
	if (written) out.push('## Overall', '', ...wordsQuoted(input.overall), '');
	if (open.length > 0) {
		out.push('## Still open from earlier reviews');
		for (const thread of open) out.push('', ...threadLines(thread, input.version));
		out.push('');
	}
	if (resolved.length > 0) {
		out.push('## Resolved in this review');
		for (const thread of resolved) out.push('', ...threadLines(thread, input.version));
		out.push('');
	}
	if (answered.length > 0) {
		out.push('## Replies on resolved comments');
		for (const thread of answered) out.push('', ...threadLines(thread, input.version));
		out.push('');
	}
	out.push('## Comments');
	if (comments.length === 0) out.push('', 'No comments.');
	for (const comment of comments) out.push('', ...commentLines(comment, input.version));
	if (flags.length > 0) {
		out.push('', '## Flagged for another look', '');
		for (const flag of flags) out.push(...flagLines(flag, input.version));
	}
	out.push('', '## Not reviewed', '', coverageLine(input.progress));
	if (input.notReviewed.length > 0) out.push('');
	for (const group of input.notReviewed) out.push(groupLine(group));
	return textForAgent(`${out.join('\n')}\n`);
}

/** Where a comment or a flag is, as its heading or its item names it: `src/a.ts:3-5 (new)`. */
function placeOf(comment: SubmittedComment, version: RevisionNumber): string {
	const { path, side, first, last } = comment.anchor;
	const lines = first === last ? String(first) : `${String(first)}-${String(last)}`;
	const where = comment.version === version ? side : `${side}, version ${String(comment.version)}`;
	return `${agentPath(path)}:${lines} (${where})`;
}

/** How a thread's code stands, in a few words: "unchanged", "changed since", "its lines are gone". */
export function threadStanding(thread: ExportedThread): string {
	if (thread.at === undefined) return 'its lines are gone';
	if (thread.status === 'resolved' && thread.action === undefined) return 'resolved before';
	if (thread.status === 'changed') return 'changed since';
	return thread.action === 'reopened' ? 'opened again' : 'unchanged';
}

/**
 * A thread from an earlier review: where it is now, the review it is from and
 * how its code stands, the words said in it, and this review's reply. One
 * whose lines are gone is named where it was, with the code it was on.
 */
function threadLines(thread: ExportedThread, version: RevisionNumber): string[] {
	const what = thread.start.kind === 'flag' ? 'flagged in' : 'from';
	const changed = threadStanding(thread);
	const place =
		thread.at === undefined
			? placeOf(thread.start, version)
			: placeOf({ ...thread.start, anchor: thread.at, version }, version);
	const out = [`### ${place}, ${what} review ${String(thread.from)}, ${changed}`];
	if (thread.at === undefined && thread.start.quoted.length > 0) {
		const code = thread.start.quoted.map((text) => quotedLine(text));
		const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
		out.push(`${fence}${languageOf(thread.start.anchor.path) ?? ''}`, ...code, fence);
	}
	if (thread.start.body.trim() !== '') out.push(...wordsQuoted(thread.start.body));
	for (const reply of thread.replies) {
		out.push(`Reply in review ${String(reply.review)}:`, ...wordsQuoted(reply.body));
	}
	if (thread.reply !== undefined) out.push('Reply in this review:', ...wordsQuoted(thread.reply));
	return out;
}

/**
 * A flag as an item of the list: where it is, and the reviewer's words, when
 * they wrote some, quoted under it as a comment's are, inside the item.
 */
function flagLines(flag: SubmittedComment, version: RevisionNumber): string[] {
	const out = [`- ${placeOf(flag, version)}`];
	if (flag.body.trim() !== '') out.push(...wordsQuoted(flag.body).map((line) => `  ${line}`));
	return out;
}

function commentLines(comment: SubmittedComment, version: RevisionNumber): string[] {
	const { path, first, last } = comment.anchor;
	const code = comment.quoted.map((text) => quotedLine(text));
	const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
	const total = last - first + 1;
	const out = [
		`### ${placeOf(comment, version)}`,
		`${fence}${languageOf(path) ?? ''}`,
		...code,
		fence
	];
	if (code.length < total) {
		out.push(
			`(The comment is on ${countOf(total, 'line', 'lines')}; the first ${formatCount(code.length)} are quoted.)`
		);
	}
	out.push(...wordsQuoted(comment.body));
	return out;
}

/**
 * The reviewer's words as a Markdown blockquote, each line after a `>`, so
 * nothing in them, a fence, a heading or a line like the review's own, can
 * open structure in the text around them. The words themselves are kept
 * exactly as typed.
 */
function wordsQuoted(body: string): string[] {
	return body.split('\n').map((line) => (line === '' ? '>' : `> ${line}`));
}

/** A line of code as quoted: a CRLF file's carriage return dropped, what cannot be seen escaped, cut when long. */
export function quotedLine(text: LineText): string {
	const shown = hiddenShown(text.endsWith('\r') ? text.slice(0, -1) : text);
	const chars = Array.from(shown);
	if (chars.length <= MAX_QUOTED_LINE_LENGTH) return shown;
	const left = chars.length - MAX_QUOTED_LINE_LENGTH;
	return `${chars.slice(0, MAX_QUOTED_LINE_LENGTH).join('')} … [${countOf(left, 'character', 'characters')} more]`;
}

/** The length of the longest run of `character` in any of `lines`. */
export function longestRun(lines: readonly string[], character: string): number {
	let longest = 0;
	for (const line of lines) {
		let run = 0;
		for (const c of line) {
			run = c === character ? run + 1 : 0;
			if (run > longest) longest = run;
		}
	}
	return longest;
}

function coverageLine(progress: UnitProgress): string {
	const counted = progress.counted;
	if (counted === 0) return 'There was nothing to review.';
	if (progress.reviewed === counted) {
		return `Every change was marked reviewed (${countOf(counted, 'change', 'changes')}).`;
	}
	return `${formatCount(progress.reviewed)} of ${countOf(counted, 'change', 'changes')} were marked reviewed. These files have changes that were not:`;
}

function groupLine(group: NotReviewedGroup): string {
	const name =
		group.group.kind === 'section'
			? `Section ${jsonQuoted(group.group.title)}`
			: 'Not sorted into a section';
	const named = group.files
		.slice(0, MAX_FILES_NAMED)
		.map((f) => `${agentPath(f.path)}${f.partly ? ' (partly)' : ''}`);
	const more = group.files.length - named.length;
	const files =
		more > 0
			? `${named.join(', ')} and ${countOf(more, 'more file', 'more files')}`
			: named.join(', ');
	return `- ${name}: ${files}`;
}

/**
 * A review the reviewer finished (DESIGN 6.3), as the report keeps it: its
 * number, the version it was finished on, when, how far the review had got
 * then, how many comments it holds, whether it holds an overall review, and
 * the exact text that was handed over.
 */
export interface FinishedReview {
	readonly number: ReviewNumber;
	readonly version: RevisionNumber;
	readonly submittedAt: Timestamp;
	readonly progress: UnitProgress;
	readonly comments: CommentCount;
	/** How many lines it flagged to look at again. */
	readonly flags: CommentCount;
	/** Whether the reviewer wrote an overall review in it. */
	readonly overall: boolean;
	readonly text: TextForAgent;
	/** Where it was posted on GitHub, when it was: its delivery log (DESIGN 6.3), so far. */
	readonly posted: GitHubDelivery | undefined;
}

/** A finished review posted to its pull request as one GitHub review. */
export interface GitHubDelivery {
	readonly postedAs: PostedAs;
	/** The review on GitHub, or for a draft, the pull request's changes, where it is submitted. */
	readonly address: GitHubReviewAddress;
	/** How many of its comments went in the review's text, since GitHub could not place them on their lines. */
	readonly inText: CommentCount;
	readonly at: Timestamp;
}
