import { describe, expect, it } from 'vitest';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';
import { parseBranchRef, type BranchRef } from './branch-ref.tiny.ts';
import { commitCountOf } from './commit-count.tiny.ts';
import {
	describeAhead,
	describeCheckButton,
	describeExactTime,
	describeForkPoint,
	describeLastCommit,
	describeLastFetch,
	describeWholeBranch
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

describe('the chooser’s words', () => {
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
		const main = branch('refs/remotes/origin/main');
		expect(describeAhead(commitCountOf(0), main)).toBe('No commits that origin/main lacks');
		expect(describeAhead(commitCountOf(1), main)).toBe('1 commit not on origin/main');
		expect(describeAhead(commitCountOf(1200), main)).toBe('1,200 commits not on origin/main');
		expect(describeWholeBranch(main, commitCountOf(3))).toBe(
			'Review the whole branch: 3 commits, compared with origin/main'
		);
		expect(describeForkPoint(branch('refs/heads/discounts'), branch('refs/heads/main'))).toBe(
			'discounts started from main here: the commits below are on main too.'
		);
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
		).toBe('Last fetched from its 2 remotes just now (15 January 2026, 09:30 UTC).');
		expect(describeCheckButton(origin)).toBe('Check origin for new commits');
		expect(describeCheckButton([remote('a'), remote('b')])).toBe(
			'Check the remotes for new commits'
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
