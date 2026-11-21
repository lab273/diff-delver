/**
 * The choose page's routes against a real daemon, through the typed client: a
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

describe('the choose page’s routes', () => {
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
			'The first 3 commits: “Start” to “Third”',
			'2 files changed, 3 lines added'
		]);

		// A run of two, from the first commit's child: named the same in the list of
		// diffs, on its page and when it is opened again, without reading the repository.
		const two = tick(tick(NOTHING_SELECTED, itemIndexAt(0)), itemIndexAt(1));
		const pair = value(
			await client.open({
				directory: repo.dir,
				source: formatGitSourceSpec(value(selectionSource(commits.commits, two)))
			})
		);
		if (pair.kind !== 'opened') throw new Error(pair.kind);
		const title = '2 commits: “Second” and “Third”';
		expect(pair.diff.title).toBe(title);
		const listed = value(await client.listDiffs()).diffs.map((d) => d.kind === 'diff' && d.title);
		expect(listed.toSorted()).toEqual([title, 'The first 3 commits: “Start” to “Third”']);
		expect(value(await client.loadDiff(pair.diff.id)).summary.title).toBe(title);
		const again = value(
			await client.open({
				directory: repo.dir,
				source: formatGitSourceSpec(value(selectionSource(commits.commits, two)))
			})
		);
		expect(again.kind === 'opened' && [again.diff.id, again.diff.title]).toEqual([
			pair.diff.id,
			title
		]);

		// Two ids that are not a run, written by hand: titled by what they compare.
		await repo.git('checkout', '--quiet', '-b', 'other', `${third}~2`);
		await repo.write('c.txt', 'c\n');
		const { commit: other } = await repo.commit('Another way');
		const apart = value(await client.open({ directory: repo.dir, source: `${third}...${other}` }));
		expect(apart.kind === 'opened' && apart.diff.title).toBe(
			`Commit ${other.slice(0, 7)} compared with commit ${third.slice(0, 7)}`
		);
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
		expect(value(await client.history({ directory: repo.dir, find: '' })).noCommits).toBe(false);
	});

	it('say a repository has no commits yet, or only none on a branch', async () => {
		const client = clientOf(await testDaemon());
		const empty = await emptyRepo();
		const nothing = value(await client.history({ directory: empty.dir, find: '' }));
		expect([nothing.branches, nothing.noCommits]).toEqual([[], true]);
		// A commit checked out with no branch at all: there are commits, and no branch to choose.
		await empty.write('a.txt', 'a\n');
		const { commit } = await empty.commit('Start');
		await empty.git('checkout', '--quiet', '--detach', commit);
		await empty.git('branch', '--quiet', '-D', 'main');
		const detached = value(await client.history({ directory: empty.dir, find: '' }));
		expect([detached.branches, detached.noCommits]).toEqual([[], false]);
	});
});
