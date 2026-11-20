import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapedRepoPath, repoPathFromBytes } from '#lib/core/path-bytes.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import {
	defineFixture,
	emptyRepo,
	tempDirectory,
	useFixture
} from '../../../../../tests/support/fixture-repos.ts';
import { pathBytes } from '../../../../../tests/support/diff-fixtures.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import { changesOf, take, value } from '../../../../../tests/support/git-source-helpers.ts';
import { reviewer, treeGitWouldCommit } from '../../../../../tests/support/reviewer-git.ts';
import { listSnapshotPaths, readSnapshotDiff, readSnapshotFile } from '../../store/index.ts';
import {
	describeGitSourceError,
	locateRepository,
	snapshotGitSource,
	type GitSourceError
} from './index.ts';

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

const lines = (prefix: string, count: number): string =>
	Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}\n`).join('');

/** A committed base and a working tree with every kind of uncommitted change. */
const workingTreeChanges = defineFixture('working-tree-changes', async (repo) => {
	await repo.write('.gitignore', '*.log\nbuild/\n');
	await repo.write('tracked.txt', 'one\n');
	await repo.write('staged.txt', 'one\n');
	await repo.write('deleted.txt', 'gone\n');
	await repo.write('becomes-dir', 'a file\n');
	await repo.write('moved-from.txt', lines('moved line', 10));
	await repo.write('script.sh', '#!/bin/sh\n');
	await repo.commit('base', 'base');

	await repo.write('tracked.txt', 'one\ntwo\n');
	await repo.write('staged.txt', 'one\nstaged\n');
	await repo.git('add', 'staged.txt');
	await repo.write('staged.txt', 'one\nstaged\nthen edited\n');
	await repo.remove('deleted.txt');
	await repo.remove('becomes-dir');
	await repo.write('becomes-dir/inner.txt', 'now a directory\n');
	await repo.move('moved-from.txt', 'moved-to.txt');
	await repo.setExecutable('script.sh', true);
	await repo.write('new/deeper/untracked.txt', 'untracked, in untracked directories\n');
	await repo.write('debug.log', 'ignored by .gitignore\n');
	await repo.write('build/out.js', 'ignored by .gitignore\n');
	await repo.write('.git/info/exclude', 'private.txt\n');
	await repo.write('private.txt', 'ignored by info/exclude\n');
	await repo.symlink('broken-link', 'does/not/exist');
	await repo.symlink('outside-link', '/etc/hostname');
	const nested = await GitRepo.init(absolutePath(join(repo.dir, 'nested')));
	await nested.write('n.txt', 'a repository inside the working tree\n');
	await nested.commit('nested');
});

/** History with a root commit, a feature branch, a merge and a branch with no common history. */
const history = defineFixture('history', async (repo) => {
	await repo.write('a.txt', 'one\n');
	await repo.commit('root', 'root');
	await repo.write('a.txt', 'two\n');
	await repo.commit('second', 'second');
	await repo.git('checkout', '--quiet', '-b', 'feature');
	await repo.write('f.txt', 'feature\n');
	await repo.commit('f1');
	await repo.write('f.txt', 'feature, more\n');
	await repo.commit('f2');
	await repo.git('checkout', '--quiet', 'main');
	await repo.write('main.txt', 'main moved on\n');
	await repo.commit('main later');
	await repo.git('checkout', '--quiet', '-b', 'side');
	await repo.write('side.txt', 'from the side branch\n');
	await repo.commit('side');
	await repo.git('checkout', '--quiet', 'main');
	await repo.git('merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
	await repo.git('tag', 'merge');
	await repo.git('checkout', '--quiet', '--orphan', 'lonely');
	await repo.commit('unrelated');
	await repo.git('checkout', '--quiet', 'main');
});

describe('a working-tree snapshot', () => {
	it('holds what git would commit: staged and unstaged changes, untracked files, no ignored ones', async () => {
		const repo = await useFixture(workingTreeChanges);
		const who = await reviewer();
		const taken = value(await take(repo.dir, 'working-tree', who));
		expect(await changesOf(taken.snapshot)).toEqual({
			'becomes-dir': 'deleted',
			'becomes-dir/inner.txt': 'added',
			'broken-link': 'added',
			'deleted.txt': 'deleted',
			'moved-to.txt': 'renamed from moved-from.txt',
			nested: 'added',
			'new/deeper/untracked.txt': 'added',
			'outside-link': 'added',
			'script.sh': 'modified',
			'staged.txt': 'modified',
			'tracked.txt': 'modified'
		});
		expect(taken.snapshot.head).toBe(await treeGitWouldCommit(repo.dir, who));
		expect(taken.baseCommit).toBe((await repo.snapshot('base')).commit);
		expect(taken.headCommit).toBeUndefined();
		expect(taken.leftOut).toEqual([]);

		const staged = value(await readSnapshotFile(taken.snapshot, 'new', path('staged.txt')));
		expect(Buffer.from(staged.bytes).toString('utf8')).toBe('one\nstaged\nthen edited\n');
		const outside = value(await readSnapshotFile(taken.snapshot, 'new', path('outside-link')));
		expect(outside.kind).toBe('symlink');
		expect(Buffer.from(outside.bytes).toString('utf8')).toBe('/etc/hostname');
		const kinds = new Map(
			value(await listSnapshotPaths(taken.snapshot, 'new')).map((e) => [e.path, e.kind])
		);
		expect(kinds.get(path('nested'))).toBe('submodule');
		expect(kinds.get(path('script.sh'))).toBe('executable');
	});

	it('stays readable when the repository is deleted', async () => {
		const repo = await useFixture(workingTreeChanges);
		const taken = value(await take(repo.dir, 'working-tree', await reviewer()));
		const before = value(await readSnapshotDiff(taken.snapshot));
		await rm(repo.dir, { recursive: true, force: true });
		expect(value(await readSnapshotDiff(taken.snapshot))).toEqual(before);
		const file = value(await readSnapshotFile(taken.snapshot, 'old', path('deleted.txt')));
		expect(Buffer.from(file.bytes).toString('utf8')).toBe('gone\n');
	});

	it('copies nothing the second time when nothing changed, and only what changed after an edit', async () => {
		const repo = await useFixture(workingTreeChanges);
		const who = await reviewer();
		const dataDirectory = await tempDirectory();
		const first = value(await take(repo.dir, 'working-tree', who, { dataDirectory }));
		const second = value(await take(repo.dir, 'working-tree', who, { dataDirectory }));
		expect(first.copied).toBeGreaterThan(0);
		expect(second.copied).toBe(0);
		expect(second.snapshot.head).toBe(first.snapshot.head);
		expect(second.snapshot.store.dir).toBe(first.snapshot.store.dir);
		await repo.write('tracked.txt', 'one\ntwo\nthree\n');
		const third = value(await take(repo.dir, 'working-tree', who, { dataDirectory }));
		expect(third.snapshot.head).not.toBe(first.snapshot.head);
		expect(third.copied).toBe(0);
	});

	it('works in a repository with no commits yet, against the empty tree', async () => {
		const repo = await emptyRepo();
		await repo.write('first.txt', 'the very first file\n');
		const taken = value(await take(repo.dir, 'working-tree', await reviewer()));
		expect(await changesOf(taken.snapshot)).toEqual({ 'first.txt': 'added' });
		expect(taken.baseCommit).toBeUndefined();
		const staged = value(await take(repo.dir, 'staged', await reviewer()));
		expect(await changesOf(staged.snapshot)).toEqual({});
		const commit = await take(repo.dir, 'HEAD', await reviewer());
		expect(commit.ok ? 'taken' : commit.error.kind).toBe('NoCommitsYet');
	});

	it('compares with the checked-out commit when HEAD is detached', async () => {
		const repo = await useFixture(history);
		await repo.git('checkout', '--quiet', '--detach', 'second');
		await repo.write('a.txt', 'edited on a detached head\n');
		const taken = value(await take(repo.dir, 'working-tree', await reviewer()));
		expect(await changesOf(taken.snapshot)).toEqual({ 'a.txt': 'modified' });
		expect(taken.baseCommit).toBe((await repo.snapshot('second')).commit);
	});

	it('leaves out what git cannot add, and says so', async () => {
		const repo = await useFixture(workingTreeChanges);
		await GitRepo.init(absolutePath(join(repo.dir, 'empty-nested')));
		await repo.write('unreadable.txt', 'secret\n');
		await chmod(join(repo.dir, 'unreadable.txt'), 0o000);
		const taken = value(await take(repo.dir, 'working-tree', await reviewer()));
		await chmod(join(repo.dir, 'unreadable.txt'), 0o644);
		const changes = await changesOf(taken.snapshot);
		expect(changes['tracked.txt']).toBe('modified');
		expect(changes['unreadable.txt']).toBeUndefined();
		expect(changes['empty-nested']).toBeUndefined();
		expect(taken.leftOut.join('\n')).toMatch(/unreadable\.txt/);
		expect(taken.leftOut.join('\n')).toMatch(/empty-nested/);
	});

	it('keeps paths that are not UTF-8 exact', async () => {
		const repo = await emptyRepo();
		await repo.write('plain.txt', 'one\n');
		await repo.commit('base');
		await repo.writeRaw(pathBytes('caf', 0xe9, '.txt'), 'latin-1 name\n');
		await repo.writeRaw(pathBytes('dir', 0xff, '/inner.txt'), 'odd directory\n');
		const taken = value(await take(repo.dir, 'working-tree', await reviewer()));
		expect(Object.keys(await changesOf(taken.snapshot))).toEqual([
			'caf\\xE9.txt',
			'dir\\xFF/inner.txt'
		]);
		const odd = value(repoPathFromBytes(pathBytes('dir', 0xff, '/inner.txt')));
		const file = value(await readSnapshotFile(taken.snapshot, 'new', odd));
		expect(Buffer.from(file.bytes).toString('utf8')).toBe('odd directory\n');
		expect(escapedRepoPath(file.path)).toBe('dir\\xFF/inner.txt');
	});

	it('holds a very large file whole', async () => {
		const repo = await emptyRepo();
		await repo.commit('empty');
		const big = Buffer.alloc(24 * 1024 * 1024, 'large file line\n');
		await repo.write('big.txt', big);
		const taken = value(await take(repo.dir, 'working-tree', await reviewer()));
		const file = value(await readSnapshotFile(taken.snapshot, 'new', path('big.txt')));
		expect(file.size).toBe(big.length);
		expect(Buffer.from(file.bytes).equals(big)).toBe(true);
	});

	it('holds a whole version of a file that changes while the snapshot is taken, or says it was changing', async () => {
		const repo = await emptyRepo();
		await repo.write('busy.txt', 'version 0\n');
		await repo.commit('base');
		const versions = Array.from(
			{ length: 50 },
			(_, i) => `version ${String(i)}\n${'x'.repeat(i * 500)}\n`
		);
		const editing = { saving: true };
		let saves = 0;
		// An editor saving as fast as it can: a temporary file, renamed over the real one.
		const editor = (async () => {
			for (let i = 0; editing.saving || saves < 20; i = (i + 1) % versions.length) {
				const tmp = join(repo.dir, `.busy.txt.${String(i)}.tmp`);
				await writeFile(tmp, versions[i] ?? '');
				await rename(tmp, join(repo.dir, 'busy.txt'));
				saves += 1;
			}
		})();
		const who = await reviewer();
		const dataDirectory = await tempDirectory();
		const found = value(await locateRepository(repo.dir, { gitEnv: who.gitEnv }));
		const during = [];
		for (let i = 0; i < 3; i += 1) {
			during.push(value(await snapshotGitSource(dataDirectory, found, { kind: 'working-tree' })));
		}
		editing.saving = false;
		await editor;
		expect(saves).toBeGreaterThanOrEqual(20);
		for (const taken of during) {
			const file = value(await readSnapshotFile(taken.snapshot, 'new', path('busy.txt')));
			const whole = versions.includes(Buffer.from(file.bytes).toString('utf8'));
			const warned = taken.leftOut.some((message) => message.startsWith('busy.txt kept changing'));
			expect(whole || warned).toBe(true);
		}
		const after = value(await snapshotGitSource(dataDirectory, found, { kind: 'working-tree' }));
		const final = value(await readSnapshotFile(after.snapshot, 'new', path('busy.txt')));
		expect(Buffer.from(final.bytes)).toEqual(await readFile(join(repo.dir, 'busy.txt')));
		expect(after.leftOut).toEqual([]);
	});
});

describe('a staged snapshot', () => {
	it('holds the index, not the working tree', async () => {
		const repo = await useFixture(workingTreeChanges);
		const taken = value(await take(repo.dir, 'staged', await reviewer()));
		expect(await changesOf(taken.snapshot)).toEqual({ 'staged.txt': 'modified' });
		const file = value(await readSnapshotFile(taken.snapshot, 'new', path('staged.txt')));
		expect(Buffer.from(file.bytes).toString('utf8')).toBe('one\nstaged\n');
	});
});

describe('a commit or range snapshot', () => {
	it('compares a commit with its first parent, a root commit with nothing, and a merge with its first parent', async () => {
		const repo = await useFixture(history);
		const who = await reviewer();
		const second = value(await take(repo.dir, 'second', who));
		expect(await changesOf(second.snapshot)).toEqual({ 'a.txt': 'modified' });
		expect(second.baseCommit).toBe((await repo.snapshot('root')).commit);
		const root = value(await take(repo.dir, 'root', who));
		expect(await changesOf(root.snapshot)).toEqual({ 'a.txt': 'added' });
		expect(root.baseCommit).toBeUndefined();
		const merge = value(await take(repo.dir, 'merge', who));
		expect(await changesOf(merge.snapshot)).toEqual({ 'side.txt': 'added' });
	});

	it('compares a range from the merge base, as a pull request does, with two dots or three', async () => {
		const repo = await useFixture(history);
		const who = await reviewer();
		for (const source of ['main...feature', 'main..feature']) {
			const taken = value(await take(repo.dir, source, who));
			expect(await changesOf(taken.snapshot)).toEqual({ 'f.txt': 'added' });
			expect(taken.baseCommit).toBe((await repo.snapshot('second')).commit);
			expect(taken.headCommit).toBe((await repo.snapshot('feature')).commit);
		}
		const back = value(await take(repo.dir, 'feature...main', who));
		expect(await changesOf(back.snapshot)).toEqual({ 'main.txt': 'added', 'side.txt': 'added' });
	});

	it('names an unknown revision and unrelated histories plainly', async () => {
		const repo = await useFixture(history);
		const who = await reviewer();
		const errors: GitSourceError[] = [];
		for (const source of ['no-such-branch', 'main...lonely', 'main...nope']) {
			const result = await take(repo.dir, source, who);
			if (!result.ok) errors.push(result.error);
		}
		expect(errors.map((e) => e.kind)).toEqual([
			'UnknownRevision',
			'NoCommonHistory',
			'UnknownRevision'
		]);
		expect(describeGitSourceError(errors[0] ?? { kind: 'GitNotFound' })).toContain(
			'"no-such-branch"'
		);
		expect(describeGitSourceError(errors[1] ?? { kind: 'GitNotFound' })).toContain(
			'share no history'
		);
	});
});
