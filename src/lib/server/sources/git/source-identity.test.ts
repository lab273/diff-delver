import { randomIds } from '#lib/server/system.ts';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { listingsAround } from '../../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory } from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import { located, value } from '../../../../../tests/support/git-source-helpers.ts';
import { partialClone, type CloneFilter } from '../../../../../tests/support/partial-clone.ts';
import { reviewer, type Reviewer } from '../../../../../tests/support/reviewer-git.ts';
import { snapshotGitSource, sourceIdentity } from './index.ts';

/** The identity of a source now, checking that working it out wrote nothing. */
async function identityOf(repo: GitRepo, source: string, who: Reviewer): Promise<SourceIdentity> {
	const spec = value(parseGitSourceSpec(source));
	const { before, after, result } = await listingsAround([repo.dir], async () =>
		sourceIdentity(await located(repo.dir, who), spec)
	);
	expect(after).toEqual(before);
	return value(result);
}

async function repoWithHistory(): Promise<GitRepo> {
	const repo = await emptyRepo();
	await repo.write('a.txt', 'one\n');
	await repo.write('.gitignore', '*.log\n');
	await repo.commit('one');
	await repo.git('branch', 'feature');
	return repo;
}

describe('sourceIdentity', () => {
	it('follows the commits a commit or range names', async () => {
		const repo = await repoWithHistory();
		const who = await reviewer();
		const commit = await identityOf(repo, 'main', who);
		const range = await identityOf(repo, 'main...feature', who);
		expect(await identityOf(repo, 'main', who)).toBe(commit);
		await repo.write('a.txt', 'edited, not committed\n');
		expect(await identityOf(repo, 'main', who)).toBe(commit);
		await repo.git('checkout', '--quiet', 'feature');
		await repo.write('f.txt', 'feature\n');
		await repo.commit('feature work');
		expect(await identityOf(repo, 'main', who)).toBe(commit);
		expect(await identityOf(repo, 'main...feature', who)).not.toBe(range);
	});

	it('follows the index for staged changes, and not the cached file stats', async () => {
		const repo = await repoWithHistory();
		const who = await reviewer();
		const first = await identityOf(repo, 'staged', who);
		await repo.write('a.txt', 'edited, not staged\n');
		expect(await identityOf(repo, 'staged', who)).toBe(first);
		// git status rewrites the index with fresh stats; what is staged is the same.
		await utimes(join(repo.dir, '.gitignore'), new Date(1_000_000), new Date(1_000_000));
		await repo.git('update-index', '--refresh').catch(() => '');
		expect(await identityOf(repo, 'staged', who)).toBe(first);
		await repo.git('add', 'a.txt');
		expect(await identityOf(repo, 'staged', who)).not.toBe(first);
	});

	it('notices every change a working-tree snapshot would show, and not ignored files', async () => {
		const repo = await repoWithHistory();
		const who = await reviewer();
		const seen = new Set<string>();
		const expectNew = async (): Promise<void> => {
			const identity = await identityOf(repo, 'working-tree', who);
			expect(seen.has(identity)).toBe(false);
			seen.add(identity);
		};
		await expectNew();
		await repo.write('debug.log', 'ignored\n');
		expect(seen.has(await identityOf(repo, 'working-tree', who))).toBe(true);
		await repo.write('a.txt', 'aaaa\n');
		await expectNew();
		// The same size, edited again: only the file's times tell.
		await repo.write('a.txt', 'bbbb\n');
		await utimes(join(repo.dir, 'a.txt'), new Date(2_000_000), new Date(2_000_000));
		await expectNew();
		await repo.write('new/deeper/file.txt', 'untracked\n');
		await expectNew();
		await repo.write('new/deeper/file.txt', 'untracked, edited\n');
		await expectNew();
		await repo.remove('new');
		await repo.write('a.txt', 'one\n');
		// Back to where it started: the same identity as at first.
		expect(seen.has(await identityOf(repo, 'working-tree', who))).toBe(true);
	});

	it('notices a submodule or nested repository moving to another commit', async () => {
		const repo = await repoWithHistory();
		const nested = await GitRepo.init(absolutePath(join(repo.dir, 'nested')));
		await nested.write('n.txt', 'one\n');
		await nested.commit('one');
		const who = await reviewer();
		const first = await identityOf(repo, 'working-tree', who);
		await nested.write('n.txt', 'two\n');
		await nested.commit('two');
		const second = await identityOf(repo, 'working-tree', who);
		expect(second).not.toBe(first);
		// Uncommitted edits inside it are not part of a snapshot, so they do not count.
		await nested.write('n.txt', 'three, uncommitted\n');
		expect(await identityOf(repo, 'working-tree', who)).toBe(second);
	});

	it('matches the identity a snapshot records, so a fresh snapshot shows no change', async () => {
		const repo = await repoWithHistory();
		await repo.write('a.txt', 'edited\n');
		await repo.write('b.txt', 'new\n');
		const who = await reviewer();
		const found = await located(repo.dir, who);
		for (const kind of ['working-tree', 'staged'] as const) {
			const taken = value(
				await snapshotGitSource(await tempDirectory(), found, { kind }, randomIds.snapshotId())
			);
			expect(value(await sourceIdentity(found, { kind }))).toBe(taken.identity);
		}
	});

	it('reads split and sparse indexes without writing to the repository', async () => {
		const split = await repoWithHistory();
		await split.git('config', 'core.splitIndex', 'true');
		await split.git('update-index', '--split-index');
		await split.write('a.txt', 'edited\n');
		const who = await reviewer();
		await identityOf(split, 'working-tree', who);
		await identityOf(split, 'staged', who);
		const sparse = await emptyRepo();
		for (const dir of ['in', 'out']) await sparse.write(`${dir}/f.txt`, `${dir}\n`);
		await sparse.commit('base');
		await sparse.git('sparse-checkout', 'set', '--cone', 'in');
		await sparse.git('config', 'index.sparse', 'true');
		await sparse.git('sparse-checkout', 'reapply');
		await sparse.write('in/f.txt', 'edited\n');
		await identityOf(sparse, 'working-tree', who);
		await identityOf(sparse, 'staged', who);
	});

	it.each<CloneFilter>(['blob:none', 'tree:0'])(
		'fetches nothing into a partial clone (%s), for any source',
		async (filter) => {
			const { clone } = await partialClone(filter);
			const who = await reviewer();
			await clone.write('new.txt', 'new\n');
			for (const source of ['HEAD', 'origin/main...feat', 'staged', 'working-tree']) {
				await identityOf(clone, source, who);
			}
		}
	);
});
