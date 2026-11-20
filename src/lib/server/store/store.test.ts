import { randomIds } from '#lib/server/system.ts';
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseLineNumber, type LineNumber } from '#lib/core/line-number.tiny.ts';
import type { ObjectFormat } from '#lib/core/object-format.ts';
import { escapedRepoPath, repoPathFromBytes } from '#lib/core/path-bytes.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRepositoryName, type RepositoryName } from '#lib/core/repository-name.tiny.ts';
import { ok } from '#lib/core/result.ts';
import { parseSnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import type { TreeId } from '#lib/core/tree-id.tiny.ts';
import {
	awkwardChanges,
	oddPathBytes,
	pathBytes,
	sha256Repository
} from '../../../../tests/support/diff-fixtures.ts';
import { listDirectory, listingsAround } from '../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../tests/support/git-repo.ts';
import { readDiff } from '../git/read-diff.ts';
import { runGit, runGitText } from '../git/run-git.ts';
import {
	collectGarbage,
	deleteSnapshot,
	describeLinesError,
	describeSnapshotDiffError,
	describeStoreError,
	ensureStore,
	generatedPaths,
	listSnapshotPaths,
	listSnapshots,
	listStores,
	openSnapshot,
	openSnapshotRef,
	openStore,
	readSnapshotDiff,
	readSnapshotFile,
	readSnapshotLines,
	removeStaleFolders,
	snapshotRefOf,
	storeDirectory,
	takeSnapshot,
	type LinesError,
	type Snapshot,
	type Store,
	type StoreError,
	type TakenSnapshot
} from './index.ts';

function storeId(text = 'test-store'): StoreId {
	const id = parseStoreId(text);
	if (!id.ok) throw new Error(`bad store id ${text}`);
	return id.value;
}

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(`bad path ${text}`);
	return parsed.value;
}

function repositoryName(text: string): RepositoryName {
	const parsed = parseRepositoryName(text);
	if (!parsed.ok) throw new Error('bad repository name');
	return parsed.value;
}

function line(n: number): LineNumber {
	const parsed = parseLineNumber(n);
	if (!parsed.ok) throw new Error('bad line');
	return parsed.value;
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
	if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
	return result.value;
}

async function objectsOf(repo: GitRepo): Promise<AbsolutePath> {
	return absolutePath(
		(await repo.git('rev-parse', '--path-format=absolute', '--git-path', 'objects')).trim()
	);
}

async function store(format: ObjectFormat = 'sha1', id = storeId()): Promise<Store> {
	return value(
		await ensureStore(await tempDirectory(), id, format, repositoryName('/somewhere/repo'))
	);
}

/** A snapshot of two trees of a repository, copied from its object directory. */
async function snapshotOf(
	target: Store,
	repo: GitRepo,
	base: TreeId,
	head: TreeId
): Promise<TakenSnapshot> {
	const copyFrom = await objectsOf(repo);
	return value(
		await takeSnapshot(target, randomIds.snapshotId(), () =>
			Promise.resolve(ok({ base, head, copyFrom }))
		)
	);
}

/** Makes every object file of the store look `hours` old, as if written that long ago. */
async function ageObjects(target: Store, hours: number): Promise<void> {
	const then = new Date(Date.now() - hours * 3_600_000);
	const objects = join(target.dir, 'objects');
	for (const entry of await readdir(objects, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), then, then);
	}
}

/** Writes a blob into the store that no snapshot refers to. */
async function unpinnedBlob(target: Store, content: string): Promise<string> {
	return value(
		await runGitText({ cwd: target.dir, args: ['hash-object', '-w', '--stdin'], input: content })
	);
}

async function hasObject(target: Store, id: string): Promise<boolean> {
	return (await runGit({ cwd: target.dir, args: ['cat-file', '-e', id] })).ok;
}

describe('the snapshot store', () => {
	it('holds both trees whole, so the diff and every file read the same after the repository is gone', async () => {
		const repo = await useFixture(awkwardChanges);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const expected = value(await readDiff(repo.dir, base.tree, head.tree));
		const target = await store();
		const { snapshot, copied } = await snapshotOf(target, repo, base.tree, head.tree);
		expect(copied).toBeGreaterThan(20);
		await rm(repo.dir, { recursive: true, force: true });

		expect(value(await readSnapshotDiff(snapshot))).toEqual(expected);
		const file = value(await readSnapshotFile(snapshot, 'new', path('modified.txt')));
		expect(Buffer.from(file.bytes).toString('utf8')).toBe(
			'one\n\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n'
		);
		expect(file).toMatchObject({ mode: '100644', kind: 'regular', size: 53, binary: false });
		const old = value(await readSnapshotFile(snapshot, 'old', path('deleted.txt')));
		expect(Buffer.from(old.bytes).toString('utf8')).toBe('gone\nfor\ngood\n');
		// The snapshot is complete without the repository: git finds nothing missing.
		const check = await runGit({
			cwd: target.dir,
			args: ['rev-list', '--objects', '--missing=print', snapshot.base, snapshot.head]
		});
		expect(value(check).stdout.toString('utf8')).not.toMatch(/^\?/m);
	});

	it('never writes to the repository it copies from', async () => {
		const repo = await useFixture(awkwardChanges);
		await repo.git('gc', '--quiet');
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const target = await store();
		const { before, after } = await listingsAround([repo.dir], () =>
			snapshotOf(target, repo, base.tree, head.tree)
		);
		expect(after).toEqual(before);
	});

	it('copies only what it does not have, so snapshots of one repository share what did not change', async () => {
		const repo = await useFixture(awkwardChanges);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const target = await store();
		const first = await snapshotOf(target, repo, base.tree, head.tree);
		const again = await snapshotOf(target, repo, base.tree, head.tree);
		expect(again.copied).toBe(0);
		expect(again.snapshot.id).not.toBe(first.snapshot.id);
		await repo.write('modified.txt', 'changed again\n');
		const next = await repo.commit('next');
		const third = await snapshotOf(target, repo, head.tree, next.tree);
		// The new blob and the new root tree; every other object was there already.
		expect(third.copied).toBe(2);
	});

	it('reads binary files, symbolic links and lines, and says plainly what is not a file', async () => {
		const repo = await useFixture(awkwardChanges);
		const { snapshot } = await snapshotOf(
			await store(),
			repo,
			(await repo.snapshot('base')).tree,
			(await repo.snapshot('head')).tree
		);
		const binary = value(await readSnapshotFile(snapshot, 'new', path('binary.bin')));
		expect(binary).toMatchObject({ binary: true, size: 6 });
		expect([...binary.bytes]).toEqual([0, 1, 2, 4, 0, 255]);
		const link = value(await readSnapshotFile(snapshot, 'new', path('becomes-link.txt')));
		expect(link).toMatchObject({ mode: '120000', kind: 'symlink', binary: false });
		expect(Buffer.from(link.bytes).toString('utf8')).toBe('modified.txt');
		const executable = value(await readSnapshotFile(snapshot, 'new', path('mode.sh')));
		expect(executable.kind).toBe('executable');

		const lines = value(
			await readSnapshotLines(snapshot, 'new', path('crlf.txt'), line(2), line(9))
		);
		expect(lines).toEqual({
			lines: [
				{ number: 2, text: 'TWO\r' },
				{ number: 3, text: 'three\r' }
			],
			lineCount: 3
		});
		const lastLine = value(
			await readSnapshotLines(snapshot, 'new', path('no-newline.txt'), line(2), line(2))
		);
		expect(lastLine.lines).toEqual([{ number: 2, text: 'c' }]);

		const errors = await Promise.all([
			readSnapshotLines(snapshot, 'new', path('binary.bin'), line(1), line(1)),
			readSnapshotLines(snapshot, 'new', path('odd names'), line(1), line(1)),
			readSnapshotLines(snapshot, 'new', path('vendor/lib'), line(1), line(1)),
			readSnapshotLines(snapshot, 'new', path('deleted.txt'), line(1), line(1)),
			readSnapshotLines(snapshot, 'old', path('added.txt/below'), line(1), line(1))
		]);
		const kinds = errors.map((r) => (r.ok ? 'ok' : r.error.kind));
		expect(kinds).toEqual([
			'FileIsBinary',
			'PathIsDirectory',
			'PathIsSubmodule',
			'PathNotFound',
			'PathNotFound'
		]);
		for (const result of errors) {
			if (!result.ok) expect(describeLinesError(result.error)).toMatch(/\.$/);
		}
	});

	it('lists the paths of either tree, with submodules and links, for a file opener', async () => {
		const repo = await useFixture(awkwardChanges);
		const { snapshot } = await snapshotOf(
			await store(),
			repo,
			(await repo.snapshot('base')).tree,
			(await repo.snapshot('head')).tree
		);
		const listed = value(await listSnapshotPaths(snapshot, 'new'));
		const kinds = new Map(listed.map((entry) => [entry.path, entry.kind]));
		expect(kinds.get(path('vendor/lib'))).toBe('submodule');
		expect(kinds.get(path('becomes-link.txt'))).toBe('symlink');
		expect(kinds.get(path('odd names/new\nline.txt'))).toBe('regular');
		expect(kinds.has(path('deleted.txt'))).toBe(false);
		expect(
			value(await listSnapshotPaths(snapshot, 'old')).some((e) => e.path === 'deleted.txt')
		).toBe(true);
	});

	it('reads paths that are not UTF-8 exactly', async () => {
		const repo = await useFixture(oddPathBytes);
		const { snapshot } = await snapshotOf(
			await store(),
			repo,
			(await repo.snapshot('base')).tree,
			(await repo.snapshot('head')).tree
		);
		const listed = value(await listSnapshotPaths(snapshot, 'new'));
		expect(listed.map((entry) => escapedRepoPath(entry.path))).toEqual([
			'caf\\\\xE9.txt',
			'caf\\xE8.txt',
			'caf\\xE9.txt',
			'dir\\xFF/inner.txt'
		]);
		const odd = value(repoPathFromBytes(pathBytes('dir', 0xff, '/inner.txt')));
		const file = value(await readSnapshotFile(snapshot, 'new', odd));
		expect(Buffer.from(file.bytes).toString('utf8')).toBe('one\ntwo\n');
		const generated = value(
			await generatedPaths(
				snapshot,
				listed.map((entry) => entry.path)
			)
		);
		expect(generated.size).toBe(0);
	});

	it("finds the files the head tree's attributes mark generated, and nothing from elsewhere", async () => {
		const repo = await emptyRepo();
		await repo.write('src/app.ts', 'one\n');
		const base = await repo.commit('base');
		await repo.write(
			'.gitattributes',
			'gen/** linguist-generated\n*.min.js linguist-generated=true\nkeep.min.js -linguist-generated\nno.js linguist-generated=false\n'
		);
		for (const name of ['gen/a.ts', 'x.min.js', 'keep.min.js', 'no.js', 'src/app.ts']) {
			await repo.write(name, 'two\n');
		}
		await repo.write('src/.gitattributes', 'app.ts linguist-generated\n');
		const head = await repo.commit('head');
		// Attributes outside the head tree are not the snapshot's.
		await repo.write('.git/info/attributes', 'no.js linguist-generated\n');
		await repo.write('.gitattributes', '* linguist-generated\n');
		const { snapshot } = await snapshotOf(await store(), repo, base.tree, head.tree);
		const changed = value(await readSnapshotDiff(snapshot)).map((file) => file.path);
		const generated = value(await generatedPaths(snapshot, changed));
		expect([...generated].toSorted()).toEqual(['gen/a.ts', 'src/app.ts', 'x.min.js']);
	});

	it('keeps a SHA-256 repository in a SHA-256 store', async () => {
		const repo = await useFixture(sha256Repository);
		const target = await store('sha256', storeId('sha256-store'));
		expect(target.objectFormat).toBe('sha256');
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const { snapshot } = await snapshotOf(target, repo, base.tree, head.tree);
		const [file] = value(await readSnapshotDiff(snapshot));
		expect(file?.new?.blob).toHaveLength(64);
		expect(
			value(await openStore(absolutePath(join(target.dir, '..', '..')), target.id)).objectFormat
		).toBe('sha256');
	});

	it('copies from a repository whose path holds quotes, backslashes, colons and a newline', async () => {
		const outer = await emptyRepo();
		const repo = await GitRepo.init(absolutePath(join(outer.dir, 'odd "dir"\\:\nname')));
		await repo.write('t.txt', 'one\n');
		const base = await repo.commit('base');
		await repo.write('t.txt', 'two\n');
		const head = await repo.commit('head');
		const { snapshot } = await snapshotOf(await store(), repo, base.tree, head.tree);
		expect(value(await readSnapshotDiff(snapshot)).map((f) => f.path)).toEqual(['t.txt']);
	});

	it('opens, lists and deletes snapshots by id, and collecting garbage frees only what nothing uses', async () => {
		const repo = await useFixture(awkwardChanges);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const target = await store();
		const kept = (await snapshotOf(target, repo, base.tree, head.tree)).snapshot;
		await repo.write('only-in-dropped.txt', 'nothing else has this\n');
		const extra = await repo.commit('extra');
		const dropped = (await snapshotOf(target, repo, head.tree, extra.tree)).snapshot;
		const dataDirectory = absolutePath(join(target.dir, '..', '..'));

		expect(value(await openSnapshotRef(dataDirectory, snapshotRefOf(kept)))).toEqual(kept);
		const listed = value(await listSnapshots(target)).map((s) => s.id);
		expect(listed.toSorted()).toEqual([kept.id, dropped.id].toSorted());

		value(await deleteSnapshot(target, dropped.id));
		const again = await deleteSnapshot(target, dropped.id);
		expect(again.ok ? 'deleted twice' : again.error.kind).toBe('SnapshotNotFound');
		const opened = await openSnapshot(target, dropped.id);
		expect(opened.ok ? 'opened' : opened.error.kind).toBe('SnapshotNotFound');
		expect(value(await listSnapshots(target)).map((s) => s.id)).toEqual([kept.id]);

		expect(await hasObject(target, dropped.head)).toBe(true);
		await ageObjects(target, 2);
		value(await collectGarbage(target));
		expect(await hasObject(target, dropped.head)).toBe(false);
		expect(await hasObject(target, kept.head)).toBe(true);
		expect(value(await readSnapshotDiff(kept))).toEqual(
			value(await readDiff(repo.dir, base.tree, head.tree))
		);
	});

	it('keeps objects no snapshot pins yet for an hour, so another process taking one keeps them', async () => {
		const target = await store();
		const old = await unpinnedBlob(target, 'written two hours ago, never pinned\n');
		await ageObjects(target, 2);
		const fresh = await unpinnedBlob(target, 'written just now, not pinned yet\n');
		value(await collectGarbage(target));
		expect(await hasObject(target, fresh)).toBe(true);
		expect(await hasObject(target, old)).toBe(false);
	});

	it('removes folders a crash left behind once they are an hour old, and nothing else', async () => {
		const dataDirectory = await tempDirectory();
		const stores = join(dataDirectory, 'stores');
		const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
		for (const name of ['.new-old', '.new-fresh', 'kept-old.git']) {
			await mkdir(join(stores, name, 'objects'), { recursive: true });
		}
		await utimes(join(stores, '.new-old'), twoHoursAgo, twoHoursAgo);
		await utimes(join(stores, 'kept-old.git'), twoHoursAgo, twoHoursAgo);
		value(await ensureStore(dataDirectory, storeId(), 'sha1', repositoryName('/repo')));
		expect((await readdir(stores)).toSorted()).toEqual(
			['.new-fresh', 'kept-old.git', `${storeId()}.git`].toSorted()
		);

		const temporary = await tempDirectory();
		for (const name of ['diff-delver-index-old', 'diff-delver-index-fresh', 'other-old']) {
			await mkdir(join(temporary, name, 'repo'), { recursive: true });
		}
		await utimes(join(temporary, 'diff-delver-index-old'), twoHoursAgo, twoHoursAgo);
		await utimes(join(temporary, 'other-old'), twoHoursAgo, twoHoursAgo);
		await removeStaleFolders(temporary, 'diff-delver-index-');
		expect((await readdir(temporary)).toSorted()).toEqual(['diff-delver-index-fresh', 'other-old']);
	});

	it('is created once even when many snapshots make it at the same time, and is listed', async () => {
		const dataDirectory = await tempDirectory();
		const made = await Promise.all(
			Array.from({ length: 6 }, () =>
				ensureStore(dataDirectory, storeId(), 'sha1', repositoryName('/repo/path'))
			)
		);
		const dirs = new Set(made.map((result) => value(result).dir));
		expect(dirs.size).toBe(1);
		const listed = value(await listStores(dataDirectory));
		expect(listed.map((s) => [s.id, s.repository, s.objectFormat])).toEqual([
			['test-store', '/repo/path', 'sha1']
		]);
		// Nothing is left behind from the stores that lost the race.
		const entries = await listDirectory(join(dataDirectory, 'stores'));
		expect(entries.filter((e) => e.includes('.new-'))).toEqual([]);
	});

	it('takes, reads, deletes and collects at the same time without losing a snapshot', async () => {
		const repo = await useFixture(awkwardChanges);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const target = await store();
		const doomed = (await snapshotOf(target, repo, base.tree, head.tree)).snapshot;
		const trees: TreeId[] = [];
		for (let i = 0; i < 4; i += 1) {
			await repo.write(`parallel-${String(i)}.txt`, `file ${String(i)}\n`);
			trees.push((await repo.commit(`parallel ${String(i)}`)).tree);
		}
		const expected = value(await readDiff(repo.dir, base.tree, head.tree));
		const [taken, read, deleted, collected] = await Promise.all([
			Promise.all(trees.map((tree) => snapshotOf(target, repo, base.tree, tree))),
			readSnapshotDiff(doomed),
			deleteSnapshot(target, doomed.id),
			collectGarbage(target)
		]);
		expect(value(read)).toEqual(expected);
		expect(deleted.ok && collected.ok).toBe(true);
		value(await collectGarbage(target));
		const remaining = value(await listSnapshots(target));
		expect(remaining).toHaveLength(4);
		for (const snapshot of taken.map((t) => t.snapshot)) {
			const diff = value(await readSnapshotDiff(snapshot));
			expect(diff.length).toBeGreaterThan(20);
		}
	});

	it('says plainly when the data directory cannot be written, and when a store or snapshot is gone', async () => {
		const blocker = join(await tempDirectory(), 'a-file');
		await writeFile(blocker, 'not a directory');
		const unusable = await ensureStore(
			absolutePath(blocker),
			storeId(),
			'sha1',
			repositoryName('/repo')
		);
		expect(unusable.ok ? 'made' : unusable.error.kind).toBe('DataDirectoryUnusable');
		// Something that is not a store where the store goes: the store cannot be put in place.
		const blocked = await tempDirectory();
		const blockedId = storeId();
		await mkdir(join(blocked, 'stores'));
		await writeFile(storeDirectory(blocked, blockedId), 'not a store');
		const notPlaced = await ensureStore(blocked, blockedId, 'sha1', repositoryName('/repo'));
		expect(notPlaced.ok ? 'made' : notPlaced.error).toMatchObject({
			kind: 'DataDirectoryUnusable',
			directory: storeDirectory(blocked, blockedId)
		});
		const dataDirectory = await tempDirectory();
		const id = value(parseSnapshotId('0'.repeat(32)));
		const missingStore = await openSnapshotRef(dataDirectory, {
			store: storeId('gone'),
			snapshot: id
		});
		expect(missingStore.ok ? 'found' : missingStore.error.kind).toBe('StoreNotFound');
		const target = value(
			await ensureStore(dataDirectory, storeId(), 'sha1', repositoryName('/repo'))
		);
		const missingSnapshot = await openSnapshot(target, id);
		expect(missingSnapshot.ok ? 'found' : missingSnapshot.error.kind).toBe('SnapshotNotFound');
		await mkdir(join(dataDirectory, 'stores', 'NOT-A-STORE.git'));
		expect(value(await listStores(dataDirectory))).toHaveLength(1);

		const errors: readonly StoreError[] = [
			unusable.ok ? { kind: 'GitNotFound' } : unusable.error,
			{ kind: 'StoreNotFound', store: storeId() },
			{ kind: 'SnapshotNotFound', store: storeId(), snapshot: id },
			{ kind: 'StoreDamaged', store: storeId(), detail: 'odd output' }
		];
		for (const error of errors) {
			expect(describeStoreError(error)).toMatch(/\. [A-Z].*\.$/);
			expect(describeSnapshotDiffError(error)).toBe(describeStoreError(error));
			const asLines: LinesError = error;
			expect(describeLinesError(asLines)).toBe(describeStoreError(error));
		}
	});

	it('reads a snapshot it can no longer find as SnapshotNotFound, not as a git failure', async () => {
		const repo = await useFixture(awkwardChanges);
		const target = await store();
		const taken = await snapshotOf(
			target,
			repo,
			(await repo.snapshot('base')).tree,
			(await repo.snapshot('head')).tree
		);
		await runGitText({
			cwd: target.dir,
			args: ['update-ref', '-d', `refs/diff-delver/snapshots/${taken.snapshot.id}`]
		});
		const opened = await openSnapshot(target, taken.snapshot.id);
		expect(opened.ok ? 'opened' : opened.error.kind).toBe('SnapshotNotFound');
		const stale: Snapshot = taken.snapshot;
		// A snapshot already open still reads until its objects are collected.
		expect(value(await readSnapshotDiff(stale)).length).toBeGreaterThan(0);
	});
});
