/**
 * What makes two sources the same source, so that opening it again resumes its
 * open report (DESIGN 6.1). For a local git repository:
 *
 * | Source | The same source when |
 * |---|---|
 * | working tree, staged | the same repository and the same worktree |
 * | commit, range | the same repository and the same revisions as written, such as `main...feature-x` |
 *
 * The repository is its store, which `locateRepository` names by the common git
 * directory, so a subdirectory, a symbolic link or a linked worktree of one
 * repository is the same repository. A revision that depends on the worktree it
 * is read in, such as `HEAD`, `HEAD~2`, `@` or `ORIG_HEAD`, means different
 * commits in two worktrees, so a commit or range that names one is also tied to
 * the worktree. Revisions are compared as written: `main...feature` and
 * `main...refs/heads/feature` are different sources.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import { parseReportIdentity, type ReportIdentity } from '../report-identity.tiny.ts';
import type { Revision } from '../revision.tiny.ts';
import { formatGitSourceSpec, type GitSourceSpec } from '../sources/git-source-spec.ts';
import type { StoreId } from '../store-id.tiny.ts';

/** A local git source, and where it was opened. */
export interface GitSourceAt {
	/** The repository's store. */
	readonly store: StoreId;
	readonly spec: GitSourceSpec;
	/** The worktree it was opened in: its top folder, or its git directory when it has none. */
	readonly worktree: AbsolutePath;
}

/** Whether a revision means something different in each worktree. */
export function dependsOnWorktree(revision: Revision): boolean {
	// Every pseudo-ref (HEAD, ORIG_HEAD, MERGE_HEAD, ...) is per worktree, and `@` is HEAD.
	return revision.includes('HEAD') || revision.startsWith('@') || revision.includes('@{');
}

function tiedToWorktree(spec: GitSourceSpec): boolean {
	switch (spec.kind) {
		case 'working-tree':
		case 'staged':
			return true;
		case 'commit':
			return dependsOnWorktree(spec.revision);
		case 'range':
			return dependsOnWorktree(spec.from) || dependsOnWorktree(spec.to);
	}
}

/** The identity of a local git source. */
export function gitReportIdentity(source: GitSourceAt): ReportIdentity {
	const parts = [
		'git',
		source.store,
		formatGitSourceSpec(source.spec),
		...(tiedToWorktree(source.spec) ? [source.worktree] : [])
	];
	const text = JSON.stringify(parts);
	const parsed = parseReportIdentity(text);
	if (!parsed.ok) throw new Error(`Not a report identity: ${text}`);
	return parsed.value;
}
