/**
 * What can go wrong turning a local git source into a snapshot, and what the
 * reviewer is told: what happened and what to do next.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { Revision } from '#lib/core/revision.tiny.ts';
import { describeStoreError, type StoreError } from '../../store/index.ts';

/** The source needs a working tree, and the repository has none here. */
export interface NoWorkingTree {
	readonly kind: 'NoWorkingTree';
	readonly repository: AbsolutePath;
	readonly source: 'working-tree' | 'staged';
}

/** git does not know the revision in this repository. */
export interface UnknownRevision {
	readonly kind: 'UnknownRevision';
	readonly repository: AbsolutePath;
	readonly revision: Revision;
}

/** The repository has no commits yet, so the revision cannot name one. */
export interface NoCommitsYet {
	readonly kind: 'NoCommitsYet';
	readonly repository: AbsolutePath;
	readonly revision: Revision;
}

/** A shallow clone stops before the commit that is needed: a commit's parent, or a merge base. */
export interface ShallowHistory {
	readonly kind: 'ShallowHistory';
	readonly repository: AbsolutePath;
	/** The commit whose history was not downloaded. */
	readonly commit: CommitId;
}

/** The two ends of a range share no history, so there is no merge base to compare against. */
export interface NoCommonHistory {
	readonly kind: 'NoCommonHistory';
	readonly repository: AbsolutePath;
	readonly from: Revision;
	readonly to: Revision;
}

/** A partial clone lacks files or folders the snapshot needs, and diff delver does not download them. */
export interface PartialCloneMissing {
	readonly kind: 'PartialCloneMissing';
	readonly repository: AbsolutePath;
}

/** The index holds a merge conflict, so there is no staged version of the conflicted files. */
export interface UnresolvedConflict {
	readonly kind: 'UnresolvedConflict';
	readonly repository: AbsolutePath;
	/** The conflicted files, sorted; never empty. */
	readonly paths: readonly RepoPath[];
}

export type GitSourceError =
	| StoreError
	| UnresolvedConflict
	| NoWorkingTree
	| UnknownRevision
	| NoCommitsYet
	| ShallowHistory
	| NoCommonHistory
	| PartialCloneMissing;

/** How many conflicted files a message names before it counts the rest. */
const NAMED_CONFLICTS = 3;

/** "a", "a and b", "a, b and c", "a, b, c and 2 more files". */
function listOfPaths(paths: readonly RepoPath[]): string {
	const named: string[] = paths.slice(0, NAMED_CONFLICTS).map(escapedRepoPath);
	const more = paths.length - named.length;
	if (more > 0) named.push(more === 1 ? '1 more file' : `${String(more)} more files`);
	const last = named.pop() ?? '';
	return named.length === 0 ? last : `${named.join(', ')} and ${last}`;
}

/** What happened and what to do next, for the reviewer. */
export function describeGitSourceError(error: GitSourceError): ReviewerMessage {
	switch (error.kind) {
		case 'UnresolvedConflict': {
			const one = error.paths.length === 1;
			return reviewerMessage(
				`${listOfPaths(error.paths)} ${one ? 'has an unresolved conflict' : 'have unresolved conflicts'}, so there is no staged version of ${one ? 'it' : 'them'} yet. Resolve the ${one ? 'conflict' : 'conflicts'} and stage the result with "git add", or review the uncommitted changes instead.`
			);
		}
		case 'NoWorkingTree':
			return reviewerMessage(
				`${error.repository} has no working tree: it is a bare repository, or you are inside its .git folder, so there are no ${error.source === 'staged' ? 'staged' : 'uncommitted'} changes to review. Open a commit or two branches to compare instead, or run diff delver in a checkout of it.`
			);
		case 'UnknownRevision':
			return reviewerMessage(
				`git does not know "${error.revision}" in ${error.repository}. Check the name (git branch --all lists branches), or fetch it first, then try again.`
			);
		case 'NoCommitsYet':
			return reviewerMessage(
				`${error.repository} has no commits yet, so "${error.revision}" names nothing. Review the uncommitted changes instead, or make a first commit.`
			);
		case 'ShallowHistory':
			return reviewerMessage(
				`${error.repository} is a shallow clone, and the history before commit ${error.commit.slice(0, 7)} was not downloaded, so there is nothing to compare it with. Download more history with "git fetch --deepen=50" (or "git fetch --unshallow" for all of it), then try again.`
			);
		case 'NoCommonHistory':
			return reviewerMessage(
				`"${error.from}" and "${error.to}" share no history in ${error.repository}, so there is no common starting point to compare from. Check that these are the two branches you meant.`
			);
		case 'PartialCloneMissing':
			return reviewerMessage(
				`${error.repository} is a partial clone: some of the files or folders this needs were never downloaded, and diff delver does not download them, so that nothing is written to your repository. Review its uncommitted changes instead, or make a full clone (git clone without --filter) and open the same source there.`
			);
		case 'GitNotFound':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'MissingObject':
		case 'GitFailed':
		case 'DataDirectoryUnusable':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'StoreDamaged':
			return describeStoreError(error);
	}
}
