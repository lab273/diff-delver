/**
 * diff delver's own bare git repositories, one per reviewed repository, inside
 * the data directory (DESIGN 3.2): `<data>/stores/<store id>.git`.
 *
 * A store is created on first use, atomically: it is built in a private folder
 * and renamed into place, so two snapshots that create it at once both end up
 * using the one that won. Its config is diff delver's: automatic garbage
 * collection off (collection is `collectGarbage`'s job, under the store lock and
 * with a grace period for other processes), no
 * reflogs, and `diffdelver.repository` naming the repository it holds, for the
 * Storage page. Nothing in it changes a diff, so the diff runs in it directly.
 */
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { millisecondsOf } from '#lib/core/milliseconds.tiny.ts';
import { parseObjectFormat, type ObjectFormat } from '#lib/core/object-format.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import { runGit, runGitText } from '../git/run-git.ts';
import type { StoreError } from './store-error.ts';
import { withStoreLock } from './store-lock.ts';

export interface Store {
	readonly id: StoreId;
	/** The store's bare repository. */
	readonly dir: AbsolutePath;
	readonly objectFormat: ObjectFormat;
	/** The repository the store holds snapshots of, as it was named when the store was made. */
	readonly repository: string;
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
 * The store with this id, made if it does not exist yet, in the given object
 * format, with `repository` recorded as what it holds.
 */
export async function ensureStore(
	dataDirectory: AbsolutePath,
	id: StoreId,
	objectFormat: ObjectFormat,
	repository: string
): Promise<Result<Store, StoreError>> {
	const existing = await openStore(dataDirectory, id);
	if (existing.ok || existing.error.kind !== 'StoreNotFound') return existing;

	const stores = join(dataDirectory, STORES_FOLDER);
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
		try {
			await rename(building, storeDirectory(dataDirectory, id));
		} catch {
			// Another snapshot made the same store first. Theirs is equivalent.
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
		repository: entries.get('diffdelver.repository') ?? ''
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
 * How long an object no snapshot refers to is kept, and how long a leftover
 * folder from a store being made is left alone. Another process may be taking
 * a snapshot: between writing its trees and pinning them they are unreferenced,
 * and the store lock only orders this process's own work. An hour is far longer
 * than any snapshot takes, so no lock between processes is needed.
 */
export const GRACE_PERIOD = millisecondsOf(60 * 60 * 1000);

/**
 * Removes every object no snapshot has referred to for `GRACE_PERIOD` and
 * repacks the rest, so deleted snapshots give their space back (DESIGN 9.1).
 * Waits for everything else in this process using the store to finish, and
 * holds it until done.
 */
export async function collectGarbage(store: Store): Promise<Result<void, StoreError>> {
	return withStoreLock(store.dir, 'exclusive', async () => {
		const seconds = String(Math.round(GRACE_PERIOD / 1000));
		const gc = await runGitText({
			cwd: store.dir,
			args: ['gc', '--quiet', `--prune=${seconds}.seconds.ago`]
		});
		return gc.ok ? ok(undefined) : gc;
	});
}
