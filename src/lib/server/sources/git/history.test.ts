import { rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	branchName,
	isRemoteBranch,
	parseBranchRef,
	type BranchRef
} from '#lib/core/history/branch-ref.tiny.ts';
import { listingsAround } from '../../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory } from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { partialClone } from '../../../../../tests/support/partial-clone.ts';
import { reviewer } from '../../../../../tests/support/reviewer-git.ts';
import {
	BRANCHES_SHOWN,
	COMMITS_PER_PAGE,
	lastFetch,
	listBranches,
	listCommits,
	rangeSize,
	remotesOf,
	trackedBranches
} from './history.ts';
import { locateRepository } from './index.ts';

function ref(name: string): BranchRef {
	return value(parseBranchRef(name));
}

/** The time git's fixture dates give the commit made `n`-th, from 0. */
function fixtureTime(n: number): number {
	return (1_700_000_000 + n * 60) * 1000;
}

/**
 * main: three commits, the second renaming a file and adding a binary one,
 * then a merge of `side`; `feature` from main's second commit with two more,
 * checked out; a bare `origin` with main and `prices`, fetched.
 */
async function shop(): Promise<{ repo: GitRepo; server: GitRepo }> {
	const server = GitRepo.open(absolutePath(join(await tempDirectory(), 'server.git')));
	const repo = await emptyRepo();
	await repo.git('init', '--quiet', '--bare', '--initial-branch=main', server.dir);
	await repo.write('cart.txt', 'one\ntwo\n');
	await repo.commit('Start the shop');
	await repo.move('cart.txt', 'basket.txt');
	await repo.write('basket.txt', 'one\ntwo\nthree\n');
	await repo.write('logo.png', new Uint8Array([0x89, 0x50, 0, 1, 2]));
	await repo.commit('Rename the cart');
	await repo.git('checkout', '--quiet', '-b', 'feature');
	await repo.write('sale.txt', 'sale\n');
	await repo.commit('Add a sale');
	await repo.write('sale.txt', 'sale\nbig\n');
	await repo.commit('Make the sale big');
	await repo.git('checkout', '--quiet', '-b', 'side', 'main');
	await repo.write('side.txt', 'a\nb\n');
	await repo.commit('Work on the side');
	await repo.git('checkout', '--quiet', 'main');
	await repo.write('basket.txt', 'one\n');
	await repo.commit('Shorten the basket');
	await repo.git('merge', '--quiet', '--no-ff', '-m', 'Merge the side', 'side');
	// Pushed by address, so that only the fetch below makes the remote-tracking branches.
	await repo.git('push', '--quiet', server.dir, 'main', 'main:prices');
	await repo.git('remote', 'add', 'origin', server.dir);
	await repo.git('fetch', '--quiet', 'origin');
	await repo.git('remote', 'set-head', 'origin', 'main');
	await repo.git('branch', '--quiet', '-D', 'side');
	await repo.git('checkout', '--quiet', 'feature');
	return { repo, server };
}

async function located(repo: GitRepo, gitEnv: Readonly<Record<string, string>>) {
	return value(await locateRepository(repo.dir, { gitEnv }));
}

/** Runs `work` and expects the repository to be exactly as it was. */
async function readOnly<T>(repo: GitRepo, work: () => Promise<T>): Promise<T> {
	const { before, after, result } = await listingsAround([repo.dir], work);
	expect(after).toEqual(before);
	return result;
}

describe('a repository’s branches', () => {
	it('lists local branches, remote ones with no local branch and the main branch, the checked-out one first', async () => {
		const { repo } = await shop();
		const found = await located(repo, (await reviewer()).gitEnv);
		const branches = value(await readOnly(repo, () => listBranches(found, '')));
		expect(branches.main).toBe('refs/remotes/origin/main');
		expect(branches.shown.map((b) => [branchName(b.ref), b.current, b.main, b.ahead])).toEqual([
			['feature', true, false, 2],
			['main', false, false, 0],
			['origin/main', false, true, 0],
			['origin/prices', false, false, 0]
		]);
		expect(branches.matching).toBe(4);
		expect(branches.remotes).toEqual(['origin']);
		const tracked = value(await readOnly(repo, () => trackedBranches(found)));
		expect(tracked.map((t) => [t.ref, t.commit])).toEqual([
			['refs/remotes/origin/main', (await repo.git('rev-parse', 'origin/main')).trim()],
			['refs/remotes/origin/prices', (await repo.git('rev-parse', 'origin/prices')).trim()]
		]);
		const feature = branches.shown[0];
		expect(feature?.committedAt).toBe(fixtureTime(3));
		const found2 = value(await listBranches(found, 'PRI'));
		expect(found2.shown.map((b) => b.ref)).toEqual(['refs/remotes/origin/prices']);
	});

	it('counts what a local main has that the remote main branch lacks, as for any branch', async () => {
		const { repo } = await shop();
		await repo.git('checkout', '--quiet', 'main');
		await repo.write('later.txt', 'later\n');
		await repo.commit('Not pushed yet');
		const found = await located(repo, (await reviewer()).gitEnv);
		const branches = value(await listBranches(found, ''));
		expect(branches.main).toBe('refs/remotes/origin/main');
		// One branch is the main branch: the one the counts are against.
		expect(
			branches.shown.map((b) => [branchName(b.ref), isRemoteBranch(b.ref), b.main, b.ahead])
		).toEqual([
			['main', false, false, 1],
			['origin/main', true, true, 0],
			['origin/prices', true, false, 0],
			['feature', false, false, 2]
		]);
		const page = value(await listCommits(found, ref('refs/heads/main'), undefined, branches.main));
		expect(page.commits.map((c) => [c.subject, c.onMain]).slice(0, 2)).toEqual([
			['Not pushed yet', false],
			['Merge the side', true]
		]);
	});

	it('shows a bounded number of many branches, keeps every name exact and never reads one as an option', async () => {
		const repo = await emptyRepo();
		await repo.write('a.txt', 'a\n');
		const { commit } = await repo.commit('Start');
		for (let i = 0; i < BRANCHES_SHOWN + 10; i += 1) {
			await repo.git('update-ref', `refs/heads/b-${String(i).padStart(2, '0')}`, commit);
		}
		await repo.git('update-ref', 'refs/heads/-rf', commit);
		await repo.git('update-ref', 'refs/heads/fix‮evil', commit);
		await repo.write('b.txt', 'b\n');
		await repo.commit('Later');
		await repo.git('branch', 'b-newest');
		const found = await located(repo, (await reviewer()).gitEnv);
		const branches = value(await readOnly(repo, () => listBranches(found, '')));
		expect(branches.shown).toHaveLength(BRANCHES_SHOWN);
		expect(branches.matching).toBe(BRANCHES_SHOWN + 14);
		expect(branches.main).toBe('refs/heads/main');
		expect(branches.shown.slice(0, 2).map((b) => b.ref)).toEqual([
			'refs/heads/main',
			'refs/heads/b-newest'
		]);
		const odd = value(await listBranches(found, 'rf'));
		expect(odd.shown.map((b) => b.ref)).toEqual(['refs/heads/-rf']);
		const page = value(
			await readOnly(repo, () =>
				listCommits(found, ref('refs/heads/-rf'), undefined, branches.main)
			)
		);
		expect(page.commits.map((c) => c.subject)).toEqual(['Start']);
		const hidden = value(await listBranches(found, 'evil'));
		expect(hidden.shown.map((b) => b.ref)).toEqual(['refs/heads/fix‮evil']);
	});
});

describe('a branch’s commits', () => {
	it('lists first parents newest first, each with its size, a merge against its first parent', async () => {
		const { repo } = await shop();
		const found = await located(repo, (await reviewer()).gitEnv);
		const main = ref('refs/remotes/origin/main');
		const page = value(
			await readOnly(repo, () => listCommits(found, ref('refs/heads/main'), undefined, main))
		);
		expect(
			page.commits.map((c) => [
				c.subject,
				c.merge,
				c.parent.kind,
				c.size?.files,
				c.size?.added,
				c.size?.removed,
				c.onMain
			])
		).toEqual([
			['Merge the side', true, 'commit', 1, 2, 0, true],
			['Shorten the basket', false, 'commit', 1, 0, 2, true],
			// The rename is one file, with its one new line; the binary file has no lines.
			['Rename the cart', false, 'commit', 2, 1, 0, true],
			['Start the shop', false, 'none', 1, 2, 0, true]
		]);
		expect(page.next).toBeUndefined();
		const first = page.commits[0];
		expect(first?.author).toBe('Fixture Author');
		expect(first?.committedAt).toBe(fixtureTime(6));
	});

	it('marks which of a branch’s commits are its own, and measures a run of them', async () => {
		const { repo } = await shop();
		const found = await located(repo, (await reviewer()).gitEnv);
		const main = ref('refs/remotes/origin/main');
		const page = value(await listCommits(found, ref('refs/heads/feature'), undefined, main));
		expect(page.commits.map((c) => [c.subject, c.onMain])).toEqual([
			['Make the sale big', false],
			['Add a sale', false],
			['Rename the cart', true],
			['Start the shop', true]
		]);
		const [newest, , , oldest] = page.commits;
		if (newest === undefined || oldest === undefined) throw new Error('missing commits');
		const run = value(await readOnly(repo, () => rangeSize(found, undefined, newest.commit)));
		expect(run).toEqual({ files: 3, added: 5, removed: 0 });
		const own = page.commits[2]?.commit;
		expect(value(await rangeSize(found, own, newest.commit))).toEqual({
			files: 1,
			added: 2,
			removed: 0
		});
	});

	it('comes a page at a time, each page starting where the last ended', async () => {
		const repo = await emptyRepo();
		const total = COMMITS_PER_PAGE + 7;
		for (let i = 0; i < total; i += 1) {
			await repo.write('n.txt', `${String(i)}\n`);
			await repo.commit(`Commit ${String(i)}`);
		}
		const found = await located(repo, (await reviewer()).gitEnv);
		const first = value(await listCommits(found, ref('refs/heads/main'), undefined, undefined));
		expect(first.commits).toHaveLength(COMMITS_PER_PAGE);
		expect(first.commits[0]?.subject).toBe(`Commit ${String(total - 1)}`);
		expect(first.commits.every((c) => !c.onMain)).toBe(true);
		const second = value(await listCommits(found, ref('refs/heads/main'), first.next, undefined));
		expect(second.commits.map((c) => c.subject)).toEqual(
			Array.from({ length: 7 }, (_, i) => `Commit ${String(6 - i)}`)
		);
		expect(second.next).toBeUndefined();
		expect(first.commits.at(-1)?.parent).toEqual({
			kind: 'commit',
			commit: second.commits[0]?.commit
		});

		// Compared with a branch at the first commit: a page says whether the next starts on it.
		await repo.git('branch', 'base', `main~${String(total - 1)}`);
		const base = ref('refs/heads/base');
		const own = value(await listCommits(found, ref('refs/heads/main'), undefined, base));
		expect(own.commits.every((c) => !c.onMain)).toBe(true);
		expect(own.next?.onMain).toBe(false);
		const rest = value(await listCommits(found, ref('refs/heads/main'), own.next, base));
		expect(rest.commits.map((c) => c.onMain)).toEqual([...Array<boolean>(6).fill(false), true]);

		// A branch with three commits of its own: the next page starts on the main branch,
		// and is listed as all on it without asking git again.
		await repo.git('checkout', '--quiet', '-b', 'feature');
		for (let i = 0; i < 3; i += 1) {
			await repo.write('f.txt', `${String(i)}\n`);
			await repo.commit(`Feature ${String(i)}`);
		}
		const main = ref('refs/heads/main');
		const top = value(await listCommits(found, ref('refs/heads/feature'), undefined, main));
		expect(top.commits.map((c) => c.onMain)).toEqual([
			...Array<boolean>(3).fill(false),
			...Array<boolean>(COMMITS_PER_PAGE - 3).fill(true)
		]);
		expect(top.next?.onMain).toBe(true);
		const below = value(await listCommits(found, ref('refs/heads/feature'), top.next, main));
		expect(below.commits).toHaveLength(10);
		expect(below.commits.every((c) => c.onMain)).toBe(true);
		const asked = value(
			await listCommits(
				found,
				ref('refs/heads/feature'),
				top.next === undefined ? undefined : { ...top.next, onMain: false },
				main
			)
		);
		expect(asked).toEqual(below);
	});

	it('lists a commit whose date git cannot read, between its neighbours, and the branch it is newest on', async () => {
		const repo = await emptyRepo();
		await repo.write('a.txt', 'a\n');
		const first = await repo.commit('Start');
		// A commit as another tool might write it: its committer line has no date.
		const tree = (await repo.git('rev-parse', `${first.commit}^{tree}`)).trim();
		const text = [
			`tree ${tree}`,
			`parent ${first.commit}`,
			'author Fixture Author <fixture@example.invalid> 1700000000 +0000',
			'committer Fixture Author <fixture@example.invalid> not-a-date +0000',
			'',
			'Written without a date',
			''
		].join('\n');
		const file = join(await tempDirectory(), 'commit.txt');
		await writeFile(file, text);
		const odd = (await repo.git('hash-object', '-t', 'commit', '-w', '--literally', file)).trim();
		await repo.git('update-ref', 'refs/heads/undated', odd);
		await repo.git('reset', '--quiet', '--hard', odd);
		await repo.write('a.txt', 'a\nb\n');
		await repo.commit('Later');
		const found = await located(repo, (await reviewer()).gitEnv);
		const page = value(await listCommits(found, ref('refs/heads/main'), undefined, undefined));
		expect(page.commits.map((c) => [c.subject, c.committedAt === undefined])).toEqual([
			['Later', false],
			['Written without a date', true],
			['Start', false]
		]);
		// Each row's parent is the row below it: no commit is hidden between two rows.
		expect(page.commits.map((c) => (c.parent.kind === 'commit' ? c.parent.commit : null))).toEqual([
			odd,
			first.commit,
			null
		]);
		const branches = value(await listBranches(found, ''));
		expect(branches.shown.map((b) => [branchName(b.ref), b.committedAt === undefined])).toEqual([
			['main', false],
			['undated', true]
		]);
	});

	it('says plainly when a branch is not there', async () => {
		const repo = await emptyRepo();
		await repo.commit('Start');
		const found = await located(repo, (await reviewer()).gitEnv);
		const missing = await listCommits(found, ref('refs/heads/nope'), undefined, undefined);
		expect(missing.ok ? 'listed' : missing.error.kind).toBe('UnknownRevision');
	});

	it('stops at a shallow clone’s edge, and lists a partial clone’s commits without their sizes', async () => {
		const source = await emptyRepo();
		for (let i = 0; i < 4; i += 1) {
			await source.write('n.txt', `${String(i)}\n`);
			await source.commit(`Commit ${String(i)}`);
		}
		const dir = absolutePath(join(await tempDirectory(), 'shallow'));
		await source.git('clone', '--quiet', '--depth=2', `file://${source.dir}`, dir);
		const who = await reviewer();
		const shallow = value(await locateRepository(dir, { gitEnv: who.gitEnv }));
		const page = value(await listCommits(shallow, ref('refs/heads/main'), undefined, undefined));
		expect(page.commits.map((c) => [c.subject, c.parent.kind, c.size === undefined])).toEqual([
			['Commit 3', 'commit', false],
			['Commit 2', 'not-downloaded', true]
		]);

		const { clone } = await partialClone('blob:none');
		const partial = await located(clone, who.gitEnv);
		const listed = value(
			await readOnly(clone, () =>
				listCommits(partial, ref('refs/heads/feat'), undefined, undefined)
			)
		);
		expect(listed.commits.map((c) => [c.subject, c.size])).toEqual([
			['rename and edit', undefined],
			['base', undefined]
		]);
	});
});

describe('when the repository last fetched', () => {
	it('says nothing with no remote, and that it never fetched when it has no record', async () => {
		const repo = await emptyRepo();
		await repo.commit('Start');
		const who = await reviewer();
		const found = await located(repo, who.gitEnv);
		expect(await lastFetch(found, [], undefined)).toEqual({ kind: 'no-remote' });
		await repo.git('remote', 'add', 'origin', join(repo.dir, 'nowhere'));
		const remotes = value(await remotesOf(found));
		expect(await readOnly(repo, () => lastFetch(found, remotes, undefined))).toEqual({
			kind: 'never',
			remotes: ['origin']
		});
	});

	it('reads the time of FETCH_HEAD, or of the last fetch in a remote branch’s reflog', async () => {
		const { repo } = await shop();
		const found = await located(repo, (await reviewer()).gitEnv);
		const remotes = value(await remotesOf(found));
		const main = ref('refs/remotes/origin/main');
		await rm(join(repo.dir, '.git', 'FETCH_HEAD'));
		// The fetch in the fixture was its git command after the sixth commit.
		expect(await readOnly(repo, () => lastFetch(found, remotes, main))).toEqual({
			kind: 'fetched',
			at: fixtureTime(6),
			remotes
		});
		await repo.git('fetch', '--quiet', 'origin');
		const later = new Date(fixtureTime(100));
		await utimes(join(repo.dir, '.git', 'FETCH_HEAD'), later, later);
		expect(await lastFetch(found, remotes, main)).toEqual({
			kind: 'fetched',
			at: fixtureTime(100),
			remotes
		});
	});
});
