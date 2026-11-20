/**
 * The snapshot store (DESIGN 3.2): diff delver's own bare git repository per
 * reviewed repository, in the data directory, holding snapshots of two trees.
 * Import the store from here.
 *
 * ```ts
 * const store = await ensureStore(dataDir, storeId, 'sha1', '/path/to/repo');
 * const taken = await takeSnapshot(store.value, async (writer) => ok({ base, head, copyFrom }));
 * const diff = await readSnapshotDiff(taken.value.snapshot);
 * const file = await readSnapshotFile(taken.value.snapshot, 'new', path);
 * ```
 *
 * Sources build on `takeSnapshot`; the git source is in `#lib/server/sources/git`.
 */
export type { Store } from './store.ts';
export {
	collectGarbage,
	ensureStore,
	listStores,
	openStore,
	storeDirectory,
	STORES_FOLDER
} from './store.ts';
export type {
	PreparedTrees,
	Snapshot,
	SnapshotRef,
	StoreWriter,
	TakenSnapshot
} from './snapshots.ts';
export {
	deleteSnapshot,
	listSnapshots,
	openSnapshot,
	openSnapshotRef,
	SNAPSHOT_REFS,
	snapshotRefOf,
	takeSnapshot
} from './snapshots.ts';
export type { SnapshotFile, SnapshotLines, TreeEntry } from './read-snapshot.ts';
export {
	generatedPaths,
	listSnapshotPaths,
	readSnapshotDiff,
	readSnapshotFile,
	readSnapshotLines
} from './read-snapshot.ts';
export type {
	DataDirectoryUnusable,
	FileIsBinary,
	FileLookupError,
	LinesError,
	PathIsDirectory,
	PathIsSubmodule,
	PathNotFound,
	SnapshotDiffError,
	SnapshotNotFound,
	StoreDamaged,
	StoreError,
	StoreNotFound
} from './store-error.ts';
export {
	describeLinesError,
	describeSnapshotDiffError,
	describeStoreError
} from './store-error.ts';
