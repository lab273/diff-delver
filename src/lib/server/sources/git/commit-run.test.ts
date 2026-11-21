import { describe, expect, it } from 'vitest';
import { EMPTY_TREE } from '#lib/core/object-format.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { listingsAround } from '../../../../../tests/support/directory-listing.ts';
import { emptyRepo } from '../../../../../tests/support/fixture-repos.ts';
import type { GitRepo } from '../../../../../tests/support/git-repo.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { reviewer } from '../../../../../tests/support/reviewer-git.ts';
import { readCommitRun } from './commit-run.ts';
import { locateRepository } from './index.ts';

function range(from: string, to: string): GitSourceSpec {
	return value(parseGitSourceSpec(`${from}...${to}`));
}

/**
 * main: "Start the shop", "Add prices", a merge of `side` (one commit of its
 * own), then "Show the total" and "Say which code was used"; and `other`, from
 * the first commit, with a commit main does not have.
 */
async function shop(): Promise<{ repo: GitRepo; ids: Record<string, string> }> {
	const repo = await emptyRepo();
	const ids: Record<string, string> = {};
	const commit = async (name: string, file: string, subject: string) => {
		await repo.write(file, `${subject}\n`);
		ids[name] = (await repo.commit(subject)).commit;
	};
	await commit('start', 'a.txt', 'Start the shop');
	await commit('prices', 'b.txt', 'Add prices');
	await repo.git('checkout', '--quiet', '-b', 'side');
	await commit('side', 'side.txt', 'Work on the side');
	await repo.git('checkout', '--quiet', 'main');
	await repo.git('merge', '--quiet', '--no-ff', '-m', 'Merge the side', 'side');
	ids.merge = (await repo.git('rev-parse', 'HEAD')).trim();
	await commit('total', 'c.txt', 'Show the total');
	await commit('code', 'd.txt', 'Say which code was used');
	await repo.git('checkout', '--quiet', '-b', 'other', ids.start ?? '');
	await commit('other', 'e.txt', 'Go another way');
	await repo.git('checkout', '--quiet', 'main');
	return { repo, ids };
}

describe('what a run of commits is made of', () => {
	it('counts the commits along first parents and reads the oldest and newest subjects, writing nothing', async () => {
		const { repo, ids } = await shop();
		const found = value(await locateRepository(repo.dir, { gitEnv: (await reviewer()).gitEnv }));
		const id = (name: string): string => ids[name] ?? '';
		const { before, after, result } = await listingsAround([repo.dir], async () => ({
			// "Add prices"’s parent to the newest: the merge counts once, its side commit not at all.
			single: await readCommitRun(found, value(parseGitSourceSpec(id('code')))),
			four: await readCommitRun(found, range(id('start'), id('code'))),
			two: await readCommitRun(found, range(id('merge'), id('code'))),
			one: await readCommitRun(found, range(id('total'), id('code'))),
			fromFirst: await readCommitRun(found, range(EMPTY_TREE.sha1, id('prices'))),
			first: await readCommitRun(found, range(EMPTY_TREE.sha1, id('start')))
		}));
		expect(after).toEqual(before);
		expect(result).toEqual({
			single: { commits: 1, oldest: 'Say which code was used', newest: 'Say which code was used' },
			four: { commits: 4, oldest: 'Add prices', newest: 'Say which code was used' },
			two: { commits: 2, oldest: 'Show the total', newest: 'Say which code was used' },
			one: { commits: 1, oldest: 'Say which code was used', newest: 'Say which code was used' },
			fromFirst: { commits: 2, oldest: 'Start the shop', newest: 'Add prices' },
			first: { commits: 1, oldest: 'Start the shop', newest: 'Start the shop' }
		});
	});

	it('finds no run in what is not one', async () => {
		const { repo, ids } = await shop();
		const found = value(await locateRepository(repo.dir, { gitEnv: (await reviewer()).gitEnv }));
		const id = (name: string): string => ids[name] ?? '';
		const spec = (text: string): GitSourceSpec => value(parseGitSourceSpec(text));
		for (const notARun of [
			// Two ids that went different ways: the first is not below the second.
			range(id('other'), id('code')),
			// A commit merged in from the side: reached, but not along first parents.
			range(id('side'), id('code')),
			// Newer to older: nothing between them.
			range(id('code'), id('start')),
			// Names, which may come to mean other commits.
			spec('refs/heads/other...refs/heads/main'),
			spec(`${id('start')}...HEAD`),
			spec('HEAD'),
			spec('working-tree'),
			// An id of nothing in this repository.
			range(id('start'), 'f'.repeat(40))
		]) {
			expect(await readCommitRun(found, notARun)).toBeUndefined();
		}
	});
});
