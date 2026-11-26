/**
 * Turning a GitHub pull request into a snapshot (DESIGN 3.1, the GitHub PR
 * row): its branch's commit (`refs/pull/<number>/head`) and its base branch
 * are fetched from GitHub into diff delver's own store, never into the
 * person's repository, and the base side is their merge base, as GitHub shows
 * a pull request.
 *
 * The local clone the person pointed at is borrowed read-only while the
 * fetch runs, as git's alternates, so git asks GitHub only for what the clone
 * does not have: usually just the pull request's own new commits. What the
 * store's earlier downloads of pull requests fetched counts too
 * (`kept-fetches.ts`): refs of the fetch's own point at those commits while it
 * runs, so a clone that was not fetched again costs its gap once, not on
 * every update. The fetch writes into a folder of its own (`incoming`), with
 * the store and the clone as alternates, and the pack GitHub sends is kept as
 * a pack (`fetch.unpackLimit=1`), so git never writes a loose object, which is
 * when it would touch a copy the clone already has; the pack is then moved
 * into the store, kept for the pull request. The fetched branches are pinned
 * under refs of the snapshot's own while it is taken, and those refs are
 * deleted once the snapshot pins its trees. If a fetch that offered the
 * earlier downloads fails, as it does when the clone whose history they were
 * fetched on top of is gone, it is made again without them, and they are
 * forgotten only if that works.
 *
 * Everything is fetched, not only what a blobless fetch would bring: with
 * the clone borrowed that is little more, and it leaves the snapshot whole in
 * the store, so reading it later never needs the network or a token. A
 * partial or shallow clone is not borrowed (`borrowable`), so the first
 * download is everything the pull request's two sides need, and later ones
 * only what is new since.
 *
 * The person's token, when there is one, is given to git as a header for
 * GitHub's address, in git's environment (`GIT_CONFIG_*`), never on its
 * command line, and git asks for nothing: no terminal, no credential helper,
 * an askpass that refuses.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { objectCountOf } from '#lib/core/object-count.tiny.ts';
import { repositoryNameOf } from '#lib/core/repository-name.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseSourceIdentity, type SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import type { GitHubHost } from '#lib/core/github/github-host.tiny.ts';
import type { GitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { borrowObjects, quotedAlternate } from '../../git/alternates.ts';
import { runGit, runGitText } from '../../git/run-git.ts';
import {
	ensureStore,
	removeStaleFolders,
	takeSnapshot,
	type Store,
	type StoreWriter
} from '../../store/index.ts';
import type { GitSnapshot, LocalRepository } from '../git/index.ts';
import type { GitHubAccess } from './github-access.ts';
import type { PullRequestDetails } from './github-api.ts';
import type { FetchedInto, GitHubSourceError } from './github-error.ts';
import { fetchKey, forgetPullRequestFetches, keepFetched, keptFetches } from './kept-fetches.ts';

/**
 * The pull request's fingerprint (DESIGN 3.2): its branch's commit, `head`,
 * and its base branch, by name and by the commit GitHub last saw it at. A new
 * commit pushed, a force-push or a new base changes it; a base branch that
 * moved on may change it without changing the diff, which the trees then
 * show. A snapshot's is of the commit it fetched, which is newer than the
 * one GitHub's answer named when a push came in between, so the next look
 * at GitHub finds that push already taken.
 */
export function pullRequestFingerprint(
	details: PullRequestDetails,
	head: CommitId = details.head.commit
): SourceIdentity {
	const hash = createHash('sha256');
	for (const part of ['pull-request', head, details.base.branch, details.base.commit]) {
		hash.update(part);
		hash.update('\0');
	}
	const identity = parseSourceIdentity(hash.digest('hex'));
	if (!identity.ok) throw new Error('A SHA-256 digest is a source identity');
	return identity.value;
}

/**
 * Whether the clone's objects can be borrowed: not when it is partial or
 * shallow. git would tell GitHub it has what the clone has, and GitHub would
 * leave out what that clone never downloaded (a blobless clone's old files, a
 * shallow clone's history), which nothing then fetches.
 */
function borrowable(repo: LocalRepository): boolean {
	return !repo.partialClone && !repo.shallow;
}

/** How the fetch used the clone: borrowed, or not, since it is partial or shallow. */
function cloneKind(repo: LocalRepository): FetchedInto {
	if (repo.partialClone) return 'partial';
	return repo.shallow ? 'shallow' : 'borrowed';
}

/** The clone's objects borrowed, as git's environment, when they can be. */
function borrowed(repo: LocalRepository): Readonly<Record<string, string>> {
	return borrowable(repo) ? borrowObjects(repo.objects) : {};
}

/**
 * git's environment for a fetch from `address`: the token, when there is
 * one, as a header for GitHub's own address (`https://<host>/`) and for no
 * other, and nothing asked of the person.
 */
export function fetchEnvironment(
	address: string,
	host: GitHubHost,
	token: GitHubToken | undefined
): Readonly<Record<string, string>> {
	const quiet = {
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: 'false',
		SSH_ASKPASS: 'false',
		GCM_INTERACTIVE: 'never'
	};
	const site = `https://${host}/`;
	if (token === undefined || !address.startsWith(site)) return quiet;
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

/** The prefix of the folder a fetch writes its objects into, in the store's folder. */
const INCOMING = 'diff-delver-incoming-';

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`Not an absolute path: ${path}`);
	return parsed.value;
}

/**
 * git's environment for writing into `incoming` while reading the store's
 * objects, and the clone's when it is borrowed, as its own.
 */
function writingInto(
	incoming: AbsolutePath,
	writer: StoreWriter,
	repo: LocalRepository
): Readonly<Record<string, string>> {
	const read = [writer.objects, ...(borrowable(repo) ? [repo.objects] : [])];
	return {
		GIT_OBJECT_DIRECTORY: incoming,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: read.map(quotedAlternate).join(delimiter),
		GIT_NO_LAZY_FETCH: '1'
	};
}

/**
 * Points refs under `refs` at the commits the store's earlier downloads
 * fetched that git can read, from the store or the borrowed clone, so the
 * fetch tells GitHub it has them. Returns how many.
 */
async function pointAtKept(
	writer: StoreWriter,
	repo: LocalRepository,
	refs: string
): Promise<number> {
	const commits = [...new Set((await keptFetches(writer.objects)).flatMap((k) => k.commits))];
	if (commits.length === 0) return 0;
	const read = borrowed(repo);
	const checked = await runGit({
		cwd: writer.store.dir,
		args: ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
		input: `${commits.join('\n')}\n`,
		env: read
	});
	if (!checked.ok) return 0;
	const present = checked.value.stdout
		.toString('utf8')
		.split('\n')
		.filter((line) => line.endsWith(' commit'))
		.map((line) => line.slice(0, line.indexOf(' ')));
	if (present.length === 0) return 0;
	const made = await runGit({
		cwd: writer.store.dir,
		args: ['update-ref', '--stdin'],
		input: present.map((c, i) => `create ${refs}known/${String(i)} ${c}\n`).join(''),
		env: read
	});
	return made.ok ? present.length : 0;
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

/**
 * The arguments of git's fetch of the pull request's branch and base from
 * `address` into refs under `refs`: no token, which goes only in its
 * environment (`fetchEnvironment`).
 */
export function fetchArguments(
	details: PullRequestDetails,
	address: string,
	refs: string
): readonly string[] {
	return [
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
		address,
		`+refs/pull/${String(details.ref.number)}/head:${refs}head`,
		`+refs/heads/${details.base.branch}:${refs}base`
	];
}

/**
 * Fetches the pull request's branch and base into the store under `refs`,
 * keeping the download for the pull request, and finds the two trees. With
 * `earlier`, the store's earlier downloads are offered to GitHub as what the
 * store has; `told` is told how many commits that was, and which `.keep`
 * files this download wrote.
 */
async function fetchSides(
	writer: StoreWriter,
	repo: LocalRepository,
	details: PullRequestDetails,
	access: GitHubAccess,
	refs: string,
	earlier: boolean,
	told: { offered: (count: number) => void; kept: (files: readonly string[]) => void }
): Promise<Result<Fetched, GitHubSourceError>> {
	const store = writer.store;
	const host = details.ref.repository.host;
	const address = access.gitAddress(details.ref.repository);
	told.offered(earlier ? await pointAtKept(writer, repo, refs) : 0);
	await removeStaleFolders(store.dir, INCOMING);
	const incoming = absolute(await mkdtemp(join(store.dir, INCOMING)));
	try {
		await mkdir(join(incoming, 'pack'));
		const into = writingInto(incoming, writer, repo);
		const env = { ...fetchEnvironment(address, host, await access.token(host)), ...into };
		const limit = new AbortController();
		const timer = setTimeout(() => {
			limit.abort();
		}, access.fetchSeconds * 1000);
		const fetched = await runGit({
			cwd: store.dir,
			args: fetchArguments(details, address, refs),
			env,
			stopWhen: limit.signal
		}).finally(() => {
			clearTimeout(timer);
		});
		if (!fetched.ok) {
			return err({
				kind: 'PullRequestFetchFailed',
				pullRequest: details.ref,
				clone: cloneKind(repo),
				stoppedAfter: limit.signal.aborted ? access.fetchSeconds : undefined
			});
		}
		const head = await commitAt(store, `${refs}head`, into);
		const tip = await commitAt(store, `${refs}base`, into);
		if (head !== undefined && tip !== undefined) {
			told.kept(await keepFetched(incoming, writer.objects, fetchKey(details.ref), [head, tip]));
		}
	} finally {
		await rm(incoming, { recursive: true, force: true });
	}
	// What the clone had already was not sent, so it is read from the clone.
	const read = borrowed(repo);
	const head = await commitAt(store, `${refs}head`, read);
	const tip = await commitAt(store, `${refs}base`, read);
	if (head === undefined || tip === undefined) {
		return err({
			kind: 'PullRequestFetchFailed',
			pullRequest: details.ref,
			clone: cloneKind(repo),
			stoppedAfter: undefined
		});
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
		return err({
			kind: 'PullRequestFetchFailed',
			pullRequest: details.ref,
			clone: cloneKind(repo),
			stoppedAfter: undefined
		});
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
	interface Attempt {
		/** How many commits of earlier downloads were offered to GitHub. */
		readonly offered: number;
		/** The `.keep` files its download wrote. */
		readonly kept: readonly string[];
		readonly result: Result<GitSnapshot, GitHubSourceError>;
	}
	const attempt = async (earlier: boolean): Promise<Attempt> => {
		const refs = `refs/diff-delver/fetching/${id}/`;
		let offered = 0;
		let kept: readonly string[] = [];
		let sides: Fetched | undefined;
		try {
			const taken = await takeSnapshot(store.value, id, async (writer) => {
				const fetched = await fetchSides(writer, repo, details, access, refs, earlier, {
					offered: (n) => {
						offered = n;
					},
					kept: (files) => {
						kept = files;
					}
				});
				if (!fetched.ok) return fetched;
				sides = fetched.value;
				return ok({
					...fetched.value.trees,
					copyFrom: borrowable(repo) ? repo.objects : undefined
				});
			});
			if (!taken.ok) return { offered, kept, result: taken };
			return {
				offered,
				kept,
				result: ok({
					snapshot: taken.value.snapshot,
					identity: pullRequestFingerprint(details, sides?.head),
					baseCommit: sides?.base,
					headCommit: sides?.head,
					copied: objectCountOf(taken.value.copied),
					leftOut: []
				})
			};
		} finally {
			await dropRefs(store.value, refs);
		}
	};
	const started = Date.now();
	const first = await attempt(true);
	if (first.result.ok || first.offered === 0 || !mayBeTheEarlierDownloads(first.result.error)) {
		return first.result;
	}
	// What they were fetched on top of may be gone, such as the clone they
	// borrowed. Tried again without them, they are forgotten only if that works,
	// since a failure of both says nothing against them.
	const second = await attempt(false);
	if (!second.result.ok) return second.result;
	// Which of them could not be used is not known without walking each one's
	// whole history, so every one kept before the first try is forgotten, and
	// whatever the first try kept on top of them; this try's, and any another
	// fetch kept meanwhile, stay.
	const suspect = new Set(first.kept);
	await forgetPullRequestFetches(
		store.value,
		(kept) => suspect.has(kept.file) || kept.writtenAt < started
	);
	return second.result;
}

/**
 * Whether a failure could come of offering GitHub the store's earlier
 * downloads: the fetch, finding the merge base or copying the trees failed,
 * but not by its time limit, which a second try would only wait out again.
 */
function mayBeTheEarlierDownloads(error: GitHubSourceError): boolean {
	if (error.kind === 'PullRequestFetchFailed') return error.stoppedAfter === undefined;
	return error.kind === 'PullRequestNoMergeBase' || error.kind === 'MissingObject';
}
