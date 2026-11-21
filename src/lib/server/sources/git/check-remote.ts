/**
 * Asking a remote which commits its branches are at, to tell whether this
 * copy is out of date (DESIGN 3.1). Only when a person asks: it is the one
 * network call diff delver makes for a local repository.
 *
 * `git ls-remote`, never `git fetch`, since a fetch writes to the repository.
 * It never asks for anything and never waits on a question: no terminal
 * prompt, an askpass that refuses, a credential manager told not to ask, ssh
 * in batch mode with a time limit to connect, git in a session of its own
 * with no terminal at all, and the whole command stopped after a time limit.
 */
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { firstLineOf } from '#lib/core/git-stderr.tiny.ts';
import {
	classifyRemoteFailure,
	compareWithRemote,
	type RemoteCheckError,
	type RemoteComparison,
	type TrackedBranch
} from '#lib/core/history/remote-check.ts';
import type { RemoteName } from '#lib/core/history/remote-name.tiny.ts';
import { describeGitError } from '../../git/run-git.ts';
import { gitCwd, gitIn, type LocalRepository } from './local-repository.ts';

/** How long a remote has to answer, in seconds. */
export const REMOTE_CHECK_SECONDS = 20;

/** What asking one remote found. */
export type RemoteOutcome =
	| { readonly kind: 'compared'; readonly comparison: RemoteComparison }
	| { readonly kind: 'failed'; readonly error: RemoteCheckError };

/** The ssh command git would use, made unable to ask anything: batch mode, and a time limit to connect. */
async function batchSsh(repo: LocalRepository): Promise<string> {
	const configured = await gitIn(repo, gitCwd(repo), ['config', '--get', 'core.sshCommand']);
	const command = configured.ok ? configured.value.stdout.toString('utf8').trim() : '';
	const program = command.split(/\s+/)[0] ?? '';
	if (command !== '' && !/(?:^|\/)ssh(?:\.exe)?$/.test(program)) {
		// Not OpenSSH, so its options are unknown: it still has no terminal to ask on.
		return command;
	}
	return `${command === '' ? 'ssh' : command} -o BatchMode=yes -o ConnectTimeout=10`;
}

/** Each branch the remote has and the commit it is at, by its name there, such as `main`. */
function readHeads(stdout: Buffer): ReadonlyMap<string, CommitId> {
	const heads = new Map<string, CommitId>();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	for (const line of stdout.toString('latin1').split('\n')) {
		const tab = line.indexOf('\t');
		const commit = parseCommitId(line.slice(0, tab));
		const ref = line.slice(tab + 1);
		if (tab < 0 || !commit.ok || !ref.startsWith('refs/heads/')) continue;
		let name: string;
		try {
			name = decoder.decode(Buffer.from(ref.slice('refs/heads/'.length), 'latin1'));
		} catch {
			continue;
		}
		heads.set(name, commit.value);
	}
	return heads;
}

/**
 * Asks `remote` which commits its branches are at, and compares them with this
 * copy's remote-tracking branches of it. Gives up after `seconds`.
 */
export async function checkRemote(
	repo: LocalRepository,
	remote: RemoteName,
	tracked: readonly TrackedBranch[],
	seconds: number = REMOTE_CHECK_SECONDS
): Promise<RemoteOutcome> {
	const limit = new AbortController();
	const timer = setTimeout(() => {
		limit.abort();
	}, seconds * 1000);
	const asked = await gitIn(
		repo,
		gitCwd(repo),
		['-c', 'credential.interactive=false', 'ls-remote', '--heads', '--end-of-options', remote],
		{
			env: {
				GIT_TERMINAL_PROMPT: '0',
				GIT_ASKPASS: 'false',
				SSH_ASKPASS: 'false',
				SSH_ASKPASS_REQUIRE: 'never',
				GCM_INTERACTIVE: 'never',
				GIT_SSH_COMMAND: await batchSsh(repo)
			},
			stopWhen: limit.signal
		}
	).finally(() => {
		clearTimeout(timer);
	});
	if (limit.signal.aborted) {
		return { kind: 'failed', error: { kind: 'RemoteTimedOut', remote, seconds } };
	}
	if (!asked.ok) {
		const error = asked.error;
		switch (error.kind) {
			case 'GitFailed':
			case 'BadRevision':
			case 'MissingObject':
			case 'NotARepository':
				return { kind: 'failed', error: classifyRemoteFailure(remote, error.stderr) };
			case 'DubiousOwnership':
				return {
					kind: 'failed',
					error: { kind: 'RemoteCheckFailed', remote, detail: firstLineOf(error.stderr) }
				};
			case 'GitNotFound':
			case 'GitTooOld':
			case 'NoSuchDirectory':
				return {
					kind: 'failed',
					error: { kind: 'RemoteCheckFailed', remote, detail: describeGitError(error) }
				};
		}
	}
	return {
		kind: 'compared',
		comparison: compareWithRemote(remote, readHeads(asked.value.stdout), tracked)
	};
}
