/**
 * What a pull request's downloads leave in its store, so that the next one
 * asks GitHub only for what is new (DESIGN 3.1).
 *
 * git tells a server what it has from the commits its refs point at, and the
 * store's snapshot refs point at trees, so without this the store would have
 * nothing to tell GitHub but what the borrowed clone has: every update of a
 * clone that was not fetched again would download the whole gap since its
 * last fetch again, and every update from a partial or shallow clone, which
 * is not borrowed, the whole history.
 *
 * So each download is kept as the pack GitHub sent, with a `.keep` file
 * beside it that names the pull request it was for (by a hash of its
 * identity) and the commits it fetched, its branch's and its base's. The next
 * fetch points refs of its own at those commits for as long as it runs, and
 * git negotiates from them. They are not kept as refs in between, because
 * in a borrowed clone's store their history is partly in the clone, so the
 * store's garbage collection, which walks every ref, would fail; a kept pack
 * is never walked, repacked or pruned by it, so its objects stay as they are.
 * Forgetting a download removes only its `.keep` file: the next collection
 * then keeps what a snapshot still uses and frees the rest.
 */
import { createHash } from 'node:crypto';
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { objectCountOf, type ObjectCount } from '#lib/core/object-count.tiny.ts';
import type { PullRequestRef } from '#lib/core/github/pull-request.ts';
import { pullRequestReportIdentity } from '#lib/core/reports/report-identity.ts';
import type { Store } from '../../store/index.ts';

/** The first words of a `.keep` file diff delver wrote for a pull request's download. */
const HEADER = 'diff-delver pull request ';

/** One download kept in a store. */
export interface KeptFetch {
	/** The `.keep` file. */
	readonly file: string;
	/** Which pull request it was for: a hash of its identity (`fetchKey`). */
	readonly key: string;
	/** The commits it fetched. */
	readonly commits: readonly CommitId[];
	/** When the `.keep` file was written, in milliseconds since 1970. */
	readonly writtenAt: number;
}

/** What names a pull request's downloads in a store: a hash of its identity, never its name. */
export function fetchKey(ref: PullRequestRef): string {
	return createHash('sha256').update(pullRequestReportIdentity(ref)).digest('hex');
}

function packFolder(objects: AbsolutePath): string {
	return join(objects, 'pack');
}

/** The store's object folder: a store is a bare repository. */
export function storeObjects(store: Store): AbsolutePath {
	const objects = parseAbsolutePath(join(store.dir, 'objects'));
	if (!objects.ok) throw new Error('A folder in an absolute one is absolute');
	return objects.value;
}

/** Every download kept in the object folder `objects`, in no particular order. */
export async function keptFetches(objects: AbsolutePath): Promise<readonly KeptFetch[]> {
	const folder = packFolder(objects);
	const names = await readdir(folder).catch(() => []);
	const kept = await Promise.all(
		names
			.filter((name) => name.endsWith('.keep'))
			.map(async (name): Promise<KeptFetch | undefined> => {
				const file = join(folder, name);
				const [text, info] = await Promise.all([
					readFile(file, 'utf8').catch(() => ''),
					stat(file).catch(() => undefined)
				]);
				const [first = '', ...rest] = text.split('\n');
				if (!first.startsWith(HEADER) || info === undefined) return undefined;
				const commits = rest.flatMap((line) => {
					const id = parseCommitId(line);
					return id.ok ? [id.value] : [];
				});
				return { file, key: first.slice(HEADER.length), commits, writtenAt: info.mtimeMs };
			})
	);
	return kept.filter((k) => k !== undefined);
}

/** How many objects a pack holds, from its index's fan-out table (version 2). */
async function objectsInIndex(idx: string): Promise<number> {
	const file = await open(idx, 'r');
	try {
		const last = Buffer.alloc(4);
		// An 8-byte header, then 256 counts; the last is every object.
		await file.read(last, 0, 4, 8 + 255 * 4);
		return last.readUInt32BE(0);
	} finally {
		await file.close();
	}
}

/**
 * Moves the packs a fetch wrote into the object folder `incoming` into
 * `objects`, each kept for the pull request `key` with the `commits` it
 * fetched, and returns how many objects they hold. Each `.keep` file is
 * written before its pack, and the index, by which git finds a pack, is
 * moved last, so no collection ever sees the pack unkept.
 */
export async function keepFetched(
	incoming: AbsolutePath,
	objects: AbsolutePath,
	key: string,
	commits: readonly CommitId[]
): Promise<ObjectCount> {
	const from = packFolder(incoming);
	const to = packFolder(objects);
	const names = await readdir(from);
	let count = 0;
	for (const idx of names.filter((name) => name.endsWith('.idx'))) {
		const pack = idx.slice(0, -'.idx'.length);
		count += await objectsInIndex(join(from, idx));
		await writeFile(join(to, `${pack}.keep`), `${HEADER}${key}\n${commits.join('\n')}\n`);
		const parts = names.filter((name) => name.startsWith(`${pack}.`) && name !== idx);
		for (const part of [...parts, idx]) await rename(join(from, part), join(to, part));
	}
	return objectCountOf(count);
}

/**
 * Forgets the downloads kept in the store for any pull request not among
 * `live`, or, with `live` undefined, every one; with `writtenBefore`, only
 * those kept before then (milliseconds since 1970), so that one a fetch has
 * just kept for a Delve not yet recorded is left alone. The next collection
 * frees what no snapshot uses. Returns how many it forgot.
 */
export async function forgetPullRequestFetches(
	store: Store,
	live: readonly PullRequestRef[] | undefined,
	writtenBefore?: number
): Promise<number> {
	const keys = live === undefined ? undefined : new Set(live.map(fetchKey));
	const forgotten = (await keptFetches(storeObjects(store))).filter(
		(kept) =>
			(keys === undefined || !keys.has(kept.key)) &&
			(writtenBefore === undefined || kept.writtenAt < writtenBefore)
	);
	await Promise.all(forgotten.map((kept) => rm(kept.file, { force: true })));
	return forgotten.length;
}
