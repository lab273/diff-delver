import { describe, expect, it } from 'vitest';
import { fileCountOf } from '../file-count.tiny.ts';
import { lineCountOf } from '../line-count.tiny.ts';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';
import { parseBranchRef, type BranchRef } from './branch-ref.tiny.ts';
import { commitCountOf } from './commit-count.tiny.ts';
import {
	describeAhead,
	describeAsking,
	describeBranchPlace,
	describeCheckButton,
	describeCommitFiles,
	describeExactTime,
	describeForkPoint,
	describeLastCommit,
	describeLastFetch,
	describeNoBranches,
	describeNothingAhead,
	describeWholeBranch,
	shownBranch
} from './history-words.ts';
import { parseRemoteName, type RemoteName } from './remote-name.tiny.ts';

/** A time in UTC, from its parts as written: 2026-01-05 07:03. */
function time(iso: string): Timestamp {
	const [y = 0, mo = 1, d = 1, h = 0, mi = 0] = (iso.match(/\d+/g) ?? []).map(Number);
	const parsed = parseTimestamp(Date.UTC(y, mo - 1, d, h, mi));
	if (!parsed.ok) throw new Error('not a time');
	return parsed.value;
}

function branch(name: string): BranchRef {
	const parsed = parseBranchRef(name);
	if (!parsed.ok) throw new Error(`not a branch: ${name}`);
	return parsed.value;
}

function remote(name: string): RemoteName {
	const parsed = parseRemoteName(name);
	if (!parsed.ok) throw new Error(`not a remote: ${name}`);
	return parsed.value;
}

describe('the choose page’s words', () => {
	it('says a moment exactly, in UTC', () => {
		expect(describeExactTime(time('2026-01-05T07:03:00Z'))).toBe('5 January 2026, 07:03 UTC');
		expect(describeExactTime(time('2025-12-31T23:59:00Z'))).toBe('31 December 2025, 23:59 UTC');
	});

	it('says when a branch’s newest commit was made, or that its time is unknown', () => {
		const now = time('2026-01-15T09:30:00Z');
		expect(describeLastCommit(time('2026-01-12T09:30:00Z'), now)).toBe('last commit 3 days ago');
		expect(describeLastCommit(undefined, now)).toBe('last commit at an unknown time');
	});

	it('says how far a branch has gone from the main branch, and what reviewing it opens', () => {
		const origin = [remote('origin')];
		const main = branch('refs/remotes/origin/main');
		expect(describeAhead(commitCountOf(0), main, origin)).toBe('No commits that origin/main lacks');
		expect(describeAhead(commitCountOf(1), main, origin)).toBe('1 commit not on origin/main');
		expect(describeNothingAhead(branch('refs/heads/main'), main, origin)).toBe(
			'main has no commits that origin/main lacks: every commit below is on origin/main too. Tick commits to review them.'
		);
		expect(describeAhead(commitCountOf(1200), main, origin)).toBe(
			'1,200 commits not on origin/main'
		);
		expect(describeWholeBranch(main, commitCountOf(3), origin)).toBe(
			'Review the whole branch: 3 commits, compared with origin/main'
		);
		expect(
			describeForkPoint(branch('refs/heads/discounts'), branch('refs/heads/main'), origin)
		).toBe('discounts started from main here: the commits below are on main too.');
	});

	it('tells apart branches whose names read the same', () => {
		const remotes = [remote('origin'), remote('team/shared')];
		const tracked = branch('refs/remotes/origin/main');
		const lookAlike = branch('refs/heads/origin/main');
		// Both are "origin/main" as people say them: a tag says which is which.
		expect(describeBranchPlace(tracked, remotes)).toBe('On origin');
		expect(describeBranchPlace(lookAlike, remotes)).toBe('Local branch');
		expect(describeBranchPlace(branch('refs/heads/feature/x'), remotes)).toBeUndefined();
		expect(describeBranchPlace(branch('refs/remotes/team/shared/x'), remotes)).toBe(
			'On team/shared'
		);
		expect(describeBranchPlace(branch('refs/remotes/gone/x'), remotes)).toBe('Remote branch');
		expect(shownBranch(tracked, remotes)).toBe('origin/main');
		expect(shownBranch(lookAlike, remotes)).toBe('the local branch origin/main');
		expect(describeAhead(commitCountOf(2), lookAlike, remotes)).toBe(
			'2 commits not on the local branch origin/main'
		);
		expect(describeForkPoint(lookAlike, tracked, remotes)).toBe(
			'The local branch origin/main started from origin/main here: the commits below are on origin/main too.'
		);
	});

	it('never names a local branch called HEAD as if it were the checked-out commit', () => {
		const head = branch('refs/heads/HEAD');
		expect(describeBranchPlace(head, [])).toBe('Local branch');
		expect(shownBranch(head, [])).toBe('the local branch HEAD');
		expect(describeNothingAhead(head, branch('refs/heads/main'), [])).toBe(
			'The local branch HEAD has no commits that main lacks: every commit below is on main too. Tick commits to review them.'
		);
		expect(shownBranch(branch('refs/heads/staged'), [])).toBe('the local branch staged');
		expect(shownBranch(branch('refs/remotes/origin/HEAD'), [remote('origin')])).toBe('origin/HEAD');
	});

	it('says when the repository last fetched, and nothing when it has no remote', () => {
		const now = time('2026-01-15T09:30:00Z');
		const origin = [remote('origin')];
		expect(describeLastFetch({ kind: 'no-remote' }, now)).toBeUndefined();
		expect(describeLastFetch({ kind: 'never', remotes: origin }, now)).toBe(
			'This copy has no record of fetching from origin, so it may lack commits made there.'
		);
		expect(
			describeLastFetch({ kind: 'fetched', at: time('2026-01-12T10:00:00Z'), remotes: origin }, now)
		).toBe('Last fetched from origin 2 days ago (12 January 2026, 10:00 UTC).');
		expect(
			describeLastFetch(
				{ kind: 'fetched', at: now, remotes: [remote('origin'), remote('upstream')] },
				now
			)
		).toBe('Last fetched from one of its 2 remotes just now (15 January 2026, 09:30 UTC).');
		expect(
			describeLastFetch({ kind: 'never', remotes: [remote('origin'), remote('upstream')] }, now)
		).toBe(
			'This copy has no record of fetching from its 2 remotes, so it may lack commits made there.'
		);
		expect(describeCheckButton(origin)).toBe('Check origin for new commits');
		expect(describeCheckButton([remote('a'), remote('b')])).toBe(
			'Check the remotes for new commits'
		);
	});

	it('names a remote it is asking with what cannot be seen written out', () => {
		expect(describeAsking([remote('origin')])).toBe('Asking origin…');
		expect(describeAsking([remote('ori\u202egin')])).toBe('Asking ori\\u202Egin…');
		expect(describeAsking([remote('a'), remote('b')])).toBe('Asking the remotes…');
	});

	it('says a commit with no lines to count changes no lines', () => {
		const files = (n: number) => fileCountOf(n);
		const lines = (n: number) => lineCountOf(n);
		expect(describeCommitFiles(files(3), lines(4), lines(0))).toBe('3 files');
		expect(describeCommitFiles(files(1), lines(0), lines(2))).toBe('1 file');
		// A rename alone, or a change to a binary file.
		expect(describeCommitFiles(files(1), lines(0), lines(0))).toBe('1 file, no lines changed');
		expect(describeCommitFiles(files(1200), lines(0), lines(0))).toBe(
			'1,200 files, no lines changed'
		);
		expect(describeCommitFiles(files(0), lines(0), lines(0))).toBe('No files changed');
	});

	it('says what to do when a repository has nothing to choose from', () => {
		expect(describeNoBranches(true)).toBe(
			'This repository has no commits yet, so there is nothing to choose from. Make a first commit, then reload this page.'
		);
		expect(describeNoBranches(false)).toMatch(
			/^This repository has no branches, .* run diff-delver open HEAD in a terminal/
		);
	});
});

describe('branch and remote names', () => {
	it('accepts full branch names and refuses what git would read otherwise', () => {
		for (const name of [
			'refs/heads/main',
			'refs/heads/a/b',
			'refs/remotes/origin/x',
			'refs/heads/café'
		]) {
			expect(parseBranchRef(name).ok).toBe(true);
		}
		for (const name of [
			'main',
			'-main',
			'refs/heads/',
			'refs/tags/v1',
			'refs/heads/a..b',
			'refs/heads/a b',
			'refs/heads/a\u0007',
			'refs/heads/a^',
			'refs/heads/x.lock',
			'refs/heads/a@{1}'
		]) {
			expect(parseBranchRef(name).ok, name).toBe(false);
		}
		expect(parseRemoteName('origin').ok).toBe(true);
		for (const name of ['', '-o', 'a b', 'a..b'])
			expect(parseRemoteName(name).ok, name).toBe(false);
	});
});
