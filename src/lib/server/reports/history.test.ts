import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { NO_EDITS } from '#lib/core/edit-count.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import {
	describeHeld,
	describeToday,
	reviewItems,
	startedBy,
	timelineOf
} from '#lib/core/reports/timeline.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { ReportService } from './index.ts';

const path = (text: string): RepoPath => value(parseRepoPath(text));
const version = (n: number): RevisionNumber => value(parseRevisionNumber(n));
const number = (n: number): ReviewNumber => value(parseReviewNumber(n));

describe("a Delve's history", () => {
	it('lists versions and reviews in order, with their delivery log, and shows the Delve as of a review', async () => {
		const repo = await emptyRepo();
		await repo.write('src/a.ts', 'one\n');
		await repo.write('src/b.ts', 'one\n');
		await repo.commit('first');
		await repo.write('src/a.ts', 'two\n');
		await repo.write('src/b.ts', 'two\n');
		const who = await reviewer();
		const clock = settableClock(at(1_700_000_000_000));
		const service = value(
			await ReportService.open({
				dataDirectory: await tempDirectory(),
				clock,
				ids: sequentialIds(),
				repository: { gitEnv: who.gitEnv }
			})
		);
		try {
			const opened = value(await service.open(repo.dir, value(parseGitSourceSpec('working-tree'))));
			if (opened.kind !== 'created') throw new Error(opened.kind);
			const id = opened.report.id;
			const on = (file: string) => ({
				path: path(file),
				side: 'new' as const,
				first: lineNumberOf(1),
				last: lineNumberOf(1)
			});

			// Review 1: a.ts ticked and commented on.
			value(
				await service.markReviewed(id, version(1), { kind: 'file', path: path('src/a.ts') }, true)
			);
			const comment = value(
				await service.addDraftComment(id, version(1), on('src/a.ts'), 'Why two?')
			);
			value(
				await service.finishReview(id, version(1), {
					comments: [{ id: comment.id, edits: comment.edits }],
					overall: NO_EDITS
				})
			);
			// The agent's note and a question written after it are not of it.
			clock.set(at(1_700_000_030_000));
			value(
				await service.addNotes(
					id,
					version(1),
					[{ label: 'risk', file: 'src/b.ts', lines: '+1', text: 'Later.' }],
					false
				)
			);
			value(
				await service.askAgent(id, version(1), { kind: 'file', path: path('src/b.ts') }, 'Why?')
			);
			// Ticks after it change the version, not the review's copy.
			value(
				await service.markReviewed(id, version(1), { kind: 'file', path: path('src/b.ts') }, true)
			);
			value(service.noteHandover(id, number(1), 'clipboard'));
			clock.set(at(1_700_000_060_000));
			value(service.noteHandover(id, number(1), 'clipboard'));
			value(service.noteHandover(id, number(1), 'agent'));

			// Version 2 rewrites a.ts; review 2 resolves the comment.
			clock.set(at(1_700_000_120_000));
			await repo.write('src/a.ts', 'three\n');
			expect(value(await service.update(id)).kind).toBe('updated');
			const thread = value(await service.load(id)).threads[0];
			if (thread === undefined) throw new Error('no thread');
			value(await service.resolveThread(id, version(2), thread.id, true));
			const preview = value(await service.previewReview(id, version(2)));
			value(
				await service.finishReview(id, version(2), {
					comments: [],
					overall: NO_EDITS,
					resolutions: preview.resolutions
				})
			);

			const history = value(service.history(id));
			expect(
				timelineOf(history.versions, history.reviews).map((e) =>
					e.kind === 'version'
						? `version ${String(e.version.number)}`
						: `review ${String(e.review.number)}`
				)
			).toEqual(['version 1', 'review 1', 'version 2', 'review 2']);
			expect(history.versions[1]?.update).toMatchObject({ filesChanged: 1, reviewedBefore: 4 });
			const [first, second] = history.reviews;
			expect(first).toMatchObject({
				copied: { times: 2, first: at(1_700_000_030_000), last: at(1_700_000_060_000) },
				read: { times: 1 }
			});
			expect(second).toMatchObject({ copied: undefined, read: undefined });
			expect(second && describeHeld(second, history.threads)).toBe(
				'1 earlier comment resolved or reopened'
			);
			// Review 1's comment was resolved by review 2: so it stands today.
			expect(describeToday(startedBy(history.threads, number(1)))).toBe('Today: 1 resolved');
			const items = reviewItems(history.threads, number(2));
			expect(items.items).toEqual([]);
			expect(items.resolutions).toMatchObject([{ resolved: true, from: 1, status: 'resolved' }]);
			expect(reviewItems(history.threads, number(1)).items).toMatchObject([
				{ kind: 'comment', version: 1, body: 'Why two?', status: 'resolved' }
			]);

			// As of review 1: version 1, a.ts reviewed and b.ts not, and the thread as it stood.
			const then = value(await service.load(id, undefined, number(1)));
			expect(then.asOf).toEqual({ number: 1, submittedAt: at(1_700_000_000_000) });
			expect(then.revision.number).toBe(1);
			expect(then.notes).toEqual([]);
			expect(then.requests).toEqual([]);
			expect(value(await service.load(id, version(1))).notes).toHaveLength(1);
			expect(then.summary.progress).toMatchObject({ reviewed: 2, counted: 4 });
			// Its own comment at its lines, open as it was then; as of review 2, resolved.
			expect(then.threads).toMatchObject([{ status: 'open', messages: [{ review: 1 }] }]);
			expect(value(await service.load(id, undefined, number(2))).threads).toMatchObject([
				{ status: 'resolved' }
			]);
			const now = value(await service.load(id, version(1)));
			expect(now.asOf).toBeUndefined();
			expect(now.summary.progress.reviewed).toBe(4);
			expect(await service.load(id, undefined, number(3))).toMatchObject({
				ok: false,
				error: { kind: 'ReviewNotFound', number: 3 }
			});
		} finally {
			service.close();
		}
	});
});
