import { describe, expect, it } from 'vitest';
import { parseCommitId, type CommitId } from '../commit-id.tiny.ts';
import { parseBranchRef, type BranchRef } from './branch-ref.tiny.ts';
import { parseRemoteName, type RemoteName } from './remote-name.tiny.ts';
import {
	classifyRemoteFailure,
	compareWithRemote,
	describeComparison,
	describeRemoteCheckError,
	hasNews
} from './remote-check.ts';

function id(n: number): CommitId {
	const parsed = parseCommitId(n.toString(16).padStart(40, '0'));
	if (!parsed.ok) throw new Error('not an id');
	return parsed.value;
}

function ref(name: string): BranchRef {
	const parsed = parseBranchRef(name);
	if (!parsed.ok) throw new Error(`not a branch: ${name}`);
	return parsed.value;
}

function remote(name: string): RemoteName {
	const parsed = parseRemoteName(name);
	if (!parsed.ok) throw new Error(`not a remote: ${name}`);
	return parsed.value;
}

const origin = remote('origin');

describe('comparing a remote with what this copy fetched', () => {
	it('finds branches that moved on and branches never fetched, ignoring other remotes', () => {
		const heads = new Map([
			['main', id(2)],
			['prices', id(5)],
			['docs', id(7)],
			['same', id(9)]
		]);
		const tracked = [
			{ ref: ref('refs/remotes/origin/main'), commit: id(1) },
			{ ref: ref('refs/remotes/origin/same'), commit: id(9) },
			{ ref: ref('refs/remotes/origin/gone'), commit: id(3) },
			{ ref: ref('refs/remotes/upstream/docs'), commit: id(7) }
		];
		const compared = compareWithRemote(origin, heads, tracked);
		expect(compared).toEqual({ remote: origin, changed: ['main'], added: ['docs', 'prices'] });
		expect(hasNews(compared)).toBe(true);
		expect(describeComparison(compared)).toBe(
			'origin has new commits on main that this copy has not fetched. It also has 2 branches this copy has never fetched: docs and prices.'
		);
	});

	it('says when there is nothing new, and names a few branches of many', () => {
		const same = compareWithRemote(origin, new Map([['main', id(1)]]), [
			{ ref: ref('refs/remotes/origin/main'), commit: id(1) }
		]);
		expect(hasNews(same)).toBe(false);
		expect(describeComparison(same)).toBe(
			'origin has nothing new: its branches are where this copy last fetched them.'
		);
		const many = { remote: origin, changed: [], added: ['a', 'b', 'c', 'd', 'e'] };
		expect(describeComparison(many)).toBe(
			'origin has 5 branches this copy has never fetched: a, b, c and 2 more.'
		);
	});

	it('tells why a remote could not be asked from what git and ssh say', () => {
		const kinds = [
			"fatal: could not read Username for 'https://example.invalid': terminal prompts disabled",
			'fatal: unable to get password from user',
			'git@example.invalid: Permission denied (publickey).\nfatal: Could not read from remote repository.',
			"fatal: '/nowhere' does not appear to be a git repository\nfatal: Could not read from remote repository.",
			'remote: Repository not found.',
			'ssh: Could not resolve hostname example.invalid: Name or service not known',
			"fatal: unable to access 'https://example.invalid/': Could not resolve host: example.invalid",
			'fatal: something else'
		].map((stderr) => classifyRemoteFailure(origin, stderr).kind);
		expect(kinds).toEqual([
			'RemoteNeedsLogin',
			'RemoteNeedsLogin',
			'RemoteNeedsLogin',
			'RemoteNotFound',
			'RemoteNotFound',
			'RemoteUnreachable',
			'RemoteUnreachable',
			'RemoteCheckFailed'
		]);
		expect(describeRemoteCheckError({ kind: 'RemoteTimedOut', remote: origin, seconds: 20 })).toBe(
			'origin did not answer within 20 seconds, so it was not checked. Check that you are online, then try again.'
		);
		expect(describeRemoteCheckError({ kind: 'RemoteNeedsLogin', remote: origin })).toContain(
			'Run "git fetch" in a terminal'
		);
	});
});
