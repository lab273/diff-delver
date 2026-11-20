/**
 * Snapshots: a base tree and a head tree held in a store, pinned by one ref
 * (DESIGN 3.2).
 *
 * The ref, `refs/diff-delver/snapshots/<id>`, points at a small tree of diff
 * delver's own with two entries, `base` and `head`, so one atomic ref update pins
 * both, and the store's garbage collection keeps everything reachable from them.
 * Deleting a snapshot deletes its ref; its objects go at the next collection,
 * unless another snapshot shares them.
 *
 * Taking a snapshot copies in the objects reachable from the two trees that the
 * store does not already have, and nothing else: no commits, no history. So a
 * snapshot is self-sufficient (its diff and every file of both trees are in the
 * store), and snapshots of one repository share whatever did not change.
 */
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { objectCountOf, type ObjectCount } from '#lib/core/object-count.tiny.ts';
import { parseObjectId, type AnyObjectId, type ObjectId } from '#lib/core/object-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseSnapshotId, type SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import { parseTreeId, type TreeId } from '#lib/core/tree-id.tiny.ts';
import { borrowObjects } from '../git/alternates.ts';
import { runGit, runGitText } from '../git/run-git.ts';
import type { StoreError } from './store-error.ts';
import { withStoreLock } from './store-lock.ts';
import { openStore, type Store } from './store.ts';

/** Where a snapshot's ref lives in its store. */
export const SNAPSHOT_REFS = 'refs/diff-delver/snapshots/';

export interface Snapshot {
	readonly store: Store;
	readonly id: SnapshotId;
	/** The old side. */
	readonly base: TreeId;
	/** The new side. */
	readonly head: TreeId;
}

/** What names a snapshot from outside, such as a database row: its store and its id. */
export interface SnapshotRef {
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
}

/** The ref of a snapshot, for storing. */
export function snapshotRefOf(snapshot: Snapshot): SnapshotRef {
	return { store: snapshot.store.id, snapshot: snapshot.id };
}

/** Where a source writes objects while it works out its two trees. */
export interface StoreWriter {
	readonly store: Store;
	/** The store's object directory, for `GIT_OBJECT_DIRECTORY`. */
	readonly objects: AbsolutePath;
}

/** The two trees a source reduced to. */
export interface PreparedTrees {
	readonly base: TreeId;
	readonly head: TreeId;
	/**
	 * An object directory that holds whatever of the two trees the store lacks,
	 * such as the reviewed repository's. It is only read. Absent when the source
	 * wrote everything into the store itself.
	 */
	readonly copyFrom: AbsolutePath | undefined;
}

export interface TakenSnapshot {
	readonly snapshot: Snapshot;
	/** How many objects were copied into the store: none when it had them all already. */
	readonly copied: ObjectCount;
}

/** Below this many objects a copy is unpacked into loose objects, as `git fetch` does. */
const UNPACK_LIMIT = 100;

/**
 * Copies into the store those of the given objects it lacks, reading them from
 * `copyFrom`, and returns how many it copied. Runs in the store, so only the
 * store's settings apply; the other directory is borrowed read-only while the
 * objects are packed, and is not visible while they are written, because git
 * freshens (touches) an existing object it is asked to write.
 *
 * For a source preparing its trees inside `takeSnapshot`, to put in the store
 * any object git will need to read while it writes there, such as the blobs an
 * index names.
 */
export async function copyObjects(
	writer: StoreWriter,
	ids: readonly AnyObjectId[],
	copyFrom: AbsolutePath
): Promise<Result<ObjectCount, StoreError>> {
	const { store } = writer;
	if (ids.length === 0) return ok(objectCountOf(0));
	const checked = await runGit({
		cwd: store.dir,
		args: ['cat-file', '--batch-check=%(objectname)'],
		input: `${ids.join('\n')}\n`
	});
	if (!checked.ok) return checked;
	const missing = checked.value.stdout
		.toString('utf8')
		.split('\n')
		.filter((line) => line.endsWith(' missing'))
		.map((line) => line.slice(0, line.indexOf(' ')));
	if (missing.length === 0) return ok(objectCountOf(0));
	const list = `${missing.join('\n')}\n`;
	const env = borrowObjects(copyFrom);
	if (missing.length < UNPACK_LIMIT) {
		const pack = await runGit({
			cwd: store.dir,
			args: ['pack-objects', '--stdout', '--quiet'],
			input: list,
			env
		});
		if (!pack.ok) return pack;
		const unpacked = await runGit({
			cwd: store.dir,
			args: ['unpack-objects', '-q'],
			input: pack.value.stdout
		});
		if (!unpacked.ok) return unpacked;
	} else {
		// Written straight into the store's pack folder; git renames the files into place.
		const packed = await runGit({
			cwd: store.dir,
			args: ['pack-objects', '--quiet', `${store.dir}/objects/pack/pack`],
			input: list,
			env
		});
		if (!packed.ok) return packed;
	}
	return ok(objectCountOf(missing.length));
}

/**
 * Copies in every object reachable from the trees that the store lacks, and
 * returns how many it copied. With no `copyFrom`, it checks that the store has
 * them all, which fails with `MissingObject` if it does not. For a source
 * preparing its trees inside `takeSnapshot`, like `copyObjects`.
 */
export async function copyTrees(
	writer: StoreWriter,
	trees: readonly TreeId[],
	copyFrom: AbsolutePath | undefined
): Promise<Result<ObjectCount, StoreError>> {
	const listed = await runGit({
		cwd: writer.store.dir,
		args: ['rev-list', '--objects', '--no-object-names', '--end-of-options', ...trees],
		env: copyFrom === undefined ? { GIT_NO_LAZY_FETCH: '1' } : borrowObjects(copyFrom)
	});
	if (!listed.ok) {
		// The trees are named by id, so one git calls a bad object is missing: a
		// partial clone that never downloaded it, or a damaged repository.
		return listed.error.kind === 'BadRevision'
			? err({
					kind: 'MissingObject',
					object: objectIdIn(/bad object ([0-9a-f]+)/.exec(listed.error.stderr)?.[1]),
					stderr: listed.error.stderr
				})
			: listed;
	}
	if (copyFrom === undefined) return ok(objectCountOf(0));
	const ids = listed.value.stdout
		.toString('utf8')
		.split('\n')
		.flatMap((line) => {
			const id = parseObjectId(line);
			return id.ok ? [id.value] : [];
		});
	return copyObjects(writer, ids, copyFrom);
}

function objectIdIn(text: string | undefined): ObjectId | undefined {
	const id = parseObjectId(text ?? '');
	return id.ok ? id.value : undefined;
}

function snapshotRef(id: SnapshotId): string {
	return `${SNAPSHOT_REFS}${id}`;
}

/** Writes the tree that holds `base` and `head` and points a new ref at it. */
async function pin(
	store: Store,
	id: SnapshotId,
	base: TreeId,
	head: TreeId
): Promise<Result<Snapshot, StoreError>> {
	const wrapper = await runGitText({
		cwd: store.dir,
		args: ['mktree', '-z'],
		input: [`040000 tree ${base}\tbase`, `040000 tree ${head}\thead`, ''].join('\0')
	});
	if (!wrapper.ok) return wrapper;
	const zero = '0'.repeat(base.length);
	const created = await runGit({
		cwd: store.dir,
		args: ['update-ref', '-m', 'snapshot', snapshotRef(id), wrapper.value, zero]
	});
	if (!created.ok) return created;
	return ok({ store, id, base, head });
}

/**
 * Takes a snapshot: `prepare` works out the two trees, writing any new objects
 * into the store through the writer it is given; then the store copies in what
 * it still lacks from `copyFrom` and pins both trees. The store is held for the
 * whole time, so garbage collection cannot remove objects written but not yet
 * pinned. `id` names the snapshot; it must be new to the store, so it comes
 * from an `IdSource`.
 */
export async function takeSnapshot<E>(
	store: Store,
	id: SnapshotId,
	prepare: (writer: StoreWriter) => Promise<Result<PreparedTrees, E>>
): Promise<Result<TakenSnapshot, E | StoreError>> {
	return withStoreLock(
		store.dir,
		'shared',
		async (): Promise<Result<TakenSnapshot, E | StoreError>> => {
			const objects = await runGitText({
				cwd: store.dir,
				args: ['rev-parse', '--path-format=absolute', '--git-path', 'objects']
			});
			if (!objects.ok) return objects;
			const writer: StoreWriter = { store, objects: absoluteOrThrow(objects.value) };
			const prepared = await prepare(writer);
			if (!prepared.ok) return prepared;
			const { base, head, copyFrom } = prepared.value;
			const copied = await copyTrees(writer, base === head ? [head] : [base, head], copyFrom);
			if (!copied.ok) return copied;
			const snapshot = await pin(store, id, base, head);
			return snapshot.ok ? ok({ snapshot: snapshot.value, copied: copied.value }) : snapshot;
		}
	);
}

function absoluteOrThrow(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`git gave a path that is not absolute: ${path}`);
	return parsed.value;
}

/** The trees of the snapshots named, in order, or undefined for each one not in the store. */
async function treesOf(
	store: Store,
	ids: readonly SnapshotId[]
): Promise<Result<readonly ({ base: TreeId; head: TreeId } | undefined)[], StoreError>> {
	if (ids.length === 0) return ok([]);
	const input = ids.map((id) => `${snapshotRef(id)}:base\n${snapshotRef(id)}:head\n`).join('');
	const checked = await runGit({
		cwd: store.dir,
		args: ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
		input
	});
	if (!checked.ok) return checked;
	const lines = checked.value.stdout.toString('utf8').split('\n');
	const tree = (line: string | undefined): TreeId | undefined => {
		const [id, type] = (line ?? '').split(' ');
		const parsed = type === 'tree' ? parseTreeId(id ?? '') : undefined;
		return parsed?.ok === true ? parsed.value : undefined;
	};
	return ok(
		ids.map((_, i) => {
			const base = tree(lines[2 * i]);
			const head = tree(lines[2 * i + 1]);
			return base === undefined || head === undefined ? undefined : { base, head };
		})
	);
}

/** The snapshot with this id in the store, or `SnapshotNotFound`. */
export async function openSnapshot(
	store: Store,
	id: SnapshotId
): Promise<Result<Snapshot, StoreError>> {
	const trees = await treesOf(store, [id]);
	if (!trees.ok) return trees;
	const found = trees.value[0];
	return found === undefined
		? err({ kind: 'SnapshotNotFound', store: store.id, snapshot: id })
		: ok({ store, id, ...found });
}

/** The snapshot a `SnapshotRef` names, opening its store in the data directory. */
export async function openSnapshotRef(
	dataDirectory: AbsolutePath,
	ref: SnapshotRef
): Promise<Result<Snapshot, StoreError>> {
	const store = await openStore(dataDirectory, ref.store);
	return store.ok ? openSnapshot(store.value, ref.snapshot) : store;
}

/** Every snapshot in the store, in no particular order. */
export async function listSnapshots(
	store: Store
): Promise<Result<readonly Snapshot[], StoreError>> {
	const refs = await runGitText({
		cwd: store.dir,
		args: ['for-each-ref', '--format=%(refname)', SNAPSHOT_REFS]
	});
	if (!refs.ok) return refs;
	const ids = refs.value
		.split('\n')
		.map((ref) => parseSnapshotId(ref.slice(SNAPSHOT_REFS.length)))
		.flatMap((id) => (id.ok ? [id.value] : []));
	const trees = await treesOf(store, ids);
	if (!trees.ok) return trees;
	return ok(
		ids.flatMap((id, i) => {
			const found = trees.value[i];
			// A snapshot deleted between the two reads is simply gone.
			return found === undefined ? [] : [{ store, id, ...found }];
		})
	);
}

/**
 * Deletes the snapshot's ref. Its objects stay until the next `collectGarbage`,
 * and stay for good if another snapshot shares them. A snapshot being read while
 * it is deleted is read to the end.
 */
export async function deleteSnapshot(
	store: Store,
	id: SnapshotId
): Promise<Result<void, StoreError>> {
	return withStoreLock(store.dir, 'shared', async (): Promise<Result<void, StoreError>> => {
		const notFound: Result<void, StoreError> = err({
			kind: 'SnapshotNotFound',
			store: store.id,
			snapshot: id
		});
		const current = await runGit({
			cwd: store.dir,
			args: ['rev-parse', '--verify', '--quiet', snapshotRef(id)]
		});
		if (!current.ok) return current.error.kind === 'GitFailed' ? notFound : current;
		const old = current.value.stdout.toString('utf8').trim();
		// Deleted only if it still points where it did, so two deletes cannot both succeed.
		const deleted = await runGit({
			cwd: store.dir,
			args: ['update-ref', '-d', snapshotRef(id), old]
		});
		if (!deleted.ok) return deleted.error.kind === 'GitFailed' ? notFound : deleted;
		return ok(undefined);
	});
}
