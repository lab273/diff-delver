/**
 * The chooser's git calls at the size the design allows for: a repository of
 * 100,000 commits and 3,000 branches. Listing the branches, a page of commits
 * at the top or deep in the history, and the size of a run, should each take a
 * fraction of a second, because none reads the whole history. The times are
 * guidance, which `pnpm verify` reports when one is exceeded; a call that read
 * everything would still fail on the hang timeout.
 */
import { describe, expect, it } from 'vitest';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { parseBranchRef } from '#lib/core/history/branch-ref.tiny.ts';
import { measurementName } from '#lib/core/measurement-name.tiny.ts';
import { millisecondsOf } from '#lib/core/milliseconds.tiny.ts';
import { runGit } from '#lib/server/git/run-git.ts';
import { defineFixture, useFixture } from '../../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { recordTime } from '../../../../../tests/support/measured-time.ts';
import { reviewer } from '../../../../../tests/support/reviewer-git.ts';
import { now } from '../../../../../tests/support/stopwatch.ts';
import {
	BRANCHES_SHOWN,
	COMMITS_PER_PAGE,
	listBranches,
	listCommits,
	rangeSize
} from './history.ts';
import { locateRepository } from './index.ts';

const COMMITS = 100_000;
const BRANCHES = 3_000;

/** A fast-import stream: `COMMITS` on main, each changing one of 100 files, and `BRANCHES` one commit off it. */
function stream(): string {
	const parts: string[] = [];
	const data = (text: string): string => `data ${String(Buffer.byteLength(text))}\n${text}\n`;
	const who = (n: number): string =>
		`committer Fixture Author <fixture@example.invalid> ${String(1_600_000_000 + n * 60)} +0000\n`;
	for (let n = 1; n <= COMMITS; n += 1) {
		parts.push(
			`commit refs/heads/main\nmark :${String(n)}\n${who(n)}${data(`Commit ${String(n)}`)}${n > 1 ? `from :${String(n - 1)}\n` : ''}M 100644 inline f${String(n % 100)}.txt\n${data(`line ${String(n)}\n`)}`
		);
	}
	for (let b = 0; b < BRANCHES; b += 1) {
		const base = COMMITS - b * 30;
		parts.push(
			`commit refs/heads/branch-${String(b)}\n${who(COMMITS + b)}${data(`Branch ${String(b)}`)}from :${String(base)}\nM 100644 inline own-${String(b)}.txt\n${data('own\n')}`
		);
	}
	return parts.join('');
}

const large = defineFixture('large-history', async (repo) => {
	const imported = await runGit({
		cwd: repo.dir,
		args: ['fast-import', '--quiet'],
		input: stream()
	});
	if (!imported.ok) throw new Error(`fast-import failed: ${JSON.stringify(imported.error)}`);
});

describe('choosing commits in a large repository', () => {
	it('lists branches and pages of commits of 100,000 commits and 3,000 branches at once', async ({
		task
	}) => {
		const repo = await useFixture(large);
		const found = value(await locateRepository(repo.dir, { gitEnv: (await reviewer()).gitEnv }));
		const measure = async <T>(what: string, guidance: number, work: () => Promise<T>) => {
			const started = now();
			const result = await work();
			recordTime(
				task,
				measurementName(what),
				millisecondsOf(now() - started),
				millisecondsOf(guidance)
			);
			return result;
		};

		const branches = value(
			await measure('listing 3,000 branches', 1_500, () => listBranches(found, ''))
		);
		expect(branches.matching).toBe(BRANCHES + 1);
		expect(branches.shown).toHaveLength(BRANCHES_SHOWN);
		expect(branches.shown[0]?.ref).toBe('refs/heads/main');
		expect(branches.shown[1]?.ahead).toBe(1);
		const found2 = value(
			await measure('finding a branch by name', 1_500, () => listBranches(found, 'branch-2999'))
		);
		expect(found2.shown.map((b) => b.ref)).toEqual(['refs/heads/branch-2999']);

		const main = value(parseBranchRef('refs/heads/main'));
		const top = value(
			await measure('the first page of 100,000 commits', 1_000, () =>
				listCommits(found, main, undefined, main)
			)
		);
		expect(top.commits).toHaveLength(COMMITS_PER_PAGE);
		expect(top.commits[0]?.size).toEqual({ files: 1, added: 1, removed: 1 });

		// A page deep in the history, from a commit 90,000 down.
		const deep = await runGit({
			cwd: repo.dir,
			args: ['rev-parse', `main~${String(90_000)}`]
		});
		const deepCommit = value(
			parseCommitId(deep.ok ? deep.value.stdout.toString('utf8').trim() : '')
		);
		const later = value(
			await measure('a page 90,000 commits down', 1_000, () =>
				listCommits(found, main, deepCommit, main)
			)
		);
		expect(later.commits[0]?.subject).toBe(`Commit ${String(COMMITS - 90_000)}`);

		const newest = top.commits[0]?.commit;
		const oldest = top.commits.at(-1)?.parent;
		if (newest === undefined || oldest?.kind !== 'commit') throw new Error('no run to measure');
		const size = value(
			await measure('the size of a run of 50 commits', 1_000, () =>
				rangeSize(found, oldest.commit, newest)
			)
		);
		expect(size?.files).toBe(50);
	});
});
