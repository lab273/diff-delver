import { describe, expect, it } from 'vitest';
import awkward from '../diff/fixtures/awkward-changes.diff-tree?raw';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { parseDiffTreeOutput } from '../diff/diff-tree-output.ts';
import { makeDiff, type Diff } from '../diff/diff.ts';
import { lineNumberOf } from '../line-number.tiny.ts';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { parseReportId, type ReportId } from '../report-id.tiny.ts';
import { parseReviewNumber, type ReviewNumber } from '../review-number.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '../revision-number.tiny.ts';
import type { SubmittedComment } from '../review/review-export.ts';
import { parseReviewMark } from './review-mark.tiny.ts';
import { commentCountOf } from '../comment-count.tiny.ts';
import type { Side } from '../side.tiny.ts';
import {
	gitHubReview,
	hasReviewMarker,
	IN_TEXT_HEADING,
	placeComment,
	reviewMarker,
	GITHUB_TEXT_LIMIT,
	gitHubLength,
	tooLongForGitHub
} from './github-review.ts';

function value<T>(parsed: { ok: true; value: T } | { ok: false }): T {
	if (!parsed.ok) throw new Error('not valid');
	return parsed.value;
}

const path = (text: string): RepoPath => value(parseRepoPath(text));
const version = (n: number): RevisionNumber => value(parseRevisionNumber(n));
const line = (text: string): LineText => value(parseLineText(text));
const REPORT: ReportId = value(parseReportId('r_0000000000000001'));
const REVIEW: ReviewNumber = value(parseReviewNumber(2));
const MARK = value(parseReviewMark('0123456789abcdef0123456789abcdef'));
const OTHER_MARK = value(parseReviewMark('fedcba9876543210fedcba9876543210'));

function awkwardDiff(): Diff {
	const files = parseDiffTreeOutput(new TextEncoder().encode(awkward));
	if (!files.ok) throw new Error('fixture does not parse');
	const diff = makeDiff(files.value);
	if (!diff.ok) throw new Error('fixture does not index');
	return diff.value;
}

const diff = awkwardDiff();
const V2 = version(2);

function comment(
	at: string,
	side: Side,
	first: number,
	last = first,
	options: { version?: number; body?: string; quoted?: readonly string[] } = {}
): SubmittedComment {
	return {
		anchor: { path: path(at), side, first: lineNumberOf(first), last: lineNumberOf(last) },
		version: version(options.version ?? 2),
		body: options.body ?? 'A comment.',
		quoted: (options.quoted ?? []).map(line)
	};
}

describe('placeComment', () => {
	it('places a comment on a changed line, or an unchanged line within its hunk, on its side', () => {
		// modified.txt has hunks -1,6 +1,6 and -8,3 +8,4.
		expect(placeComment(diff, V2, comment('modified.txt', 'new', 3))).toEqual({
			kind: 'line',
			comment: {
				path: 'modified.txt',
				side: 'RIGHT',
				line: 3,
				startLine: undefined,
				body: 'A comment.'
			}
		});
		expect(placeComment(diff, V2, comment('modified.txt', 'old', 10))).toMatchObject({
			kind: 'line',
			comment: { side: 'LEFT', line: 10 }
		});
	});

	it('places a run with its first line, when the whole run is in one hunk', () => {
		expect(placeComment(diff, V2, comment('modified.txt', 'new', 8, 11))).toMatchObject({
			kind: 'line',
			comment: { side: 'RIGHT', line: 11, startLine: 8 }
		});
		// Line 7 lies between the two hunks, so a run over it reaches outside both.
		expect(placeComment(diff, V2, comment('modified.txt', 'new', 5, 9))).toEqual({
			kind: 'text',
			because: 'outside-the-diff'
		});
		expect(placeComment(diff, V2, comment('modified.txt', 'new', 7))).toEqual({
			kind: 'text',
			because: 'outside-the-diff'
		});
		expect(placeComment(diff, V2, comment('modified.txt', 'new', 11, 12))).toEqual({
			kind: 'text',
			because: 'outside-the-diff'
		});
	});

	it('names a renamed file by its new path on both sides', () => {
		// edited-before.txt became edited-after.txt, with a hunk -2,7 +2,7.
		expect(placeComment(diff, V2, comment('edited-before.txt', 'old', 6))).toMatchObject({
			kind: 'line',
			comment: { path: 'edited-after.txt', side: 'LEFT', line: 6 }
		});
		expect(placeComment(diff, V2, comment('edited-after.txt', 'new', 2, 8))).toMatchObject({
			kind: 'line',
			comment: { path: 'edited-after.txt', side: 'RIGHT', line: 8, startLine: 2 }
		});
		expect(placeComment(diff, V2, comment('edited-after.txt', 'new', 1))).toEqual({
			kind: 'text',
			because: 'outside-the-diff'
		});
	});

	it('places a comment on a deleted file on the old side, by its old path', () => {
		expect(placeComment(diff, V2, comment('deleted.txt', 'old', 1, 3))).toMatchObject({
			kind: 'line',
			comment: { path: 'deleted.txt', side: 'LEFT', line: 3, startLine: 1 }
		});
		expect(placeComment(diff, V2, comment('added.txt', 'new', 2))).toMatchObject({
			kind: 'line',
			comment: { path: 'added.txt', side: 'RIGHT', line: 2 }
		});
	});

	it('keeps comments on files GitHub shows no lines of, and on copies, in the text', () => {
		expect(placeComment(diff, V2, comment('binary.bin', 'new', 1))).toEqual({
			kind: 'text',
			because: 'no-lines-shown'
		});
		expect(placeComment(diff, V2, comment('assets/logo.png', 'new', 1))).toEqual({
			kind: 'text',
			because: 'no-lines-shown'
		});
		// copy-source.txt's old side is both its own and copy-target.txt's: its own is meant.
		expect(placeComment(diff, V2, comment('copy-source.txt', 'old', 9))).toMatchObject({
			kind: 'line',
			comment: { path: 'copy-source.txt', side: 'LEFT', line: 9 }
		});
		// A copy with nothing changed shows no hunk at all.
		expect(placeComment(diff, V2, comment('copy-target.txt', 'new', 1))).toEqual({
			kind: 'text',
			because: 'outside-the-diff'
		});
		// A file not in the diff, as one opened whole from the tree.
		expect(placeComment(diff, V2, comment('README.md', 'new', 1))).toEqual({
			kind: 'text',
			because: 'outside-the-diff'
		});
	});

	it('keeps the old side of a copy in the text, since GitHub shows a copy as a new file', () => {
		const a = 'a'.repeat(40);
		const b = 'b'.repeat(40);
		const output =
			`:100644 100644 ${a} ${b} C075\0src.txt\0dst.txt\0\0` +
			'diff --git a/src.txt b/dst.txt\nsimilarity index 75%\ncopy from src.txt\ncopy to dst.txt\n' +
			`index ${a}..${b} 100644\n--- a/src.txt\n+++ b/dst.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`;
		const files = parseDiffTreeOutput(new TextEncoder().encode(output));
		if (!files.ok) throw new Error('does not parse');
		const copies = makeDiff(files.value);
		if (!copies.ok) throw new Error('does not index');
		expect(placeComment(copies.value, V2, comment('src.txt', 'old', 2))).toEqual({
			kind: 'text',
			because: 'copied'
		});
		expect(placeComment(copies.value, V2, comment('dst.txt', 'new', 2))).toMatchObject({
			kind: 'line',
			comment: { path: 'dst.txt', side: 'RIGHT', line: 2 }
		});
	});

	it('keeps a comment on an earlier version in the text', () => {
		expect(placeComment(diff, V2, comment('modified.txt', 'new', 3, 3, { version: 1 }))).toEqual({
			kind: 'text',
			because: 'earlier-version'
		});
	});

	it('keeps a comment on a path that is not UTF-8 in the text', () => {
		const odd = syntheticDiff([
			{ path: 'docs/caf\uDCE9.md', change: 'modified', hunks: [{ gap: 0, lines: ['-', '+'] }] }
		]);
		expect(placeComment(odd, V2, comment('docs/caf\uDCE9.md', 'new', 1))).toEqual({
			kind: 'text',
			because: 'path-not-shown'
		});
	});
});

describe('gitHubReview', () => {
	const base = {
		report: REPORT,
		number: REVIEW,
		diff,
		version: V2,
		allInText: false,
		mark: MARK
	};

	it('gives the overall review as the text, the comments on their lines, and the mark last', () => {
		const review = gitHubReview({
			...base,
			overall: 'Looks right.\n\nShip it.',
			comments: [comment('modified.txt', 'new', 3, 3, { body: 'Why **three**?' })]
		});
		expect(review.body).toBe(`Looks right.\n\nShip it.\n\n${reviewMarker(REPORT, REVIEW, MARK)}`);
		expect(review.comments).toEqual([
			{ path: 'modified.txt', side: 'RIGHT', line: 3, startLine: undefined, body: 'Why **three**?' }
		]);
		expect(review.inText).toBe(0);
		expect(hasReviewMarker(review.body, REPORT, REVIEW, MARK)).toBe(true);
		expect(hasReviewMarker(review.body, REPORT, value(parseReviewNumber(3)), MARK)).toBe(false);
		// Another post of the same review has a mark of its own.
		expect(hasReviewMarker(review.body, REPORT, REVIEW, OTHER_MARK)).toBe(false);
	});

	it('leaves the mark out when it is not made yet, as when what will be posted is shown', () => {
		const review = gitHubReview({ ...base, mark: undefined, overall: 'Fine.', comments: [] });
		expect(review.body).toBe('Fine.');
	});

	it('puts what GitHub cannot place in the text, with its file, lines and code, never dropping it', () => {
		const review = gitHubReview({
			...base,
			overall: '',
			comments: [
				comment('modified.txt', 'new', 7, 7, { body: 'Unchanged, but wrong.', quoted: ['seven'] }),
				comment('modified.txt', 'old', 1, 2, {
					version: 1,
					body: 'From before.\n\nStill true.',
					quoted: ['one', 'two `x`']
				}),
				comment('modified.txt', 'new', 3)
			]
		});
		expect(review.inText).toBe(2);
		expect(review.comments).toHaveLength(1);
		expect(review.body).toBe(
			[
				IN_TEXT_HEADING,
				'',
				'`modified.txt`, line 7 (after the change)',
				'',
				'```',
				'seven',
				'```',
				'> Unchanged, but wrong.',
				'',
				'`modified.txt`, lines 1–2 (before the change, in version 1)',
				'',
				'```',
				'one',
				'two `x`',
				'```',
				'> From before.',
				'>',
				'> Still true.',
				'',
				reviewMarker(REPORT, REVIEW, MARK)
			].join('\n')
		);
	});

	it('puts every comment in the text when asked, as after GitHub refused their lines', () => {
		const review = gitHubReview({
			...base,
			allInText: true,
			overall: 'Overall.',
			comments: [comment('modified.txt', 'new', 3), comment('deleted.txt', 'old', 1)]
		});
		expect(review.comments).toEqual([]);
		expect(review.inText).toBe(2);
		expect(review.body.startsWith(`Overall.\n\n${IN_TEXT_HEADING}`)).toBe(true);
		expect(review.body).toContain('`deleted.txt`, line 1 (before the change)');
	});

	it('fences code holding backticks with more of them, and says when the code is cut short', () => {
		const review = gitHubReview({
			...base,
			overall: '',
			comments: [comment('modified.txt', 'new', 1, 60, { quoted: ['a ``` b', 'c'], version: 1 })]
		});
		expect(review.body).toContain('````\na ``` b\nc\n````\n(The first 2 lines of 60.)');
	});
});

describe('tooLongForGitHub', () => {
	const draft = (body: string, comments: readonly string[] = []) => ({
		body,
		comments: comments.map((c) => ({
			path: value(parseRepoPath('a.txt')),
			side: 'RIGHT' as const,
			line: lineNumberOf(1),
			startLine: undefined,
			body: c
		})),
		inText: commentCountOf(0)
	});

	it('takes a text or comment of up to GitHub’s limit in characters, however they are encoded', () => {
		expect(gitHubLength('😀é')).toBe(2);
		expect(tooLongForGitHub(draft('😀'.repeat(GITHUB_TEXT_LIMIT)))).toBeUndefined();
		expect(tooLongForGitHub(draft('x'.repeat(GITHUB_TEXT_LIMIT + 1)))).toBe(GITHUB_TEXT_LIMIT + 1);
		expect(tooLongForGitHub(draft('short', ['y'.repeat(GITHUB_TEXT_LIMIT + 2)]))).toBe(
			GITHUB_TEXT_LIMIT + 2
		);
	});
});
