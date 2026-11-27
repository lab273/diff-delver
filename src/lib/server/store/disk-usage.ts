/**
 * What a store's objects take on disk (DESIGN 9.1), for the figures of each
 * Delve (`#lib/core/disk-usage/delve-sizes.ts`): the objects some snapshots
 * reach, the objects in a pack, each object's size on disk by git's own
 * measure, and the store's whole size on disk. Each holds the store shared,
 * so a collection waits for it; between two of them the store may be
 * collected, which only makes an estimate a little off.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import { parseObjectId, type ObjectId } from '#lib/core/object-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { runGit } from '../git/run-git.ts';
import { SNAPSHOT_REFS } from './snapshots.ts';
import type { Store } from './store.ts';
import type { StoreError } from './store-error.ts';
import { withStoreLock } from './store-lock.ts';

/** Every object id at the start of a line of git's output, once each, in the order given. */
function objectIdsIn(output: Buffer, field: number): readonly ObjectId[] {
	const ids: ObjectId[] = [];
	for (const line of output.toString('utf8').split('\n')) {
		const id = parseObjectId(line.split(' ')[field] ?? '');
		if (id.ok) ids.push(id.value);
	}
	return ids;
}

/**
 * Every object the snapshots reach: their trees, the trees and blobs in them.
 * A snapshot deleted meanwhile reaches nothing.
 */
export function objectsReachedBy(
	store: Store,
	snapshots: readonly SnapshotId[]
): Promise<Result<readonly ObjectId[], StoreError>> {
	if (snapshots.length === 0) return Promise.resolve(ok([]));
	return withStoreLock(store.dir, 'shared', async () => {
		const listed = await runGit({
			cwd: store.dir,
			args: ['rev-list', '--objects', '--no-object-names', '--ignore-missing', '--stdin'],
			input: snapshots.map((id) => `${SNAPSHOT_REFS}${id}\n`).join('')
		});
		return listed.ok ? ok(objectIdsIn(listed.value.stdout, 0)) : listed;
	});
}

/** Every object in the pack whose index is `packIndex`, a file of the store's. */
export function objectsInPack(
	store: Store,
	packIndex: string
): Promise<Result<readonly ObjectId[], StoreError>> {
	return withStoreLock(store.dir, 'shared', async () => {
		const index = await readFile(packIndex).catch(() => undefined);
		// A pack collected meanwhile holds nothing any more.
		if (index === undefined) return ok([]);
		const listed = await runGit({
			cwd: store.dir,
			args: ['show-index', `--object-format=${store.objectFormat}`],
			input: index
		});
		// Each line is the object's offset in the pack, its id and its checksum.
		return listed.ok ? ok(objectIdsIn(listed.value.stdout, 1)) : listed;
	});
}

/**
 * The size on disk of every object in the store, by git's own measure: a
 * loose object's file, or its entry in a pack, which may be stored against
 * another object. An object in two packs has the size of one of them.
 */
export function objectDiskSizes(
	store: Store
): Promise<Result<ReadonlyMap<ObjectId, ByteSize>, StoreError>> {
	return withStoreLock(store.dir, 'shared', async () => {
		const listed = await runGit({
			cwd: store.dir,
			args: ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objectsize:disk)']
		});
		if (!listed.ok) return listed;
		const sizes = new Map<ObjectId, ByteSize>();
		for (const line of listed.value.stdout.toString('utf8').split('\n')) {
			const [name = '', bytes = ''] = line.split(' ');
			const id = parseObjectId(name);
			const size = parseByteSize(Number(bytes));
			if (id.ok && size.ok && bytes !== '' && !sizes.has(id.value)) sizes.set(id.value, size.value);
		}
		return ok(sizes);
	});
}

/** The store's whole size on disk: every file in its folder, added up. */
export async function storeSizeOnDisk(store: Store): Promise<ByteSize> {
	return withStoreLock(store.dir, 'shared', () => folderSize(store.dir));
}

/** Every file under `folder`, added up; one removed while it is read counts nothing. */
export async function folderSize(folder: string): Promise<ByteSize> {
	const size = parseByteSize(await bytesUnder(folder));
	if (!size.ok) throw new Error(`A folder's files add up to no size: ${folder}`);
	return size.value;
}

async function bytesUnder(folder: string): Promise<number> {
	let total = 0;
	const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) total += await bytesUnder(path);
		else if (entry.isFile()) total += (await stat(path).catch(() => undefined))?.size ?? 0;
	}
	return total;
}
