/**
 * Turning a GitHub pull request into a snapshot (DESIGN 3.1, the GitHub PR
 * row): its branch's commit (`refs/pull/<number>/head`) and its base branch
 * are fetched from GitHub into diff delver's own store, never into the
 * person's repository, and the base side is their merge base, as GitHub shows
 * a pull request.
 *
 * The local clone the person pointed at is borrowed read-only while the
 * fetch runs, as git's alternates, so git asks GitHub only for what the clone
 * does not have: usually just the pull request's own new commits. The pack
 * GitHub sends is kept as a pack (`fetch.unpackLimit=1`), so git never writes
 * a loose object, which is when it would touch a copy the clone already has.
 * The fetched branches are pinned under refs of the snapshot's own while it is
 * taken, and those refs are deleted once the snapshot pins its trees.
 *
 * Everything is fetched, not only what a blobless fetch would bring: with
 * the clone borrowed that is little more, and it leaves the snapshot whole in
 * the store, so reading it later never needs the network or a token.
 *
 * The person's token, when there is one, is given to git as a header for
 * GitHub's address, in git's environment (`GIT_CONFIG_*`), never on its
 * command line, and git asks for nothing: no terminal, no credential helper,
 * an askpass that refuses.
 */
import { createHash } from 'node:crypto';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { objectCountOf } from '#lib/core/object-count.tiny.ts';
import { repositoryNameOf } from '#lib/core/repository-name.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseSourceIdentity, type SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import type { GitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { borrowObjects } from '../../git/alternates.ts';
import { runGit, runGitText } from '../../git/run-git.ts';
import { ensureStore, takeSnapshot, type Store } from '../../store/index.ts';
import type { GitSnapshot, LocalRepository } from '../git/index.ts';
import type { GitHubAccess } from './github-access.ts';
import type { PullRequestDetails } from './github-api.ts';
import type { GitHubSourceError } from './github-error.ts';

/**
 * The pull request's fingerprint (DESIGN 3.2): its branch's commit and its
 * base branch, by name and by the commit GitHub last saw it at. A new commit
 * pushed, a force-push or a new base changes it; a base branch that moved on
 * may change it without changing the diff, which the trees then show.
 */
export function pullRequestFingerprint(details: PullRequestDetails): SourceIdentity {
	const hash = createHash('sha256');
	for (const part of [
		'pull-request',
		details.head.commit,
		details.base.branch,
		details.base.commit
	]) {
		hash.update(part);
		hash.update('\0');
	}
	const identity = parseSourceIdentity(hash.digest('hex'));
	if (!identity.ok) throw new Error('A SHA-256 digest is a source identity');
	return identity.value;
}

/** git's environment for a fetch from GitHub: the token as a header for its address, and nothing asked. */
function fetchEnvironment(
	repo: LocalRepository,
	cloneUrl: string,
	host: string,
	token: GitHubToken | undefined
): Readonly<Record<string, string>> {
	const quiet = {
		...borrowObjects(repo.objects),
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: 'false',
		SSH_ASKPASS: 'false',
		GCM_INTERACTIVE: 'never'
	};
	const site = `https://${host}/`;
	if (token === undefined || !cloneUrl.startsWith(site)) return quiet;
	const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
	return {
		...quiet,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `http.${site}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`
	};
}

interface Fetched {
	readonly base: CommitId;
	readonly head: CommitId;
	readonly trees: { readonly base: TreeId; readonly head: TreeId };
}

async function commitAt(
	store: Store,
	ref: string,
	env: Readonly<Record<string, string>>
): Promise<CommitId | undefined> {
	const found = await runGitText({
		cwd: store.dir,
		env,
		args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]
	});
	const id = found.ok ? parseCommitId(found.value) : undefined;
	return id?.ok === true ? id.value : undefined;
}

async function treeAt(
	store: Store,
	commit: CommitId,
	env: Readonly<Record<string, string>>
): Promise<TreeId | undefined> {
	const found = await runGitText({
		cwd: store.dir,
		args: ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`],
		env
	});
	const id = found.ok ? parseTreeId(found.value) : undefined;
	return id?.ok === true ? id.value : undefined;
}

/** Fetches the pull request's branch and base into the store under `refs`, and finds the two trees. */
async function fetchSides(
	store: Store,
	repo: LocalRepository,
	details: PullRequestDetails,
	access: GitHubAccess,
	refs: string
): Promise<Result<Fetched, GitHubSourceError>> {
	const host = details.ref.repository.host;
	const env = fetchEnvironment(repo, details.base.cloneUrl, host, await access.token(host));
	const limit = new AbortController();
	const timer = setTimeout(() => {
		limit.abort();
	}, access.seconds * 1000);
	const fetched = await runGit({
		cwd: store.dir,
		args: [
			'-c',
			'fetch.unpackLimit=1',
			'-c',
			'transfer.unpackLimit=1',
			'-c',
			'credential.interactive=false',
			'fetch',
			'--quiet',
			'--no-tags',
			'--no-write-fetch-head',
			'--no-auto-gc',
			'--no-auto-maintenance',
			'--no-recurse-submodules',
			'--end-of-options',
			details.base.cloneUrl,
			`+refs/pull/${String(details.ref.number)}/head:${refs}head`,
			`+refs/heads/${details.base.branch}:${refs}base`
		],
		env,
		stopWhen: limit.signal
	}).finally(() => {
		clearTimeout(timer);
	});
	if (!fetched.ok) {
		return err({
			kind: 'PullRequestFetchFailed',
			pullRequest: details.ref,
			timedOut: limit.signal.aborted
		});
	}
	// What the clone had already was not sent, so it is read from the clone.
	const read = borrowObjects(repo.objects);
	const head = await commitAt(store, `${refs}head`, read);
	const tip = await commitAt(store, `${refs}base`, read);
	if (head === undefined || tip === undefined) {
		return err({ kind: 'PullRequestFetchFailed', pullRequest: details.ref, timedOut: false });
	}
	const merged = await runGitText({
		cwd: store.dir,
		args: ['merge-base', '--end-of-options', tip, head],
		env: read
	});
	const base = merged.ok ? parseCommitId(merged.value) : undefined;
	if (base?.ok !== true)
		return err({ kind: 'PullRequestNoMergeBase', pullRequest: details.ref, head });
	const baseTree = await treeAt(store, base.value, read);
	const headTree = await treeAt(store, head, read);
	if (baseTree === undefined || headTree === undefined) {
		return err({ kind: 'PullRequestFetchFailed', pullRequest: details.ref, timedOut: false });
	}
	return ok({ base: base.value, head, trees: { base: baseTree, head: headTree } });
}

/** Deletes every ref under `refs` in the store. */
async function dropRefs(store: Store, refs: string): Promise<void> {
	const listed = await runGitText({
		cwd: store.dir,
		args: ['for-each-ref', '--format=delete %(refname)', refs]
	});
	if (!listed.ok || listed.value === '') return;
	await runGit({ cwd: store.dir, args: ['update-ref', '--stdin'], input: `${listed.value}\n` });
}

/**
 * Takes a snapshot of the pull request as `details` describe it, in the store
 * `storeId`, borrowing the local clone `repo`, making the store if this is its
 * first. The store is usually the clone's own, and is another clone's for a
 * Delve first opened there, so all its versions are in one store. `id`, new
 * to the store, names the snapshot.
 */
export async function snapshotPullRequest(
	dataDirectory: AbsolutePath,
	repo: LocalRepository,
	storeId: StoreId,
	details: PullRequestDetails,
	access: GitHubAccess,
	id: SnapshotId
): Promise<Result<GitSnapshot, GitHubSourceError>> {
	const store = await ensureStore(
		dataDirectory,
		storeId,
		repo.objectFormat,
		repositoryNameOf(repo.commonDir)
	);
	if (!store.ok) return store;
	const refs = `refs/diff-delver/fetching/${id}/`;
	let sides: Fetched | undefined;
	try {
		const taken = await takeSnapshot(store.value, id, async (writer) => {
			const fetched = await fetchSides(writer.store, repo, details, access, refs);
			if (!fetched.ok) return fetched;
			sides = fetched.value;
			return ok({ ...fetched.value.trees, copyFrom: repo.objects });
		});
		if (!taken.ok) return taken;
		return ok({
			snapshot: taken.value.snapshot,
			identity: pullRequestFingerprint(details),
			baseCommit: sides?.base,
			headCommit: sides?.head,
			copied: objectCountOf(taken.value.copied),
			leftOut: []
		});
	} finally {
		await dropRefs(store.value, refs);
	}
}
