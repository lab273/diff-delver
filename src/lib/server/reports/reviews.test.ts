import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { NO_EDITS, parseEditCount } from '#lib/core/edit-count.tiny.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { parseReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { Database, DATABASE_FILE } from '../db/index.ts';
import { reviewCommentsOf } from '../db/tables/review-comments.ts';
import { reviewMarkRowsOf } from '../db/tables/review-marks.ts';
import { describeReportError, ReportService, type ReportError } from './index.ts';

const FIRST = value(parseRevisionNumber(1));

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

function failure<T>(result: Result<T, ReportError>): ReportError {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

async function setUp() {
	const repo = await emptyRepo();
	await repo.write('src/cart.ts', 'one\ntwo\nthree\n');
	await repo.commit('first');
	await repo.write('src/cart.ts', 'one\n2\n3\nfour\n');
	await repo.write('README.md', '# Shop\n');
	const who = await reviewer();
	const data = await tempDirectory();
	const clock = settableClock(at(1_700_000_000_000));
	const service = value(
		await ReportService.open({
			dataDirectory: data,
			clock,
			ids: sequentialIds(),
			repository: { gitEnv: who.gitEnv }
		})
	);
	const opened = value(await service.open(repo.dir, value(parseGitSourceSpec('working-tree'))));
	if (opened.kind !== 'created') throw new Error(opened.kind);
	const id: ReportId = opened.report.id;
	return { repo, data, clock, service, id };
}

describe('finishing a review', () => {
	it('records the draft as review 1 with the code it is on, empties the draft, and numbers the next review 2', async () => {
		const { data, clock, service, id } = await setUp();
		try {
			const comment = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(2), last: lineNumberOf(3) },
					'Why are these numbers now?'
				)
			);
			value(await service.markReviewed(id, FIRST, { kind: 'file', path: path('README.md') }, true));
			const preview = value(await service.previewReview(id, FIRST));
			expect(preview.number).toBe(1);
			expect(value(service.review(id))).toBeUndefined();

			clock.set(at(1_700_000_060_000));
			const review = value(
				await service.finishReview(id, FIRST, {
					comments: [{ id: comment.id, edits: comment.edits }],
					overall: NO_EDITS
				})
			);
			expect(review).toMatchObject({
				number: 1,
				version: 1,
				submittedAt: 1_700_000_060_000,
				comments: 1,
				progress: { counted: 6, reviewed: 1, ignored: 0, uncategorised: 6 }
			});
			expect(review.text).toBe(preview.text);
			expect(review.text).toContain(
				'### src/cart.ts:2-3 (new)\n```typescript\n2\n3\n```\n> Why are these numbers now?\n'
			);
			expect(review.text).toContain(
				'1 of 6 changes were marked reviewed. These files have changes that were not:\n\n- Not sorted into a section: src/cart.ts\n'
			);
			expect(value(service.draftComments(id))).toEqual([]);
			expect(value(service.review(id))).toEqual(review);
			expect(value(service.review(id, value(parseReviewNumber(1))))).toEqual(review);
			expect(value(service.reviews(id))).toEqual([review]);

			const raw = new DatabaseSync(join(data, DATABASE_FILE), { readOnly: true });
			expect(raw.prepare('SELECT side, first_line FROM review_marks').all()).toEqual([
				{ side: 'new', first_line: 1 }
			]);
			expect(raw.prepare('SELECT quoted FROM review_comments').all()).toEqual([
				{ quoted: '["2","3"]' }
			]);
			raw.close();

			const next = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'old', first: lineNumberOf(1), last: lineNumberOf(1) },
					'And this one.'
				)
			);
			expect(value(await service.previewReview(id, FIRST)).number).toBe(2);
			const second = value(
				await service.finishReview(id, FIRST, {
					comments: [{ id: next.id, edits: next.edits }],
					overall: NO_EDITS
				})
			);
			expect(second.number).toBe(2);
			expect(value(service.review(id))?.number).toBe(2);
			expect(value(service.reviews(id)).map((r) => r.number)).toEqual([1, 2]);
		} finally {
			service.close();
		}
	});

	it('keeps each comment with its side, lines, version and quoted code, and the marks as they were', async () => {
		const { data, clock, service, id } = await setUp();
		try {
			const after = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(2), last: lineNumberOf(4) },
					'New lines.'
				)
			);
			const before = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'old', first: lineNumberOf(3), last: lineNumberOf(3) },
					'An old line.\n\nWith a gap.'
				)
			);
			value(await service.markReviewed(id, FIRST, { kind: 'file', path: path('README.md') }, true));
			const shown = [after, before].map((c) => ({ id: c.id, edits: c.edits }));
			const number = value(
				await service.finishReview(id, FIRST, { comments: shown, overall: NO_EDITS })
			).number;
			// A tick after finishing is not the review's.
			value(
				await service.markReviewed(id, FIRST, { kind: 'file', path: path('src/cart.ts') }, true)
			);

			const db = value(await Database.open(data, clock));
			try {
				expect(value(db.read((q) => reviewCommentsOf(q, id, number)))).toEqual([
					{
						kind: 'comment',
						anchor: { path: 'src/cart.ts', side: 'new', first: 2, last: 4 },
						version: 1,
						body: 'New lines.',
						quoted: ['2', '3', 'four']
					},
					{
						kind: 'comment',
						anchor: { path: 'src/cart.ts', side: 'old', first: 3, last: 3 },
						version: 1,
						body: 'An old line.\n\nWith a gap.',
						quoted: ['three']
					}
				]);
				expect(value(db.read((q) => reviewMarkRowsOf(q, id, number)))).toEqual([
					{ path: 'README.md', units: { kind: 'lines', range: { side: 'new', first: 1, last: 1 } } }
				]);
			} finally {
				db.close();
			}
		} finally {
			service.close();
		}
	});

	it('refuses to finish an empty draft, a draft that changed since the page showed it, and an old version', async () => {
		const { repo, service, id } = await setUp();
		try {
			const empty = failure(
				await service.finishReview(id, FIRST, { comments: [], overall: NO_EDITS })
			);
			expect(empty).toEqual({ kind: 'NothingToFinish' });
			expect(describeReportError(empty)).toMatch(/nothing to finish yet/);

			const comment = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(1), last: lineNumberOf(1) },
					'First.'
				)
			);
			const changed = failure(
				await service.finishReview(id, FIRST, {
					comments: [{ id: comment.id, edits: value(parseEditCount(1)) }],
					overall: NO_EDITS
				})
			);
			expect(changed).toEqual({ kind: 'DraftChanged' });
			expect(
				failure(await service.finishReview(id, FIRST, { comments: [], overall: NO_EDITS }))
			).toEqual({ kind: 'DraftChanged' });

			await repo.write('src/cart.ts', 'changed again\n');
			value(await service.update(id));
			expect(
				failure(
					await service.finishReview(id, FIRST, {
						comments: [{ id: comment.id, edits: comment.edits }],
						overall: NO_EDITS
					})
				)
			).toMatchObject({ kind: 'VersionOutOfDate', seen: 1, current: 2 });
			expect(failure(service.review(id, value(parseReviewNumber(3))))).toEqual({
				kind: 'ReviewNotFound',
				number: 3
			});
			expect(value(service.draftComments(id))).toHaveLength(1);
		} finally {
			service.close();
		}
	});

	it('says the comments a second tab shows were finished already, as which review', async () => {
		const { service, id } = await setUp();
		try {
			const comment = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(1), last: lineNumberOf(1) },
					'Once.'
				)
			);
			const shown = [{ id: comment.id, edits: comment.edits }];
			value(await service.finishReview(id, FIRST, { comments: shown, overall: NO_EDITS }));

			const again = failure(
				await service.finishReview(id, FIRST, { comments: shown, overall: NO_EDITS })
			);
			expect(again).toEqual({ kind: 'CommentsFinished', number: 1 });
			expect(describeReportError(again)).toMatch(/finished already, as review 1/);

			// A new comment in the draft does not hide that the ones shown were finished.
			value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(2), last: lineNumberOf(2) },
					'Twice.'
				)
			);
			expect(
				failure(await service.finishReview(id, FIRST, { comments: shown, overall: NO_EDITS }))
			).toEqual({
				kind: 'CommentsFinished',
				number: 1
			});
			expect(value(service.reviews(id))).toHaveLength(1);

			const edited = failure(
				service.editDraftComment(id, FIRST, comment.id, comment.edits, 'Changed.')
			);
			expect(edited).toEqual({ kind: 'CommentFinished', number: 1 });
			expect(describeReportError(edited)).toMatch(/finished as part of review 1/);
			expect(failure(service.deleteDraftComment(id, FIRST, comment.id, comment.edits))).toEqual({
				kind: 'CommentFinished',
				number: 1
			});
		} finally {
			service.close();
		}
	});

	it('says which version a comment written on an earlier one is on', async () => {
		const { repo, service, id } = await setUp();
		try {
			const comment = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(4), last: lineNumberOf(4) },
					'Spell it as a number.'
				)
			);
			await repo.write('README.md', '# Shop\n\nMore.\n');
			value(await service.update(id));
			const second = value(parseRevisionNumber(2));
			const review = value(
				await service.finishReview(id, second, {
					comments: [{ id: comment.id, edits: comment.edits }],
					overall: NO_EDITS
				})
			);
			expect(review.version).toBe(2);
			expect(review.text).toContain(
				'### src/cart.ts:4 (new, version 1)\n```typescript\nfour\n```\n'
			);
		} finally {
			service.close();
		}
	});
});

describe('flags', () => {
	it('flag lines once, with or without words, are cleared like comments, and finish under their own heading', async () => {
		const { repo, service, id } = await setUp();
		try {
			const lines = {
				path: path('src/cart.ts'),
				side: 'new' as const,
				first: lineNumberOf(2),
				last: lineNumberOf(3)
			};
			const flag = value(await service.addDraftComment(id, FIRST, lines, '', 'flag'));
			expect(flag).toMatchObject({ kind: 'flag', body: '' });
			// Flagging the same lines again finds the flag they have.
			expect(value(await service.addDraftComment(id, FIRST, lines, '', 'flag'))).toEqual(flag);
			// A comment still needs words; a flag's words can be added, and taken away.
			expect(failure(await service.addDraftComment(id, FIRST, lines, ' ', 'comment'))).toEqual({
				kind: 'InvalidCommentBody'
			});
			const worded = value(
				service.editDraftComment(id, FIRST, flag.id, flag.edits, 'Check the rounding.')
			);
			expect(worded).toMatchObject({ kind: 'flag', body: 'Check the rounding.', edits: 1 });
			const other = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ ...lines, side: 'old', first: lineNumberOf(1), last: lineNumberOf(1) },
					' \n',
					'flag'
				)
			);
			expect(other.body).toBe('');
			value(service.deleteDraftComment(id, FIRST, other.id, other.edits));
			const comment = value(
				await service.addDraftComment(id, FIRST, lines, 'Why are these numbers now?')
			);

			// Flags survive an update, on the lines of the version they were raised on.
			await repo.write('README.md', '# Shop\n\nMore.\n');
			value(await service.update(id));
			const second = value(parseRevisionNumber(2));
			expect(value(service.draftComments(id)).map((c) => [c.kind, c.version])).toEqual([
				['flag', 1],
				['comment', 1]
			]);

			const review = value(
				await service.finishReview(id, second, {
					comments: [worded, comment].map((c) => ({ id: c.id, edits: c.edits })),
					overall: NO_EDITS
				})
			);
			expect(review).toMatchObject({ comments: 1, flags: 1 });
			expect(review.text).toContain(
				'## Comments\n\n### src/cart.ts:2-3 (new, version 1)\n```typescript\n2\n3\n```\n> Why are these numbers now?\n\n## Flagged for another look\n\n- src/cart.ts:2-3 (new, version 1)\n  > Check the rounding.\n\n## Not reviewed'
			);
			expect(value(service.draftComments(id))).toEqual([]);
		} finally {
			service.close();
		}
	});
});

describe('the overall review', () => {
	it('is saved exactly as typed, counts each change, and refuses words read before another change', async () => {
		const { clock, service, id } = await setUp();
		try {
			expect(value(service.overallReview(id))).toEqual({
				body: '',
				changedAt: undefined,
				edits: 0
			});
			clock.set(at(1_700_000_030_000));
			const words = '  Looks right.\n\n## Not a heading\n';
			const saved = value(service.saveOverallReview(id, NO_EDITS, words));
			expect(saved).toEqual({ body: words, changedAt: 1_700_000_030_000, edits: 1 });
			expect(value(service.overallReview(id))).toEqual(saved);
			// The same words again change nothing, and count nothing.
			expect(value(service.saveOverallReview(id, saved.edits, words))).toEqual(saved);

			// A page that read the words before this change changes nothing, and says why.
			const stale = failure(service.saveOverallReview(id, NO_EDITS, 'From another tab.'));
			expect(stale).toEqual({ kind: 'OverallReviewChanged' });
			expect(describeReportError(stale)).toMatch(/changed since this page read it/);
			expect(value(service.overallReview(id)).body).toBe(words);

			// Only white space empties it, and that is a change too.
			const emptied = value(service.saveOverallReview(id, saved.edits, ' \n\t'));
			expect(emptied).toMatchObject({ body: '', edits: 2 });

			const tooLong = failure(service.saveOverallReview(id, emptied.edits, 'x'.repeat(20_001)));
			expect(tooLong).toEqual({ kind: 'InvalidOverallReview' });
			expect(describeReportError(tooLong)).toMatch(/up to 20,000 characters/);
		} finally {
			service.close();
		}
	});

	it('is saved only while the Delve is open', async () => {
		const { service, id } = await setUp();
		try {
			value(service.closeReport(id));
			expect(failure(service.saveOverallReview(id, NO_EDITS, 'Closed.'))).toMatchObject({
				kind: 'ReportClosed'
			});
			value(service.reopenReport(id));
			expect(value(service.saveOverallReview(id, NO_EDITS, 'Open.')).body).toBe('Open.');
		} finally {
			service.close();
		}
	});

	it('finishes a review on its own, first in the text, and empties it for the next review', async () => {
		const { data, service, id } = await setUp();
		try {
			const overall = value(service.saveOverallReview(id, NO_EDITS, 'Ship it.\n# Really'));
			const preview = value(await service.previewReview(id, FIRST));
			expect(preview.overall).toEqual(overall);
			expect(preview.comments).toEqual([]);
			expect(preview.text).toContain(
				'## Overall\n\n> Ship it.\n> # Really\n\n## Comments\n\nNo comments.\n'
			);

			const review = value(
				await service.finishReview(id, FIRST, { comments: [], overall: overall.edits })
			);
			expect(review).toMatchObject({ number: 1, comments: 0, overall: true, text: preview.text });
			expect(value(service.review(id))).toEqual(review);
			// The draft is empty again, and its count goes on, so a page that showed the words changes nothing.
			expect(value(service.overallReview(id))).toMatchObject({ body: '', edits: 2 });
			expect(failure(service.saveOverallReview(id, overall.edits, 'Again.'))).toEqual({
				kind: 'OverallReviewChanged'
			});
			expect(
				failure(await service.finishReview(id, FIRST, { comments: [], overall: overall.edits }))
			).toEqual({ kind: 'DraftChanged' });
			const db = value(await Database.open(data, settableClock(at(0))));
			try {
				expect(
					value(db.read((q) => ok(q.all('SELECT number, summary FROM reviews')))).map((r) => ({
						...r
					}))
				).toEqual([{ number: 1, summary: 'Ship it.\n# Really' }]);
			} finally {
				db.close();
			}
		} finally {
			service.close();
		}
	});

	it('refuses to finish when it changed since the page showed it, and finishes with comments when it did not', async () => {
		const { service, id } = await setUp();
		try {
			const comment = value(
				await service.addDraftComment(
					id,
					FIRST,
					{ path: path('src/cart.ts'), side: 'new', first: lineNumberOf(1), last: lineNumberOf(1) },
					'One.'
				)
			);
			const shown = [{ id: comment.id, edits: comment.edits }];
			// Written in another tab after this page showed the draft.
			const overall = value(service.saveOverallReview(id, NO_EDITS, 'Written elsewhere.'));
			const changed = failure(
				await service.finishReview(id, FIRST, { comments: shown, overall: NO_EDITS })
			);
			expect(changed).toEqual({ kind: 'DraftChanged' });
			expect(value(service.reviews(id))).toEqual([]);

			const review = value(
				await service.finishReview(id, FIRST, { comments: shown, overall: overall.edits })
			);
			expect(review).toMatchObject({ comments: 1, overall: true });
			expect(review.text.indexOf('## Overall')).toBeLessThan(review.text.indexOf('## Comments'));
			expect(review.text).toContain('> Written elsewhere.');
			expect(value(service.draftComments(id))).toEqual([]);
		} finally {
			service.close();
		}
	});
});
