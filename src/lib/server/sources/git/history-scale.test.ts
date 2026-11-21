/**
 * What the page that chooses commits asks of the report service, at the size
 * the design allows for: a repository of 100,000 commits and 3,000 branches.
 * Listing the branches, a page of commits at the top or deep in the history,
 * of the main branch or of another, and the size of a run, should each take a
 * fraction of a second, because none reads the whole history, and only the
 * list of branches measures every branch. The times are guidance, which `pnpm
 * verify` reports when one is exceeded; a call that read everything would
 * still fail on the hang timeout.
 */
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseBranchRef } from '#lib/core/history/branch-ref.tiny.ts';
import { measurementName } from '#lib/core/measurement-name.tiny.ts';
import { millisecondsOf } from '#lib/core/milliseconds.tiny.ts';
import { runGit } from '#lib/server/git/run-git.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { recordTime } from '../../../../../tests/support/measured-time.ts';
import { at } from '../../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../../tests/support/reviewer-git.ts';
import { now } from '../../../../../tests/support/stopwatch.ts';
import { ReportService } from '../../reports/index.ts';
import { BRANCHES_SHOWN, COMMITS_PER_PAGE } from './history.ts';

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
		const service = value(
			await ReportService.open({
				dataDirectory: await tempDirectory(),
				clock: settableClock(at(0)),
				ids: sequentialIds(''),
				repository: { gitEnv: (await reviewer()).gitEnv }
			})
		);
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

		const { branches } = value(
			await measure('listing 3,000 branches', 1_500, () => service.branches(repo.dir, ''))
		);
		expect(branches.matching).toBe(BRANCHES + 1);
		expect(branches.shown).toHaveLength(BRANCHES_SHOWN);
		expect(branches.shown[0]?.ref).toBe('refs/heads/main');
		expect(branches.shown[1]?.ahead).toBe(1);
		const found = value(
			await measure('finding a branch by name', 1_500, () =>
				service.branches(repo.dir, 'branch-2999')
			)
		);
		expect(found.branches.shown.map((b) => b.ref)).toEqual(['refs/heads/branch-2999']);

		// A page of commits finds the main branch alone: it measures no other branch.
		const main = value(parseBranchRef('refs/heads/main'));
		const top = value(
			await measure('the first page of 100,000 commits', 300, () =>
				service.commits(repo.dir, main, undefined)
			)
		);
		expect(top.commits).toHaveLength(COMMITS_PER_PAGE);
		expect(top.commits[0]?.size).toEqual({ files: 1, added: 1, removed: 1 });
		expect(top.next?.onMain).toBe(true);

		// A page deep in the history, from a commit 90,000 down.
		const deep = await runGit({
			cwd: repo.dir,
			args: ['rev-parse', `main~${String(90_000)}`]
		});
		const deepCommit = value(
			parseCommitId(deep.ok ? deep.value.stdout.toString('utf8').trim() : '')
		);
		const later = value(
			await measure('a page 90,000 commits down', 300, () =>
				service.commits(repo.dir, main, { commit: deepCommit, onMain: true })
			)
		);
		expect(later.commits[0]?.subject).toBe(`Commit ${String(COMMITS - 90_000)}`);

		// Another branch: its first page finds where it left the main branch, and
		// says the next page starts on the main branch, so a page deep down, which
		// the page asks for with that, never walks the main branch down to it.
		const other = value(parseBranchRef('refs/heads/branch-0'));
		const own = value(
			await measure('the first page of another branch', 300, () =>
				service.commits(repo.dir, other, undefined)
			)
		);
		expect(own.commits.map((c) => c.onMain).slice(0, 3)).toEqual([false, true, true]);
		expect(own.next?.onMain).toBe(true);
		const below = value(
			await measure('a page 90,000 commits down another branch', 300, () =>
				service.commits(repo.dir, other, { commit: deepCommit, onMain: true })
			)
		);
		expect(below.commits).toEqual(later.commits);

		// A branch that left the main branch 90,000 commits ago: git walks the main
		// branch down to there to tell which commits are the branch's own, once,
		// for its first page.
		const old = value(parseBranchRef(`refs/heads/branch-${String(BRANCHES - 1)}`));
		const stale = value(
			await measure('the first page of a branch 90,000 commits behind', 1_000, () =>
				service.commits(repo.dir, old, undefined)
			)
		);
		expect(stale.commits.map((c) => c.onMain).slice(0, 3)).toEqual([false, true, true]);

		const newest = top.commits[0]?.commit;
		const oldest = top.commits.at(-1)?.parent;
		if (newest === undefined || oldest?.kind !== 'commit') throw new Error('no run to measure');
		const size = value(
			await measure('the size of a run of 50 commits', 1_000, () =>
				service.runSize(repo.dir, oldest.commit, newest)
			)
		);
		expect(size?.files).toBe(50);
		service.close();
	});
});
