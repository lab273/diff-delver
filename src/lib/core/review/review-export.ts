/**
 * A finished review as text written for a language model (DESIGN 8.6): what
 * the reviewer copies with "Finish and copy" and what `get_review` gives an
 * agent, the same text. Each comment names its file, its lines and the side
 * they are on, quotes the code it is on as the snapshot held it when the
 * review was finished, then gives the reviewer's words exactly as typed. Last
 * comes what was not reviewed, group by group.
 *
 * Text from the repository (paths, section titles, code) is written as the
 * agent's other answers write it: paths as `agentPath` does, and each
 * character that cannot be seen, or turns text round, as an escape, so code
 * can never pass for the review's own lines. Only the reviewer's words are
 * kept as they are: they are the review.
 */
import type { Diff } from '../diff/diff.ts';
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
import { countOf, formatCount } from '../viewer/words.ts';
import type { CommentAnchor } from './draft-comment.ts';
import { countWithin } from './progress.ts';
import { fileUnitReviewed, reviewedLines, type ReviewedMarks } from './reviewed-marks.ts';

/** At most this many lines of code are quoted with a comment; the rest are counted. */
export const MAX_QUOTED_LINES = 40;

/** A quoted line longer than this is cut, saying so. */
export const MAX_QUOTED_LINE_LENGTH = 500;

/** At most this many files are named for each group under "Not reviewed"; the rest are counted. */
export const MAX_FILES_NAMED = 30;

/** One comment of a finished review, with the code it is on as it was when the review was finished. */
export interface SubmittedComment {
	readonly anchor: CommentAnchor;
	/** The version of the report its lines are in. */
	readonly version: RevisionNumber;
	/** The reviewer's words, exactly as typed. */
	readonly body: string;
	/** The first `MAX_QUOTED_LINES` lines of its range, from its version's snapshot. */
	readonly quoted: readonly LineText[];
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
	readonly comments: readonly SubmittedComment[];
	readonly notReviewed: readonly NotReviewedGroup[];
	readonly progress: UnitProgress;
}

/** A finished review as Markdown written for a language model. */
export function renderReviewExport(input: ReviewExportInput): TextForAgent {
	const out: string[] = [
		`# Review ${String(input.number)} of ${visibleText(input.title)} in ${visibleText(input.repository)}`,
		'',
		`A code review from diff delver: report ${input.report}, version ${String(input.version)}. Each comment names a file, its lines, and the side they are on: (new) is the file after the change, (old) before it. The code each comment is on is quoted as it was when the review was finished.`,
		'',
		'## Comments'
	];
	if (input.comments.length === 0) out.push('', 'No comments.');
	for (const comment of input.comments) out.push('', ...commentLines(comment, input.version));
	out.push('', '## Not reviewed', '', coverageLine(input.progress));
	if (input.notReviewed.length > 0) out.push('');
	for (const group of input.notReviewed) out.push(groupLine(group));
	return textForAgent(`${out.join('\n')}\n`);
}

function commentLines(comment: SubmittedComment, version: RevisionNumber): string[] {
	const { path, side, first, last } = comment.anchor;
	const lines = first === last ? String(first) : `${String(first)}-${String(last)}`;
	const where = comment.version === version ? side : `${side}, version ${String(comment.version)}`;
	const code = comment.quoted.map((text) => quotedLine(text));
	const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
	const total = last - first + 1;
	const out = [
		`### ${agentPath(path)}:${lines} (${where})`,
		`${fence}${languageOf(path) ?? ''}`,
		...code,
		fence
	];
	if (code.length < total) {
		out.push(
			`(The comment is on ${countOf(total, 'line', 'lines')}; the first ${formatCount(code.length)} are quoted.)`
		);
	}
	out.push(comment.body);
	return out;
}

/** A line of code as quoted: a CRLF file's carriage return dropped, what cannot be seen escaped, cut when long. */
function quotedLine(text: LineText): string {
	const shown = hiddenShown(text.endsWith('\r') ? text.slice(0, -1) : text);
	const chars = Array.from(shown);
	if (chars.length <= MAX_QUOTED_LINE_LENGTH) return shown;
	const left = chars.length - MAX_QUOTED_LINE_LENGTH;
	return `${chars.slice(0, MAX_QUOTED_LINE_LENGTH).join('')} … [${countOf(left, 'character', 'characters')} more]`;
}

/** The length of the longest run of `character` in any of `lines`. */
function longestRun(lines: readonly string[], character: string): number {
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
			? `Section "${visibleText(group.group.title)}"`
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
 * then, how many comments it holds, and the exact text that was handed over.
 */
export interface FinishedReview {
	readonly number: ReviewNumber;
	readonly version: RevisionNumber;
	readonly submittedAt: Timestamp;
	readonly progress: UnitProgress;
	readonly comments: CommentCount;
	readonly text: TextForAgent;
}
