/**
 * diff delver's own bare git repositories, one per reviewed repository, inside
 * the data directory (DESIGN 3.2): `<data>/stores/<store id>.git`.
 *
 * A store is created on first use, atomically: it is built in a private folder
 * and renamed into place, so two snapshots that create it at once both end up
 * using the one that won. A private folder a crash left behind is removed the
 * next time a store is opened for a snapshot, once it is an hour old. Its config is diff delver's: automatic garbage
 * collection off (collection is `collectGarbage`'s job, under the store lock and
 * with a grace period for other processes), no
 * reflogs, and `diffdelver.repository` naming the repository it holds, for the
 * Storage page. Nothing in it changes a diff, so the diff runs in it directly.
 */
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseObjectFormat, type ObjectFormat } from '#lib/core/object-format.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseRepositoryName, type RepositoryName } from '#lib/core/repository-name.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import { runGit, runGitText } from '../git/run-git.ts';
import type { StoreError } from './store-error.ts';
import { GRACE_PERIOD, removeStaleFolders } from './stale-folders.ts';
import { withStoreLock } from './store-lock.ts';

export interface Store {
	readonly id: StoreId;
	/** The store's bare repository. */
	readonly dir: AbsolutePath;
	readonly objectFormat: ObjectFormat;
	/** The repository the store holds snapshots of, as it was named when the store was made; absent if not recorded. */
	readonly repository: RepositoryName | undefined;
}

/** The folder inside the data directory that holds the stores. */
export const STORES_FOLDER = 'stores';

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`Not an absolute path: ${path}`);
	return parsed.value;
}

/** Where the store with this id lives in the data directory, whether or not it exists. */
export function storeDirectory(dataDirectory: AbsolutePath, id: StoreId): AbsolutePath {
	return absolute(join(dataDirectory, STORES_FOLDER, `${id}.git`));
}

function unusable(directory: string, error: unknown): StoreError {
	return {
		kind: 'DataDirectoryUnusable',
		directory: absolute(directory),
		reason: error instanceof Error ? error.message : String(error)
	};
}

/**
 * Why the folder that holds the stores could not hold a new one, if it could
 * not: it is not a folder, or diff delver cannot write to it or, while it does
 * not exist, to the data folder it would be made in. Writes nothing.
 */
async function storesFolderProblem(dataDirectory: AbsolutePath): Promise<StoreError | undefined> {
	const stores = join(dataDirectory, STORES_FOLDER);
	try {
		const found = await stat(stores).catch((error: unknown) => {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (found !== undefined && !found.isDirectory()) {
			return unusable(stores, new Error('it is a file, not a folder'));
		}
		await access(found === undefined ? dataDirectory : stores, constants.W_OK | constants.X_OK);
		return undefined;
	} catch (error) {
		return unusable(stores, error);
	}
}

/**
 * Whether a snapshot could be taken into the store with this id, found without
 * making or writing anything: the store opens, or it does not exist yet and
 * `ensureStore` could make it. What would stop `ensureStore` is the error it
 * would give.
 */
export async function checkStoreUsable(
	dataDirectory: AbsolutePath,
	id: StoreId
): Promise<Result<void, StoreError>> {
	const existing = await openStore(dataDirectory, id);
	if (existing.ok) return ok(undefined);
	if (existing.error.kind !== 'StoreNotFound') return existing;
	const problem = await storesFolderProblem(dataDirectory);
	return problem === undefined ? ok(undefined) : err(problem);
}

/**
 * The store with this id, made if it does not exist yet, in the given object
 * format, with `repository` recorded as what it holds.
 */
export async function ensureStore(
	dataDirectory: AbsolutePath,
	id: StoreId,
	objectFormat: ObjectFormat,
	repository: RepositoryName
): Promise<Result<Store, StoreError>> {
	const stores = absolute(join(dataDirectory, STORES_FOLDER));
	await removeStaleFolders(stores, '.new-');
	const existing = await openStore(dataDirectory, id);
	if (existing.ok || existing.error.kind !== 'StoreNotFound') return existing;
	// Said as `checkStoreUsable` says it.
	const problem = await storesFolderProblem(dataDirectory);
	if (problem !== undefined) return err(problem);

	try {
		await mkdir(stores, { recursive: true, mode: 0o700 });
	} catch (error) {
		return err(unusable(stores, error));
	}
	let building: string;
	try {
		building = await mkdtemp(join(stores, '.new-'));
	} catch (error) {
		return err(unusable(stores, error));
	}
	try {
		const dir = absolute(building);
		const init = await runGit({
			cwd: dir,
			args: ['init', '--quiet', '--bare', `--object-format=${objectFormat}`, '.']
		});
		if (!init.ok) return init;
		for (const [key, value] of [
			['gc.auto', '0'],
			['core.logAllRefUpdates', 'false'],
			['diffdelver.repository', repository]
		] as const) {
			const set = await runGit({ cwd: dir, args: ['config', key, value] });
			if (!set.ok) return set;
		}
		// The empty tree, stored for real, so a snapshot can name it as either side.
		const empty = await runGit({ cwd: dir, args: ['mktree'], input: '' });
		if (!empty.ok) return empty;
		const target = storeDirectory(dataDirectory, id);
		try {
			await rename(building, target);
		} catch (error) {
			// Another snapshot made the same store first, which is equivalent; anything else is not.
			const code = error instanceof Error && 'code' in error ? error.code : undefined;
			if (code !== 'EEXIST' && code !== 'ENOTEMPTY') return err(unusable(target, error));
		}
	} finally {
		await rm(building, { recursive: true, force: true });
	}
	return openStore(dataDirectory, id);
}

/** The store with this id, or `StoreNotFound`. */
export async function openStore(
	dataDirectory: AbsolutePath,
	id: StoreId
): Promise<Result<Store, StoreError>> {
	const dir = storeDirectory(dataDirectory, id);
	const found = await stat(join(dir, 'HEAD')).catch(() => undefined);
	if (found === undefined) return err({ kind: 'StoreNotFound', store: id });
	const config = await runGit({
		cwd: dir,
		args: [
			'config',
			'--null',
			'--get-regexp',
			'^(extensions\\.objectformat|diffdelver\\.repository)$'
		]
	});
	if (!config.ok) return config;
	const entries = new Map(
		config.value.stdout
			.toString('utf8')
			.split('\0')
			.filter((entry) => entry !== '')
			.map((entry) => {
				const newline = entry.indexOf('\n');
				return [entry.slice(0, newline), entry.slice(newline + 1)] as const;
			})
	);
	const format = parseObjectFormat(entries.get('extensions.objectformat') ?? 'sha1');
	if (!format.ok) {
		return err({
			kind: 'StoreDamaged',
			store: id,
			detail: `unknown object format ${format.error.value}`
		});
	}
	return ok({
		id,
		dir,
		objectFormat: format.value,
		repository: (() => {
			const name = parseRepositoryName(entries.get('diffdelver.repository') ?? '');
			return name.ok ? name.value : undefined;
		})()
	});
}

/** Every store in the data directory, for the Storage page. */
export async function listStores(
	dataDirectory: AbsolutePath
): Promise<Result<readonly Store[], StoreError>> {
	const names = await readdir(join(dataDirectory, STORES_FOLDER)).catch(() => []);
	const stores: Store[] = [];
	for (const name of names.toSorted()) {
		if (!name.endsWith('.git')) continue;
		const id = parseStoreId(name.slice(0, -'.git'.length));
		if (!id.ok) continue;
		const store = await openStore(dataDirectory, id.value);
		if (store.ok) stores.push(store.value);
		else if (store.error.kind !== 'StoreNotFound') return store;
	}
	return ok(stores);
}

/**
 * When each store's newest pack was written, in milliseconds since 1970, for
 * stores whose newest pack is younger than `since`: what a collection there
 * keeps through the next one for the grace period, as git dates an object
 * taken out of a pack by the pack. Only the pack folders are read, file by
 * file, never with git.
 */
export async function storesPackedSince(
	dataDirectory: AbsolutePath,
	since: number
): Promise<ReadonlyMap<StoreId, number>> {
	const found = new Map<StoreId, number>();
	const names = await readdir(join(dataDirectory, STORES_FOLDER)).catch(() => []);
	for (const name of names) {
		if (!name.endsWith('.git')) continue;
		const id = parseStoreId(name.slice(0, -'.git'.length));
		if (!id.ok) continue;
		const packs = join(dataDirectory, STORES_FOLDER, name, 'objects', 'pack');
		let newest = 0;
		for (const file of await readdir(packs).catch(() => [])) {
			const info = await stat(join(packs, file)).catch(() => undefined);
			if (info !== undefined && info.mtimeMs > newest) newest = info.mtimeMs;
		}
		if (newest > since) found.set(id.value, newest);
	}
	return found;
}

/**
 * Where a source points refs at commits for as long as it holds the store,
 * such as a pull request's fetch, under a folder of its own per snapshot.
 * They are deleted before it lets the store go, so none is left when the
 * store is collected but one a process stopped midway left behind.
 */
export const FETCHING_REFS = 'refs/diff-delver/fetching/';

/** Deletes every ref under `prefix` in the store, even one at an object it lacks. */
export async function deleteRefsUnder(
	store: Store,
	prefix: string
): Promise<Result<void, StoreError>> {
	const listed = await runGitText({
		cwd: store.dir,
		args: ['for-each-ref', '--format=delete %(refname)', prefix]
	});
	if (!listed.ok) return listed;
	if (listed.value === '') return ok(undefined);
	const deleted = await runGit({
		cwd: store.dir,
		args: ['update-ref', '--stdin'],
		input: `${listed.value}\n`
	});
	return deleted.ok ? ok(undefined) : deleted;
}

/**
 * Removes every object no snapshot has referred to for `GRACE_PERIOD` and
 * repacks the rest, so deleted snapshots give their space back (DESIGN 9.1).
 * Waits for everything else in this process using the store to finish, and
 * holds it until done. First it deletes the refs a fetch left behind
 * (`FETCHING_REFS`): nothing holds the store, so none is in use, and one may
 * point at a commit whose history was only borrowed, which git cannot walk.
 */
export async function collectGarbage(store: Store): Promise<Result<void, StoreError>> {
	return withStoreLock(store.dir, 'exclusive', async () => {
		const dropped = await deleteRefsUnder(store, FETCHING_REFS);
		if (!dropped.ok) return dropped;
		const seconds = String(Math.round(GRACE_PERIOD / 1000));
		const gc = await runGitText({
			cwd: store.dir,
			args: ['gc', '--quiet', `--prune=${seconds}.seconds.ago`]
		});
		return gc.ok ? ok(undefined) : gc;
	});
}
