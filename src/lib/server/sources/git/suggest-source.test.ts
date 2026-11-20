import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { listingsAround } from '../../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory } from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { reviewer, type Reviewer } from '../../../../../tests/support/reviewer-git.ts';
import {
	candidateSourceText,
	describeGitSourceError,
	suggestSource,
	type SourceSuggestion
} from './index.ts';

/** The suggestion for a directory, checking that working it out wrote nothing. */
async function suggestion(dir: AbsolutePath, who?: Reviewer): Promise<SourceSuggestion> {
	const setup = who ?? (await reviewer());
	const { before, after, result } = await listingsAround([dir], () =>
		suggestSource(dir, { gitEnv: setup.gitEnv })
	);
	expect(after).toEqual(before);
	return value(result).suggestion;
}

/** What a chooser would show: each description with the source it opens. */
function shown(s: SourceSuggestion): unknown {
	switch (s.kind) {
		case 'one':
			return {
				one: [s.candidate.description, candidateSourceText(s.candidate)],
				others: s.others.map((c) => [c.description, candidateSourceText(c)])
			};
		case 'choose':
			return { choose: s.candidates.map((c) => [c.description, candidateSourceText(c)]) };
		case 'nothing':
			return { nothing: s.reason, candidates: s.candidates.map((c) => c.description) };
	}
}

async function mainWithFeature(): Promise<GitRepo> {
	const repo = await emptyRepo();
	await repo.write('app.txt', 'one\n');
	await repo.commit('base');
	await repo.git('checkout', '--quiet', '-b', 'feature-x');
	await repo.write('x1.txt', 'one\n');
	await repo.write('x2.txt', 'two\n');
	await repo.commit('feature work');
	return repo;
}

describe('suggestSource', () => {
	it('offers the uncommitted changes first, with the branch beside them', async () => {
		const repo = await mainWithFeature();
		await repo.write('app.txt', 'edited\n');
		await repo.write('new/untracked.txt', 'new\n');
		expect(shown(await suggestion(repo.dir))).toEqual({
			one: ['Uncommitted changes (2 files)', 'working-tree'],
			others: [['feature-x compared with main (2 files)', 'refs/heads/main...refs/heads/feature-x']]
		});
	});

	it('compares a clean branch with the main branch, from where they parted', async () => {
		const repo = await mainWithFeature();
		await repo.git('checkout', '--quiet', 'main');
		await repo.write('main-only.txt', 'main moved on\n');
		await repo.commit('main later');
		await repo.git('checkout', '--quiet', 'feature-x');
		expect(shown(await suggestion(repo.dir))).toEqual({
			one: ['feature-x compared with main (2 files)', 'refs/heads/main...refs/heads/feature-x'],
			others: []
		});
	});

	it("uses the remote's default branch, and on the main branch offers what is not pushed", async () => {
		const origin = await mainWithFeature();
		await origin.git('checkout', '--quiet', 'main');
		await origin.git('branch', '-m', 'main', 'trunk-line');
		const clone = absolutePath(join(await tempDirectory(), 'clone'));
		await origin.git('clone', '--quiet', origin.dir, clone);
		const repo = GitRepo.open(clone);
		await repo.git('checkout', '--quiet', 'feature-x');
		expect(shown(await suggestion(clone))).toEqual({
			one: [
				'feature-x compared with origin/trunk-line (2 files)',
				'refs/remotes/origin/trunk-line...refs/heads/feature-x'
			],
			others: []
		});
		await repo.git('checkout', '--quiet', 'trunk-line');
		await repo.write('unpushed.txt', 'not pushed yet\n');
		await repo.commit('unpushed');
		expect(shown(await suggestion(clone))).toEqual({
			one: [
				'trunk-line compared with origin/trunk-line (1 file)',
				'refs/remotes/origin/trunk-line...refs/heads/trunk-line'
			],
			others: []
		});
	});

	it('says there is nothing new on a clean main branch, and offers the last commit', async () => {
		const repo = await mainWithFeature();
		await repo.git('checkout', '--quiet', '-b', 'merged', 'main');
		expect(shown(await suggestion(repo.dir))).toMatchObject({
			nothing:
				'There is nothing new to review: there are no uncommitted changes, and merged has no commits that main does not have. You can still open the last commit.'
		});
		await repo.git('checkout', '--quiet', 'main');
		expect(shown(await suggestion(repo.dir))).toEqual({
			nothing:
				'There is nothing new to review: there are no uncommitted changes, and you are on main, the main branch, with nothing that is not pushed. You can still open the last commit.',
			candidates: ['The last commit (1 file)']
		});
	});

	it('lets the person choose when both main and master could be the main branch', async () => {
		const repo = await mainWithFeature();
		await repo.git('branch', 'master', 'main');
		expect(shown(await suggestion(repo.dir))).toEqual({
			choose: [
				['feature-x compared with main (2 files)', 'refs/heads/main...refs/heads/feature-x'],
				['feature-x compared with master (2 files)', 'refs/heads/master...refs/heads/feature-x']
			]
		});
	});

	it("follows the reviewer's configured default branch name, and a detached HEAD", async () => {
		const repo = await emptyRepo();
		await repo.git('checkout', '--quiet', '-b', 'develop');
		await repo.write('a.txt', 'one\n');
		await repo.commit('base');
		await repo.write('b.txt', 'two\n');
		await repo.commit('more');
		await repo.git('checkout', '--quiet', '--detach', 'HEAD');
		await repo.git('branch', '-f', 'develop', 'HEAD~1');
		await repo.git('branch', '-D', 'main').catch(() => '');
		const who = await reviewer('[init]\n\tdefaultBranch = develop\n');
		expect(shown(await suggestion(repo.dir, who))).toEqual({
			one: ['The checked-out commit compared with develop (1 file)', 'refs/heads/develop...HEAD'],
			others: []
		});
		const unsure = shown(await suggestion(repo.dir));
		expect(unsure).toMatchObject({ candidates: ['The last commit (1 file)'] });
		expect(JSON.stringify(unsure)).toContain('could not tell which branch is the main one');
	});

	it('handles a repository with no commits, and says plainly when there is no repository', async () => {
		const repo = await emptyRepo();
		expect(shown(await suggestion(repo.dir))).toEqual({
			nothing:
				'This repository has no commits and no files yet, so there is nothing to review. Add some files, then run diff delver again.',
			candidates: []
		});
		await repo.write('first.txt', 'first\n');
		expect(shown(await suggestion(repo.dir))).toEqual({
			one: ['Uncommitted changes (1 file)', 'working-tree'],
			others: []
		});
		const plain = await tempDirectory();
		const result = await suggestSource(plain, {
			gitEnv: { ...(await reviewer()).gitEnv, GIT_CEILING_DIRECTORIES: join(plain, '..') }
		});
		expect(result.ok ? 'found' : result.error.kind).toBe('NotARepository');
		if (!result.ok)
			expect(describeGitSourceError(result.error)).toMatch(/Run diff delver inside a repository/);
	});

	it('works in a bare repository, comparing branches', async () => {
		const origin = await mainWithFeature();
		const bare = absolutePath(join(await tempDirectory(), 'bare.git'));
		await origin.git('clone', '--quiet', '--bare', origin.dir, bare);
		expect(shown(await suggestion(bare))).toEqual({
			one: ['feature-x compared with main (2 files)', 'refs/heads/main...refs/heads/feature-x'],
			others: []
		});
	});
});
