/**
 * Where a branch is kept, so that two branches whose names read the same can
 * be told apart: `refs/heads/origin/main`, a local branch somebody named like
 * a remote's, and `refs/remotes/origin/main`, this copy's record of the
 * remote's `main`, are both "origin/main" as people say them.
 */
import { branchName, isRemoteBranch, type BranchRef } from './branch-ref.tiny.ts';
import type { RemoteName } from './remote-name.tiny.ts';

export type BranchPlace =
	/** In this copy. `looksRemote`: its name starts with a remote's name and a slash, as a remote's branches are named. */
	| { readonly kind: 'local'; readonly looksRemote: boolean }
	/**
	 * This copy's record of a remote's branch, as the last fetch left it, with
	 * the branch's name on that remote; both undefined when the repository has
	 * no remote the name starts with.
	 */
	| {
			readonly kind: 'remote';
			readonly remote: RemoteName | undefined;
			readonly nameThere: string | undefined;
	  };

/** Where `branch` is kept, in a repository with these remotes. */
export function branchPlace(branch: BranchRef, remotes: readonly RemoteName[]): BranchPlace {
	const name = branchName(branch);
	if (!isRemoteBranch(branch)) {
		return { kind: 'local', looksRemote: remotes.some((remote) => name.startsWith(`${remote}/`)) };
	}
	// The longest remote name that fits, since a remote's name may hold a slash.
	const remote = remotes
		.filter((r) => name.startsWith(`${r}/`))
		.toSorted((a, b) => b.length - a.length)[0];
	return {
		kind: 'remote',
		remote,
		nameThere: remote === undefined ? undefined : name.slice(remote.length + 1)
	};
}
