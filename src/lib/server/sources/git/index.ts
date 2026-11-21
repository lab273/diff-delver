/**
 * Local git sources (DESIGN 3.1): a repository's working tree, its index, one
 * commit or a range, turned into snapshots in the store, with a cheap check for
 * change and a guess at what a person wants to review. Import them from here.
 *
 * ```ts
 * const repo = await locateRepository(directory);
 * const spec = parseGitSourceSpec('main...feature-x');      // from #lib/core/sources/git-source-spec.ts
 * const taken = await snapshotGitSource(dataDir, repo.value, spec.value);
 * const later = await sourceIdentity(repo.value, spec.value);
 * const changed = later.ok && later.value !== taken.value.identity;
 * ```
 */
export type { RemoteOutcome } from './check-remote.ts';
export { checkRemote, REMOTE_CHECK_SECONDS } from './check-remote.ts';
export { commitsSince } from './commits-since.ts';
export type {
	BranchSummary,
	Branches,
	CommitPage,
	CommitSize,
	CommitSummary,
	PageStart
} from './history.ts';
export {
	BRANCHES_SHOWN,
	COMMITS_PER_PAGE,
	lastFetch,
	listBranches,
	listCommits,
	rangeSize,
	remotesOf,
	trackedBranches
} from './history.ts';
export { headCommit } from './resolve.ts';
export type { LocalRepository, RepositoryOptions } from './local-repository.ts';
export { locateRepository, storeIdFor } from './local-repository.ts';
export type { GitSnapshot } from './snapshot-git-source.ts';
export { snapshotGitSource } from './snapshot-git-source.ts';
export { sourceHasChanges } from './source-has-changes.ts';
export { sourceIdentity } from './source-identity.ts';
export type { SourceCandidate, SourceSuggestion, SuggestedSource } from './suggest-source.ts';
export { candidateSourceText, mainBranch, suggestSource } from './suggest-source.ts';
export type {
	GitSourceError,
	NoCommitsYet,
	NoCommonHistory,
	NoWorkingTree,
	PartialCloneMissing,
	ShallowHistory,
	UnknownRevision,
	UnresolvedConflict
} from './git-source-error.ts';
export { describeGitSourceError } from './git-source-error.ts';
