/**
 * Whether a remote has moved on from this copy (DESIGN 3.1): what the remote's
 * branches point at, as `git ls-remote` tells it, compared with the copy's
 * remote-tracking branches, which are what it last fetched. Only a person's
 * press of a button asks the remote; nothing here touches the network.
 */
import type { CommitId } from '../commit-id.tiny.ts';
import { visibleText } from '../hidden-characters.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { formatCount } from '../viewer/words.ts';
import type { BranchRef } from './branch-ref.tiny.ts';
import type { RemoteName } from './remote-name.tiny.ts';

/** A remote-tracking branch of this copy and the commit it is at. */
export interface TrackedBranch {
	readonly ref: BranchRef;
	readonly commit: CommitId;
}

/** What one remote has that this copy has not fetched, by the remote's branch names. */
export interface RemoteComparison {
	readonly remote: RemoteName;
	/** Branches whose commit on the remote is not the one this copy last fetched. */
	readonly changed: readonly string[];
	/** Branches on the remote that this copy has never fetched. */
	readonly added: readonly string[];
}

/**
 * Compares a remote's branches (`heads`: each branch's name on the remote, such
 * as `main`, and its commit there) with this copy's remote-tracking branches of
 * it, `refs/remotes/<remote>/<name>`. Names come sorted.
 */
export function compareWithRemote(
	remote: RemoteName,
	heads: ReadonlyMap<string, CommitId>,
	tracked: readonly TrackedBranch[]
): RemoteComparison {
	const prefix = `refs/remotes/${remote}/`;
	const local = new Map<string, CommitId>();
	for (const branch of tracked) {
		if (branch.ref.startsWith(prefix)) local.set(branch.ref.slice(prefix.length), branch.commit);
	}
	const changed: string[] = [];
	const added: string[] = [];
	for (const [name, commit] of heads) {
		const fetched = local.get(name);
		if (fetched === undefined) added.push(name);
		else if (fetched !== commit) changed.push(name);
	}
	const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	return { remote, changed: changed.toSorted(byName), added: added.toSorted(byName) };
}

/** Why a remote could not be asked. */
export type RemoteCheckError =
	/** The remote could not be reached: offline, or its address is wrong. */
	| { readonly kind: 'RemoteUnreachable'; readonly remote: RemoteName; readonly detail: string }
	/** The remote wants a login or a key that diff delver does not ask for. */
	| { readonly kind: 'RemoteNeedsLogin'; readonly remote: RemoteName }
	/** The remote's address names no repository, or one this account cannot see. */
	| { readonly kind: 'RemoteNotFound'; readonly remote: RemoteName }
	/** The remote did not answer within the time limit. */
	| { readonly kind: 'RemoteTimedOut'; readonly remote: RemoteName; readonly seconds: number }
	| { readonly kind: 'RemoteCheckFailed'; readonly remote: RemoteName; readonly detail: string };

const NEEDS_LOGIN =
	/authentication failed|could not read (?:username|password)|unable to get (?:username|password)|terminal prompts disabled|permission denied|host key verification failed|invalid credentials|\b40[13]\b/i;
const NOT_FOUND = /repository not found|does not appear to be a git repository|not found|\b404\b/i;
const UNREACHABLE =
	/could not resolve host|could not resolve hostname|connection refused|network is unreachable|connection timed out|operation timed out|no route to host|failed to connect|unable to access|could not read from remote repository|name or service not known|temporary failure in name resolution/i;

/** What git's error output says went wrong, from the words git and ssh use. */
export function classifyRemoteFailure(remote: RemoteName, stderr: string): RemoteCheckError {
	const detail =
		stderr
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line !== '') ?? 'git gave no reason';
	if (NEEDS_LOGIN.test(stderr)) return { kind: 'RemoteNeedsLogin', remote };
	if (NOT_FOUND.test(stderr)) return { kind: 'RemoteNotFound', remote };
	if (UNREACHABLE.test(stderr)) return { kind: 'RemoteUnreachable', remote, detail };
	return { kind: 'RemoteCheckFailed', remote, detail };
}

/** "main", "main and prices", "main, prices and 3 more". */
export function listOfBranches(names: readonly string[]): string {
	const NAMED = 3;
	const shown = names.slice(0, NAMED).map(visibleText);
	const more = names.length - shown.length;
	if (more > 0) shown.push(`${formatCount(more)} more`);
	const last = shown.pop() ?? '';
	return shown.length === 0 ? last : `${shown.join(', ')} and ${last}`;
}

/** What a remote has that this copy lacks, in a sentence or two. */
export function describeComparison(comparison: RemoteComparison): ReviewerMessage {
	const remote = visibleText(comparison.remote);
	const { changed, added } = comparison;
	if (changed.length === 0 && added.length === 0) {
		return reviewerMessage(
			`${remote} has nothing new: its branches are where this copy last fetched them.`
		);
	}
	const sentences: string[] = [];
	if (changed.length > 0) {
		sentences.push(
			`${remote} has new commits on ${listOfBranches(changed)} that this copy has not fetched.`
		);
	}
	if (added.length > 0) {
		const branches = added.length === 1 ? 'a branch' : `${formatCount(added.length)} branches`;
		sentences.push(
			`${changed.length > 0 ? 'It also has' : `${remote} has`} ${branches} this copy has never fetched: ${listOfBranches(added)}.`
		);
	}
	return reviewerMessage(sentences.join(' '));
}

/** Whether a comparison found anything to fetch. */
export function hasNews(comparison: RemoteComparison): boolean {
	return comparison.changed.length > 0 || comparison.added.length > 0;
}

/** What happened and what to do next, for the reviewer. */
export function describeRemoteCheckError(error: RemoteCheckError): ReviewerMessage {
	const remote = visibleText(error.remote);
	switch (error.kind) {
		case 'RemoteUnreachable':
			return reviewerMessage(
				`${remote} could not be reached (${error.detail}). Check that you are online and that "git remote -v" shows the right address, then try again.`
			);
		case 'RemoteNeedsLogin':
			return reviewerMessage(
				`${remote} needs a login or a key that diff delver does not ask for, so it could not be checked. Run "git fetch" in a terminal, which can ask you, to bring this copy up to date.`
			);
		case 'RemoteNotFound':
			return reviewerMessage(
				`${remote} has no repository at its address, or none this account can see. Check the address with "git remote -v".`
			);
		case 'RemoteTimedOut':
			return reviewerMessage(
				`${remote} did not answer within ${String(error.seconds)} seconds, so it was not checked. Check that you are online, then try again.`
			);
		case 'RemoteCheckFailed':
			return reviewerMessage(
				`${remote} could not be checked: ${error.detail} Check that "git ls-remote ${remote}" works in a terminal, then try again.`
			);
	}
}
