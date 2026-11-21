/**
 * The chooser's routes against a real daemon, through the typed client: a
 * repository's branches and when it last fetched, a branch's commits a page at
 * a time, the size of a run, asking the remote, and opening what was chosen;
 * and what each says when it cannot.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeApiError } from '#lib/api/client.ts';
import { parseBranchRef } from '#lib/core/history/branch-ref.tiny.ts';
import { formatGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { selectionSource, tick, NOTHING_SELECTED } from '#lib/core/history/commit-selection.ts';
import { itemIndexAt } from '#lib/core/item-index.tiny.ts';
import { clientOf, testDaemon } from '../../../../tests/support/daemons.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';

describe('the chooser’s routes', () => {
	it('list branches and commits, measure a run, ask the remote and open the run, writing nothing', async () => {
		const server = join(await tempDirectory(), 'server.git');
		const repo = await emptyRepo();
		await repo.git('init', '--quiet', '--bare', '--initial-branch=main', server);
		await repo.write('a.txt', 'one\n');
		await repo.commit('Start');
		await repo.write('a.txt', 'one\ntwo\n');
		await repo.commit('Second');
		await repo.write('b.txt', 'b\n');
		await repo.commit('Third');
		await repo.git('remote', 'add', 'origin', server);
		await repo.git('push', '--quiet', 'origin', 'main');
		const client = clientOf(await testDaemon());

		const { before, after, result } = await listingsAround([repo.dir], async () => {
			const history = value(await client.history({ directory: repo.dir, find: '' }));
			const commits = value(
				await client.commits({
					directory: repo.dir,
					branch: value(parseBranchRef('refs/heads/main'))
				})
			);
			const checked = value(await client.checkRemotes({ directory: repo.dir }));
			return { history, commits, checked };
		});
		expect(after).toEqual(before);
		const { history, commits, checked } = result;
		expect(history.branches.map((b) => [b.ref, b.current, b.main])).toEqual([
			['refs/heads/main', true, false],
			['refs/remotes/origin/main', false, true]
		]);
		expect(history.lastFetch.kind).toBe('never');
		expect(commits.commits.map((c) => [c.subject, c.size?.added, c.parent.kind])).toEqual([
			['Third', 1, 'commit'],
			['Second', 1, 'commit'],
			['Start', 1, 'none']
		]);
		expect(checked.remotes).toEqual([
			{ kind: 'compared', remote: 'origin', changed: [], added: [] }
		]);

		// Every commit, from the first: from the empty tree.
		const all = tick(tick(NOTHING_SELECTED, itemIndexAt(0)), itemIndexAt(2));
		const third = commits.commits[0]?.commit;
		if (third === undefined) throw new Error('no commits');
		const size = value(await client.runSize({ directory: repo.dir, from: undefined, to: third }));
		expect(size.size).toEqual({ files: 2, added: 3, removed: 0 });
		const source = value(selectionSource(commits.commits, all));
		const opened = value(
			await client.open({ directory: repo.dir, source: formatGitSourceSpec(source) })
		);
		expect(opened.kind === 'opened' && [opened.diff.title, opened.diff.sizeText]).toEqual([
			`Every commit up to ${third.slice(0, 7)}`,
			'2 files changed, 3 lines added'
		]);
	});

	it('say plainly what is wrong: not a repository, a branch that is not there', async () => {
		const client = clientOf(await testDaemon());
		const folder = await tempDirectory();
		const notRepo = await client.history({ directory: folder, find: '' });
		expect(notRepo.ok ? 'listed' : describeApiError(notRepo.error)).toContain(
			'is not a git repository'
		);
		const repo = await emptyRepo();
		await repo.commit('Start');
		const missing = await client.commits({
			directory: repo.dir,
			branch: value(parseBranchRef('refs/heads/gone'))
		});
		expect(missing.ok ? 'listed' : describeApiError(missing.error)).toContain(
			'git does not know "refs/heads/gone"'
		);
		const offline = await client.checkRemotes({ directory: repo.dir });
		expect(offline.ok && offline.value.remotes).toEqual([]);
	});
});
