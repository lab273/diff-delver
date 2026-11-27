import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { NO_EDITS } from '#lib/core/edit-count.tiny.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import type { DraftComment } from '#lib/core/review/draft-comment.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { ReportService } from './index.ts';

const path = (text: string): RepoPath => value(parseRepoPath(text));
const version = (n: number): RevisionNumber => value(parseRevisionNumber(n));
const lines = (count: number, change: (i: number) => string | undefined = () => undefined) =>
	`${Array.from({ length: count }, (_, i) => change(i + 1) ?? `line ${String(i + 1)}`).join('\n')}\n`;

function shown(comments: readonly DraftComment[]) {
	return comments.map((c) => ({ id: c.id, edits: c.edits }));
}

describe('threads of earlier reviews', () => {
	it('follows each to the next version, says whose code changed, and finishes replies and resolutions', async () => {
		const repo = await emptyRepo();
		await repo.write('src/cart.ts', lines(20));
		await repo.write('src/gone.ts', lines(3));
		await repo.commit('first');
		// Every line of the cart is new on the working tree, so both comments are on changes.
		await repo.write(
			'src/cart.ts',
			lines(20, (i) => `cart ${String(i)}`)
		);
		await repo.write(
			'src/gone.ts',
			lines(3, (i) => `gone ${String(i)}`)
		);
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
			const on = (file: string, first: number, last = first) => ({
				path: path(file),
				side: 'new' as const,
				first: lineNumberOf(first),
				last: lineNumberOf(last)
			});
			const rewritten = value(
				await service.addDraftComment(id, version(1), on('src/cart.ts', 3), 'Three?')
			);
			const kept = value(
				await service.addDraftComment(id, version(1), on('src/cart.ts', 10, 11), 'Ten and eleven.')
			);
			const lost = value(
				await service.addDraftComment(id, version(1), on('src/gone.ts', 2), 'Gone?')
			);
			value(
				await service.finishReview(id, version(1), {
					comments: shown([rewritten, kept, lost]),
					overall: NO_EDITS
				})
			);
			const first = value(await service.load(id));
			expect(first.threads.map((t) => ({ status: t.status, at: t.at }))).toEqual([
				{ status: 'open', at: on('src/cart.ts', 3) },
				{ status: 'open', at: on('src/cart.ts', 10, 11) },
				{ status: 'open', at: on('src/gone.ts', 2) }
			]);

			// The agent rewrites line 3, puts two lines on top, and deletes the other file.
			await repo.write(
				'src/cart.ts',
				`top\nmore\n${lines(20, (i) => (i === 3 ? 'cart three, fixed' : `cart ${String(i)}`))}`
			);
			await repo.remove('src/gone.ts');
			const updated = value(await service.update(id));
			expect(updated.kind).toBe('updated');
			const second = value(await service.load(id));
			expect(second.revision.number).toBe(2);
			const [changed, open, gone] = second.threads;
			expect(changed).toMatchObject({ status: 'changed', at: on('src/cart.ts', 5) });
			expect(open).toMatchObject({ status: 'open', at: on('src/cart.ts', 12, 13) });
			expect(gone).toMatchObject({ status: 'changed', at: undefined, quoted: ['gone 2'] });
			if (changed === undefined || open === undefined || gone === undefined) return;

			const reply = value(await service.replyToThread(id, version(2), open.id, 'Still wrong.'));
			expect(reply).toMatchObject({
				replyTo: open.id,
				anchor: on('src/cart.ts', 12, 13),
				version: 2
			});
			expect(value(await service.resolveThread(id, version(2), changed.id, true))).toEqual([
				{ thread: changed.id, resolved: true }
			]);
			// Resolving it again leaves one; taking it back leaves none.
			value(await service.resolveThread(id, version(2), gone.id, true));
			expect(value(await service.resolveThread(id, version(2), gone.id, undefined))).toEqual([
				{ thread: changed.id, resolved: true }
			]);
			const preview = value(await service.previewReview(id, version(2)));
			expect(preview.text).toContain(
				[
					'## Still open from earlier reviews',
					'',
					'### src/cart.ts:12-13 (new), from review 1, unchanged',
					'> Ten and eleven.',
					'Reply in this review:',
					'> Still wrong.',
					'',
					'### src/gone.ts:2 (new, version 1), from review 1, its lines are gone',
					'```typescript',
					'gone 2',
					'```',
					'> Gone?',
					'',
					'## Resolved in this review',
					'',
					'### src/cart.ts:5 (new), from review 1, changed since',
					'> Three?'
				].join('\n')
			);
			// The draft changed since the page read it: resolutions are part of it.
			expect(
				(
					await service.finishReview(id, version(2), {
						comments: shown([reply]),
						overall: NO_EDITS
					})
				).ok
			).toBe(false);
			const review = value(
				await service.finishReview(id, version(2), {
					comments: shown([reply]),
					overall: NO_EDITS,
					resolutions: preview.resolutions
				})
			);
			expect(review).toMatchObject({ number: 2, comments: 1 });
			expect(value(service.draftComments(id))).toEqual([]);
			expect(value(service.draftResolutions(id))).toEqual([]);

			const after = value(await service.load(id));
			expect(after.threads.map((t) => [t.status, t.messages.map((m) => m.body)])).toEqual([
				['resolved', ['Three?']],
				['open', ['Ten and eleven.', 'Still wrong.']],
				['changed', ['Gone?']]
			]);

			// Resolved on version 2; then two updates that no page shows, the second
			// rewriting the lines it is on; the draft is finished on version 4.
			value(await service.resolveThread(id, version(2), open.id, true));
			const cart = (change: (i: number) => string | undefined) =>
				`top\nmore\n${lines(20, (i) => change(i) ?? (i === 3 ? 'cart three, fixed' : `cart ${String(i)}`))}`;
			await repo.write(
				'src/cart.ts',
				cart((i) => (i === 18 ? 'cart eighteen' : undefined))
			);
			expect(value(await service.update(id)).kind).toBe('updated');
			await repo.write(
				'src/cart.ts',
				cart((i) => (i === 18 ? 'cart eighteen' : i === 11 ? 'cart eleven' : undefined))
			);
			expect(value(await service.update(id)).kind).toBe('updated');
			// A reply to the thread whose lines are gone, on version 4, counts from there.
			const answer = value(
				await service.replyToThread(id, version(4), gone.id, 'Fine that it went.')
			);
			expect(answer).toMatchObject({ version: 4, replyTo: gone.id });
			const fourth = value(await service.load(id));
			expect(fourth.revision.number).toBe(4);
			expect(fourth.threads.map((t) => [t.status, t.at?.first])).toEqual([
				['resolved', 5],
				['changed', 12],
				['changed', undefined]
			]);
			const last = value(await service.previewReview(id, version(4)));
			expect(last.resolutions).toEqual([{ thread: open.id, resolved: true }]);
			value(
				await service.finishReview(id, version(4), {
					comments: shown([answer]),
					overall: NO_EDITS,
					resolutions: last.resolutions
				})
			);
			const done = value(await service.load(id));
			expect(done.threads.map((t) => t.status)).toEqual(['resolved', 'resolved', 'open']);
		} finally {
			service.close();
		}
	});
});
