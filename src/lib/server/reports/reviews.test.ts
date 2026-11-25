import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseEditCount } from '#lib/core/edit-count.tiny.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { Result } from '#lib/core/result.ts';
import { parseReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { DATABASE_FILE } from '../db/index.ts';
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
				await service.finishReview(id, FIRST, [{ id: comment.id, edits: comment.edits }])
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
				'### src/cart.ts:2-3 (new)\n```typescript\n2\n3\n```\nWhy are these numbers now?\n'
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
				await service.finishReview(id, FIRST, [{ id: next.id, edits: next.edits }])
			);
			expect(second.number).toBe(2);
			expect(value(service.review(id))?.number).toBe(2);
			expect(value(service.reviews(id)).map((r) => r.number)).toEqual([1, 2]);
		} finally {
			service.close();
		}
	});

	it('refuses to finish an empty draft, a draft that changed since the page showed it, and an old version', async () => {
		const { repo, service, id } = await setUp();
		try {
			const empty = failure(await service.finishReview(id, FIRST, []));
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
				await service.finishReview(id, FIRST, [{ id: comment.id, edits: value(parseEditCount(1)) }])
			);
			expect(changed).toEqual({ kind: 'DraftChanged' });
			expect(failure(await service.finishReview(id, FIRST, []))).toEqual({ kind: 'DraftChanged' });

			await repo.write('src/cart.ts', 'changed again\n');
			value(await service.update(id));
			expect(
				failure(await service.finishReview(id, FIRST, [{ id: comment.id, edits: comment.edits }]))
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
				await service.finishReview(id, second, [{ id: comment.id, edits: comment.edits }])
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
