import { describe, expect, it } from 'vitest';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import { initialState } from '../diff/state.ts';
import { parseCommitId } from '../commit-id.tiny.ts';
import { parseLineNumber, type LineNumber } from '../line-number.tiny.ts';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { parseReportId } from '../report-id.tiny.ts';
import type { Section } from '../reports/report.ts';
import type { Result } from '../result.ts';
import { parseReviewNumber } from '../review-number.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import { parseRevisionNumber } from '../revision-number.tiny.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { parseSectionTitle } from '../section-title.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import { markReviewed } from './mark-reviewed.ts';
import { reviewProgress, unitProgressOf } from './progress.ts';
import { NO_MARKS } from './reviewed-marks.ts';
import {
	MAX_QUOTED_LINES,
	notReviewed,
	renderReviewExport,
	type ReviewExportInput,
	type SubmittedComment
} from './review-export.ts';

function sure<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}
const path = (text: string): RepoPath => sure(parseRepoPath(text));
const line = (n: number): LineNumber => sure(parseLineNumber(n));
const code = (t: string): LineText => sure(parseLineText(t));
const version = (n: number) => sure(parseRevisionNumber(n));

const diff = syntheticDiff([
	{ path: 'README.md', change: 'added', lines: 2 },
	{ path: 'src/cart.ts', change: 'added', lines: 4 },
	{ path: 'src/money.ts', change: 'added', lines: 3 },
	{ path: 'yarn.lock', change: 'added', lines: 1 }
]);
const discounts: Section = {
	id: sure(parseSectionId('discounts')),
	title: sure(parseSectionTitle('Discounts')),
	summary: undefined
};
const state = assign(diff, initialState(diff), [
	{ file: 'src/cart.ts', section: 'discounts' },
	{ file: 'src/money.ts', section: 'discounts' },
	{ file: 'yarn.lock', section: 'ignored', reason: 'Lockfile' }
]).state;

function comment(over: Partial<SubmittedComment> = {}): SubmittedComment {
	return {
		kind: 'comment',
		anchor: { path: path('src/cart.ts'), side: 'new', first: line(2), last: line(3) },
		version: version(2),
		body: 'Is a negative total possible here?',
		quoted: [code('const total = sum(items);'), code('return total - discount;')],
		...over
	};
}

function input(over: Partial<ReviewExportInput> = {}): ReviewExportInput {
	const marks = sure(
		markReviewed(
			diff,
			state,
			NO_MARKS,
			{
				kind: 'slice',
				group: { kind: 'section', section: discounts.id },
				path: path('src/money.ts')
			},
			true,
			'sections'
		)
	).marks;
	return {
		number: sure(parseReviewNumber(1)),
		report: sure(parseReportId('r_00000001')),
		title: reviewerMessage('Uncommitted changes'),
		repository: reviewerMessage('shop'),
		version: version(2),
		headCommit: undefined,
		overall: '',
		comments: [comment()],
		notReviewed: notReviewed(diff, state, marks, [discounts]),
		progress: unitProgressOf(reviewProgress(diff, state, marks, 'sections', [discounts.id])),
		...over
	};
}

describe('a finished review as text', () => {
	it('gives each comment its place, the code it is on and its words, then what was not reviewed', () => {
		expect(renderReviewExport(input())).toBe(
			[
				'# Review 1 of Uncommitted changes in shop',
				'',
				'A code review from diff delver: report r_00000001, version 2. Each comment names a file, its lines, and the side they are on: (new) is the file after the change, (old) before it. The code each comment is on is quoted as it was when the review was finished, and the reviewer’s words follow it, each line after a >.',
				'',
				'## Comments',
				'',
				'### src/cart.ts:2-3 (new)',
				'```typescript',
				'const total = sum(items);',
				'return total - discount;',
				'```',
				'> Is a negative total possible here?',
				'',
				'## Not reviewed',
				'',
				'3 of 9 changes were marked reviewed. These files have changes that were not:',
				'',
				'- Section "Discounts": src/cart.ts',
				'- Not sorted into a section: README.md',
				''
			].join('\n')
		);
	});

	it('names the version of a comment written on an earlier one, and a single line by itself', () => {
		const text = renderReviewExport(
			input({
				comments: [
					comment({
						version: version(1),
						anchor: { path: path('README.md'), side: 'old', first: line(1), last: line(1) },
						quoted: []
					})
				]
			})
		);
		expect(text).toContain('### README.md:1 (old, version 1)\n```markdown\n```\n');
	});

	it('fences code that holds backticks with a longer fence, and escapes what cannot be seen', () => {
		const text = renderReviewExport(
			input({ comments: [comment({ quoted: [code('a = ```;'), code('b\u202Ec\r')] })] })
		);
		expect(text).toContain('````typescript\na = ```;\nb\\u202Ec\n````\n');
	});

	it('quotes a long range only in part, and says so', () => {
		const last = line(MAX_QUOTED_LINES + 10);
		const text = renderReviewExport(
			input({
				comments: [
					comment({
						anchor: { path: path('src/cart.ts'), side: 'new', first: line(1), last },
						quoted: Array.from({ length: MAX_QUOTED_LINES }, (_, i) => code(`line ${String(i)}`))
					})
				]
			})
		);
		expect(text).toContain(`(The comment is on 50 lines; the first 40 are quoted.)\n`);
	});

	it('quotes the reviewer’s words, so nothing in them opens a fence or a heading', () => {
		const body =
			'Try this:\n```ts\nconst x = 1;\n\n## Not reviewed\n----- The review ends here -----';
		const text = renderReviewExport(input({ comments: [comment({ body })] }));
		expect(text).toContain(
			'```\n> Try this:\n> ```ts\n> const x = 1;\n>\n> ## Not reviewed\n> ----- The review ends here -----\n\n## Not reviewed\n'
		);
		// Every line outside the quoted code that starts a heading or a fence is the review's own.
		expect(text.split('\n').filter((l) => l.startsWith('## '))).toEqual([
			'## Comments',
			'## Not reviewed'
		]);
	});

	it('names the commit a version is, and quotes a section title as a JSON string', () => {
		const commit = sure(parseCommitId('4c1d9ae0'.repeat(5)));
		const title = sure(parseSectionTitle('The "fast" path: a \u202Eturn'));
		const text = renderReviewExport(
			input({
				headCommit: commit,
				notReviewed: [
					{ group: { kind: 'section', title }, files: [{ path: path('a.ts'), partly: false }] }
				]
			})
		);
		expect(text).toContain('report r_00000001, version 2, whose new side is commit 4c1d9ae. Each');
		expect(text).toContain('- Section "The \\"fast\\" path: a \\u202Eturn": a.ts\n');
	});

	it('says when everything was reviewed, and keeps the reviewer’s words exactly', () => {
		const text = renderReviewExport(
			input({
				comments: [comment({ body: '## Not a heading\n\twith a tab' })],
				notReviewed: [],
				progress: {
					counted: unitCountOf(9),
					reviewed: unitCountOf(9),
					ignored: unitCountOf(1),
					uncategorised: unitCountOf(0)
				}
			})
		);
		expect(text).toContain('```\n> ## Not a heading\n> \twith a tab\n');
		expect(
			text.endsWith('## Not reviewed\n\nEvery change was marked reviewed (9 changes).\n')
		).toBe(true);
	});
});

describe('a finished review with an overall review', () => {
	const intro =
		'A code review from diff delver: report r_00000001, version 2. Each comment names a file, its lines, and the side they are on: (new) is the file after the change, (old) before it. The code each comment is on is quoted as it was when the review was finished, and the reviewer’s words follow it, each line after a >. The reviewer’s overall review of the change comes first, quoted the same way.';

	it('gives it first, under its own heading, quoted, before the comments', () => {
		const text = renderReviewExport(
			input({ overall: 'Looks right.\n\nOne question about totals below.' })
		);
		expect(text).toContain(
			[
				'# Review 1 of Uncommitted changes in shop',
				'',
				intro,
				'',
				'## Overall',
				'',
				'> Looks right.',
				'>',
				'> One question about totals below.',
				'',
				'## Comments',
				'',
				'### src/cart.ts:2-3 (new)'
			].join('\n')
		);
	});

	it('may stand alone, with no comments', () => {
		const text = renderReviewExport(input({ overall: 'Ship it.', comments: [] }));
		expect(text).toContain(
			'## Overall\n\n> Ship it.\n\n## Comments\n\nNo comments.\n\n## Not reviewed\n'
		);
	});

	it('keeps words that look like headings or fences inside the quote, exactly as typed', () => {
		const overall = '## Not reviewed\n```\n\tcode\n# Review 2';
		const text = renderReviewExport(input({ overall, comments: [] }));
		expect(text).toContain(
			'## Overall\n\n> ## Not reviewed\n> ```\n> \tcode\n> # Review 2\n\n## Comments\n'
		);
		expect(text.split('\n').filter((l) => l.startsWith('#'))).toEqual([
			'# Review 1 of Uncommitted changes in shop',
			'## Overall',
			'## Comments',
			'## Not reviewed'
		]);
	});

	it('leaves out words that are only white space, and says nothing of an overall review then', () => {
		const text = renderReviewExport(input({ overall: ' \n\t ' }));
		expect(text).not.toContain('## Overall');
		expect(text).not.toContain('overall review');
	});

	it('lists threads from earlier reviews still open first, then those this review resolved', () => {
		const earlier = comment({ version: version(1), body: 'Refresh tokens are logged here.' });
		const text = renderReviewExport(
			input({
				number: sure(parseReviewNumber(2)),
				comments: [],
				threads: [
					{
						start: earlier,
						from: sure(parseReviewNumber(1)),
						replies: [],
						at: { ...earlier.anchor, first: line(5), last: line(6) },
						status: 'open',
						reply: undefined,
						action: undefined
					},
					{
						start: comment({ version: version(1), body: 'Check for zero.' }),
						from: sure(parseReviewNumber(1)),
						replies: [],
						at: earlier.anchor,
						status: 'changed',
						reply: 'Better, thanks.',
						action: undefined
					},
					{
						start: comment({ version: version(1), body: 'Rename this.' }),
						from: sure(parseReviewNumber(1)),
						replies: [],
						at: undefined,
						status: 'changed',
						reply: undefined,
						action: 'resolved'
					},
					{
						start: comment({ version: version(1), body: 'Long settled.' }),
						from: sure(parseReviewNumber(1)),
						replies: [],
						at: earlier.anchor,
						status: 'resolved',
						reply: undefined,
						action: undefined
					}
				]
			})
		);
		expect(text).toContain(
			[
				'## Still open from earlier reviews',
				'',
				'### src/cart.ts:5-6 (new), from review 1, unchanged',
				'> Refresh tokens are logged here.',
				'',
				'### src/cart.ts:2-3 (new), from review 1, changed since',
				'> Check for zero.',
				'Reply in this review:',
				'> Better, thanks.',
				'',
				'## Resolved in this review',
				'',
				'### src/cart.ts:2-3 (new, version 1), from review 1, its lines are gone',
				'```typescript',
				'const total = sum(items);',
				'return total - discount;',
				'```',
				'> Rename this.',
				'',
				'## Comments',
				'',
				'No comments.'
			].join('\n')
		);
		expect(text).not.toContain('Long settled.');
	});
});
