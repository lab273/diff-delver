/**
 * Reading a snapshot: its diff, any file of either tree, the paths of a tree, and
 * which changed files the head tree marks as generated. Everything is read from
 * the store alone, so it works after the reviewed repository has changed, been
 * collected or been deleted. Paths are bytes to git and are passed to it on
 * stdin, never as arguments, so paths that are not UTF-8 work too.
 */
import { parseBlobId, type BlobId } from '#lib/core/blob-id.tiny.ts';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';
import {
	fileModeKind,
	parseFileMode,
	type FileMode,
	type FileModeKind
} from '#lib/core/file-mode.tiny.ts';
import { linesOf, looksBinary } from '#lib/core/file-text.ts';
import { parseLineCount, type LineCount } from '#lib/core/line-count.tiny.ts';
import { parseLineNumber, type LineNumber } from '#lib/core/line-number.tiny.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import { repoPathBytes, repoPathFromBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { Side } from '#lib/core/side.tiny.ts';
import type { TreeId } from '#lib/core/tree-id.tiny.ts';
import { readDiffDirect } from '../git/read-diff.ts';
import { runGit } from '../git/run-git.ts';
import type {
	FileLookupError,
	FileTooLarge,
	LinesError,
	SnapshotDiffError,
	StoreError
} from './store-error.ts';
import { withStoreLock } from './store-lock.ts';
import type { Snapshot } from './snapshots.ts';
import type { Store } from './store.ts';

/** A file of one of a snapshot's trees. */
export interface SnapshotFile {
	readonly path: RepoPath;
	readonly side: Side;
	readonly mode: FileMode;
	/** What the mode means: a regular or executable file, or a symbolic link, whose bytes are its target. */
	readonly kind: FileModeKind;
	readonly blob: BlobId;
	readonly size: ByteSize;
	/** Whether git would call it binary: a NUL byte in its first 8000 bytes. */
	readonly binary: boolean;
	readonly bytes: Uint8Array;
}

/** Some lines of a text file of a snapshot. */
export interface SnapshotLines {
	/** The lines asked for that exist, each with its number. */
	readonly lines: readonly { readonly number: LineNumber; readonly text: LineText }[];
	/** How many lines the whole file has. */
	readonly lineCount: LineCount;
}

/** One entry of a tree, for a file opener. */
export interface TreeEntry {
	readonly path: RepoPath;
	readonly mode: FileMode;
	readonly kind: FileModeKind;
}

function treeOf(snapshot: Snapshot, side: Side): TreeId {
	switch (side) {
		case 'old':
			return snapshot.base;
		case 'new':
			return snapshot.head;
	}
}

function damaged(snapshot: Snapshot, detail: string): StoreError {
	return { kind: 'StoreDamaged', store: snapshot.store.id, detail };
}

/** Runs a read with the store held, so garbage collection waits for it. */
function reading<T>(snapshot: Snapshot, read: () => Promise<T>): Promise<T> {
	return withStoreLock(snapshot.store.dir, 'shared', read);
}

/** The snapshot's diff, one entry per changed file, with the one fixed diff command. */
export function readSnapshotDiff(
	snapshot: Snapshot
): Promise<Result<readonly FileDiff[], SnapshotDiffError>> {
	return reading(snapshot, () =>
		readDiffDirect(snapshot.store.dir, snapshot.base, snapshot.head, snapshot.store.objectFormat)
	);
}

/**
 * git's diff between any two trees of a store, such as the heads of two
 * snapshots, with the one fixed diff command; nothing when they are the same tree.
 */
export function readTreeDiff(
	store: Store,
	from: TreeId,
	to: TreeId
): Promise<Result<readonly FileDiff[], SnapshotDiffError>> {
	if (from === to) return Promise.resolve(ok([]));
	return withStoreLock(store.dir, 'shared', () =>
		readDiffDirect(store.dir, from, to, store.objectFormat)
	);
}

type Entry =
	| {
			readonly kind: 'blob';
			readonly mode: FileMode;
			readonly blob: BlobId;
			readonly size: ByteSize;
	  }
	| { readonly kind: 'tree' }
	| { readonly kind: 'submodule' }
	| { readonly kind: 'missing' };

/** What is at a path of a tree, with one `cat-file` lookup of `<tree>:<path>`. */
async function lookUp(
	snapshot: Snapshot,
	tree: TreeId,
	path: RepoPath
): Promise<Result<Entry, StoreError>> {
	const input = Buffer.concat([Buffer.from(`${tree}:`), repoPathBytes(path), Buffer.of(0)]);
	const checked = await runGit({
		cwd: snapshot.store.dir,
		args: [
			'cat-file',
			'-Z',
			'--batch-check=%(objectmode) %(objecttype) %(objectname) %(objectsize)'
		],
		input
	});
	if (!checked.ok) return checked;
	const line = checked.value.stdout.toString('latin1').replace(/\0$/, '');
	if (line.endsWith(' missing')) return ok({ kind: 'missing' });
	if (line.endsWith(' submodule')) return ok({ kind: 'submodule' });
	const [modeText, type, id, sizeText] = line.split(' ');
	if (type === 'tree') return ok({ kind: 'tree' });
	const mode = parseFileMode(modeText ?? '');
	const blob = parseBlobId(id ?? '');
	const size = parseByteSize(Number(sizeText));
	if (type !== 'blob' || !mode.ok || !blob.ok || !size.ok) {
		return err(damaged(snapshot, `cat-file answered "${line}"`));
	}
	return ok({ kind: 'blob', mode: mode.value, blob: blob.value, size: size.value });
}

/** A file of one side of the snapshot by path, with its bytes. */
export function readSnapshotFile(
	snapshot: Snapshot,
	side: Side,
	path: RepoPath
): Promise<Result<SnapshotFile, FileLookupError>> {
	return reading(snapshot, async (): Promise<Result<SnapshotFile, FileLookupError>> => {
		const entry = await lookUp(snapshot, treeOf(snapshot, side), path);
		if (!entry.ok) return entry;
		switch (entry.value.kind) {
			case 'missing':
				return err({ kind: 'PathNotFound', side, path });
			case 'tree':
				return err({ kind: 'PathIsDirectory', side, path });
			case 'submodule':
				return err({ kind: 'PathIsSubmodule', side, path });
			case 'blob': {
				const { mode, blob, size } = entry.value;
				const content = await runGit({ cwd: snapshot.store.dir, args: ['cat-file', 'blob', blob] });
				if (!content.ok) return content;
				const bytes = new Uint8Array(content.value.stdout);
				return ok({
					path,
					side,
					mode,
					kind: fileModeKind(mode),
					blob,
					size,
					binary: looksBinary(bytes),
					bytes
				});
			}
		}
	});
}

/**
 * Lines `first` to `last` of a text file of one side, as many of them as the file
 * has, and how many lines it has in all. A binary file is `FileIsBinary`.
 */
export async function readSnapshotLines(
	snapshot: Snapshot,
	side: Side,
	path: RepoPath,
	first: LineNumber,
	last: LineNumber
): Promise<Result<SnapshotLines, LinesError>> {
	const file = await readSnapshotFile(snapshot, side, path);
	if (!file.ok) return file;
	if (file.value.binary) return err({ kind: 'FileIsBinary', side, path });
	const all = linesOf(file.value.bytes);
	const lines = all.slice(first - 1, Math.max(first - 1, last)).map((text, i) => {
		const number = parseLineNumber(first + i);
		if (!number.ok) throw new RangeError('A line number past a valid one is valid');
		return { number: number.value, text };
	});
	const lineCount = parseLineCount(all.length);
	if (!lineCount.ok) throw new RangeError('A list length is a line count');
	return ok({ lines, lineCount: lineCount.value });
}

/** What is at a path of one side: a file with its size, a folder, a submodule, or nothing. */
export type SnapshotEntry =
	| { readonly kind: 'file'; readonly size: ByteSize }
	| { readonly kind: 'folder' }
	| { readonly kind: 'submodule' }
	| { readonly kind: 'missing' };

/** What is at a path of one side, from one lookup, without reading a file's bytes. */
export function snapshotEntry(
	snapshot: Snapshot,
	side: Side,
	path: RepoPath
): Promise<Result<SnapshotEntry, StoreError>> {
	return reading(snapshot, async (): Promise<Result<SnapshotEntry, StoreError>> => {
		const entry = await lookUp(snapshot, treeOf(snapshot, side), path);
		if (!entry.ok) return entry;
		switch (entry.value.kind) {
			case 'blob':
				return ok({ kind: 'file', size: entry.value.size });
			case 'tree':
				return ok({ kind: 'folder' });
			case 'submodule':
			case 'missing':
				return ok({ kind: entry.value.kind });
		}
	});
}

/**
 * Like `readSnapshotLines`, for a file of at most `maxBytes`: a larger one is
 * `FileTooLarge`, from the size git already knows, before any of it is read.
 */
export async function readSnapshotLinesWithin(
	snapshot: Snapshot,
	side: Side,
	path: RepoPath,
	first: LineNumber,
	last: LineNumber,
	maxBytes: ByteSize
): Promise<Result<SnapshotLines, LinesError | FileTooLarge>> {
	const entry = await snapshotEntry(snapshot, side, path);
	if (!entry.ok) return entry;
	if (entry.value.kind === 'file' && entry.value.size > maxBytes) {
		return err({ kind: 'FileTooLarge', side, path, size: entry.value.size, limit: maxBytes });
	}
	return readSnapshotLines(snapshot, side, path, first, last);
}

/** Every file, symbolic link and submodule of one side's tree, sorted as git sorts them. */
export function listSnapshotPaths(
	snapshot: Snapshot,
	side: Side
): Promise<Result<readonly TreeEntry[], StoreError>> {
	return reading(snapshot, async (): Promise<Result<readonly TreeEntry[], StoreError>> => {
		const listed = await runGit({
			cwd: snapshot.store.dir,
			args: ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', treeOf(snapshot, side)]
		});
		if (!listed.ok) return listed;
		const out = listed.value.stdout;
		const entries: TreeEntry[] = [];
		for (let at = 0; at < out.length;) {
			const end = out.indexOf(0, at);
			const record = out.subarray(at, end === -1 ? out.length : end);
			at = end === -1 ? out.length : end + 1;
			const tab = record.indexOf(0x09);
			const mode = parseFileMode(record.subarray(0, 6).toString('latin1'));
			const path = repoPathFromBytes(record.subarray(tab + 1));
			if (tab === -1 || !mode.ok || !path.ok) {
				return err(damaged(snapshot, `ls-tree gave "${record.toString('latin1')}"`));
			}
			entries.push({ path: path.value, mode: mode.value, kind: fileModeKind(mode.value) });
		}
		return ok(entries);
	});
}

/** The values of `linguist-generated` that mark a file generated, as GitHub's linguist reads them. */
const GENERATED_VALUES = new Set(['set', 'true']);

/**
 * Which of the given paths the head tree's `.gitattributes` files mark
 * `linguist-generated` (DESIGN 4.2), for the model's `autoIgnore`. Only the
 * snapshot's own attributes count: not the working tree's, the reviewed
 * repository's `info/attributes` or the reviewer's global attributes.
 */
export function generatedPaths(
	snapshot: Snapshot,
	paths: readonly RepoPath[]
): Promise<Result<ReadonlySet<RepoPath>, StoreError>> {
	return reading(snapshot, async (): Promise<Result<ReadonlySet<RepoPath>, StoreError>> => {
		if (paths.length === 0) return ok(new Set());
		const input = Buffer.concat(paths.flatMap((path) => [repoPathBytes(path), Buffer.of(0)]));
		const checked = await runGit({
			cwd: snapshot.store.dir,
			args: [
				'-c',
				'core.attributesFile=',
				'check-attr',
				`--source=${snapshot.head}`,
				'-z',
				'--stdin',
				'linguist-generated'
			],
			input
		});
		if (!checked.ok) return checked;
		const out = checked.value.stdout;
		const fields: Buffer[] = [];
		for (let at = 0; at < out.length;) {
			const end = out.indexOf(0, at);
			if (end === -1) break;
			fields.push(out.subarray(at, end));
			at = end + 1;
		}
		const generated = new Set<RepoPath>();
		for (let i = 0; i + 2 < fields.length; i += 3) {
			const value = fields[i + 2]?.toString('utf8') ?? '';
			if (!GENERATED_VALUES.has(value)) continue;
			const path = repoPathFromBytes(fields[i] ?? Buffer.alloc(0));
			if (!path.ok) return err(damaged(snapshot, 'check-attr gave a path that is not valid'));
			generated.add(path.value);
		}
		return ok(generated);
	});
}
