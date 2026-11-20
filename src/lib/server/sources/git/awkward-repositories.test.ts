import { randomIds } from '#lib/server/system.ts';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import {
	defineFixture,
	emptyRepo,
	tempDirectory,
	useFixture
} from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import {
	changesOf,
	located,
	take,
	value
} from '../../../../../tests/support/git-source-helpers.ts';
import {
	reviewer,
	treeGitWouldCommit,
	type Reviewer
} from '../../../../../tests/support/reviewer-git.ts';
import { listDirectory } from '../../../../../tests/support/directory-listing.ts';
import { partialClone, type CloneFilter } from '../../../../../tests/support/partial-clone.ts';
import {
	listSnapshotPaths,
	listSnapshots,
	openStore,
	readSnapshotFile
} from '../../store/index.ts';
import { describeGitSourceError, locateRepository, snapshotGitSource } from './index.ts';

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

/** A repository with three real submodules, then: one moved on, one dirty, one deleted, one added. */
const submodules = defineFixture('submodules', async (repo) => {
	const origin = await GitRepo.init(absolutePath(`${repo.dir}-sub-origin`));
	await origin.write('lib.txt', 'library\n');
	await origin.commit('library');
	for (const name of ['changed', 'dirty', 'removed']) {
		await repo.git(
			'-c',
			'protocol.file.allow=always',
			'submodule',
			'add',
			'--quiet',
			origin.dir,
			`libs/${name}`
		);
	}
	await repo.commit('base', 'base');
	const changed = GitRepo.open(absolutePath(join(repo.dir, 'libs/changed')));
	await changed.write('lib.txt', 'library, moved on\n');
	await changed.git('commit', '--quiet', '-am', 'moved on');
	await repo.write('libs/dirty/lib.txt', 'edited but not committed\n');
	await repo.remove('libs/removed');
	// A newer commit of the library, so the added submodule is not the removed one moved.
	await origin.write('lib.txt', 'library, newer\n');
	await origin.commit('newer');
	await repo.git(
		'-c',
		'protocol.file.allow=always',
		'submodule',
		'add',
		'--quiet',
		origin.dir,
		'libs/added'
	);
});

describe('awkward repositories', () => {
	it('records submodules by commit: moved on, added and removed, and a dirty one as unchanged', async () => {
		const repo = await useFixture(submodules);
		const who = await reviewer();
		const taken = value(await take(repo.dir, 'working-tree', who));
		expect(await changesOf(taken.snapshot)).toEqual({
			'.gitmodules': 'modified',
			'libs/added': 'added',
			'libs/changed': 'modified',
			'libs/removed': 'deleted'
		});
		expect(taken.snapshot.head).toBe(await treeGitWouldCommit(repo.dir, who));
		const read = await readSnapshotFile(taken.snapshot, 'new', path('libs/changed/lib.txt'));
		expect(read.ok ? 'read' : read.error.kind).toBe('PathNotFound');
	});

	it('treats a repository inside another one as its own, and as a submodule of the outer one', async () => {
		const outer = await emptyRepo();
		await outer.write('outer.txt', 'outer\n');
		await outer.commit('outer');
		const inner = await GitRepo.init(absolutePath(join(outer.dir, 'inner')));
		await inner.write('inner.txt', 'inner\n');
		await inner.commit('inner');
		await inner.write('inner.txt', 'inner, edited\n');
		const who = await reviewer();
		const innerTaken = value(await take(inner.dir, 'working-tree', who));
		expect(await changesOf(innerTaken.snapshot)).toEqual({ 'inner.txt': 'modified' });
		const outerTaken = value(await take(outer.dir, 'working-tree', who));
		expect(await changesOf(outerTaken.snapshot)).toEqual({ inner: 'added' });
		expect(innerTaken.snapshot.store.id).not.toBe(outerTaken.snapshot.store.id);
	});

	it('snapshots a linked worktree into the same store as its main one, writing to neither', async () => {
		const main = await emptyRepo();
		await main.write('shared.txt', 'one\n');
		await main.commit('base');
		const worktree = absolutePath(join(await tempDirectory(), 'linked'));
		await main.git('worktree', 'add', '--quiet', '-b', 'linked', worktree);
		await main.write('shared.txt', 'edited in the main worktree\n');
		const linked = GitRepo.open(worktree);
		await linked.write('shared.txt', 'edited in the linked worktree\n');
		await linked.write('new.txt', 'only in the linked worktree\n');
		const who = await reviewer();
		const dataDirectory = await tempDirectory();
		const fromLinked = value(
			await take(worktree, 'working-tree', who, { dataDirectory, alsoWatch: [main.dir] })
		);
		expect(await changesOf(fromLinked.snapshot)).toEqual({
			'new.txt': 'added',
			'shared.txt': 'modified'
		});
		const file = value(await readSnapshotFile(fromLinked.snapshot, 'new', path('shared.txt')));
		expect(Buffer.from(file.bytes).toString('utf8')).toBe('edited in the linked worktree\n');
		const fromMain = value(
			await take(main.dir, 'working-tree', who, { dataDirectory, alsoWatch: [worktree] })
		);
		expect(await changesOf(fromMain.snapshot)).toEqual({ 'shared.txt': 'modified' });
		expect(fromMain.snapshot.store.dir).toBe(fromLinked.snapshot.store.dir);
		const staged = value(
			await take(worktree, 'staged', who, { dataDirectory, alsoWatch: [main.dir] })
		);
		expect(await changesOf(staged.snapshot)).toEqual({});
	});

	it('says plainly that a bare repository has no working tree, and still opens its commits', async () => {
		const origin = await emptyRepo();
		await origin.write('a.txt', 'one\n');
		await origin.commit('one');
		await origin.write('a.txt', 'two\n');
		await origin.commit('two');
		const bare = absolutePath(join(await tempDirectory(), 'bare.git'));
		await origin.git('clone', '--quiet', '--bare', origin.dir, bare);
		const who = await reviewer();
		for (const source of ['working-tree', 'staged']) {
			const result = await take(bare, source, who);
			expect(result.ok ? 'taken' : result.error.kind).toBe('NoWorkingTree');
			if (!result.ok) expect(describeGitSourceError(result.error)).toContain('bare repository');
		}
		const commit = value(await take(bare, 'HEAD', who));
		expect(await changesOf(commit.snapshot)).toEqual({ 'a.txt': 'modified' });
	});

	it('reads a split index without touching its shared index file', async () => {
		const repo = await emptyRepo();
		for (let i = 0; i < 20; i += 1) await repo.write(`f${String(i)}.txt`, `${String(i)}\n`);
		await repo.commit('base');
		await repo.git('config', 'core.splitIndex', 'true');
		await repo.git('update-index', '--split-index');
		await repo.write('f1.txt', 'edited\n');
		await repo.write('f2.txt', 'staged\n');
		await repo.git('add', 'f2.txt');
		const who = await reviewer();
		const taken = value(await take(repo.dir, 'working-tree', who));
		expect(await changesOf(taken.snapshot)).toEqual({ 'f1.txt': 'modified', 'f2.txt': 'modified' });
		expect(taken.snapshot.head).toBe(await treeGitWouldCommit(repo.dir, who));
		const staged = value(await take(repo.dir, 'staged', who));
		expect(await changesOf(staged.snapshot)).toEqual({ 'f2.txt': 'modified' });
	});

	it('works in a sparse checkout with a sparse index, and holds the whole tree', async () => {
		const repo = await emptyRepo();
		for (const dir of ['in', 'out', 'far/away']) await repo.write(`${dir}/file.txt`, `${dir}\n`);
		await repo.write('top.txt', 'top\n');
		await repo.commit('base');
		await repo.git('sparse-checkout', 'set', '--cone', 'in');
		await repo.git('config', 'index.sparse', 'true');
		await repo.git('sparse-checkout', 'reapply');
		await repo.write('in/file.txt', 'in, edited\n');
		await repo.write('in/new.txt', 'new\n');
		const who = await reviewer();
		const taken = value(await take(repo.dir, 'working-tree', who));
		expect(await changesOf(taken.snapshot)).toEqual({
			'in/file.txt': 'modified',
			'in/new.txt': 'added'
		});
		const paths = value(await listSnapshotPaths(taken.snapshot, 'new')).map((e) => e.path);
		expect(paths).toEqual([
			'far/away/file.txt',
			'in/file.txt',
			'in/new.txt',
			'out/file.txt',
			'top.txt'
		]);
		expect(taken.snapshot.head).toBe(await treeGitWouldCommit(repo.dir, who));
		await repo.git('add', 'in/new.txt');
		const staged = value(await take(repo.dir, 'staged', who));
		expect(await changesOf(staged.snapshot)).toEqual({ 'in/new.txt': 'added' });
	});

	it('says what to fetch when a shallow clone lacks the history a commit or range needs', async () => {
		const origin = await emptyRepo();
		await origin.write('a.txt', 'one\n');
		await origin.commit('one');
		await origin.git('branch', 'feature');
		await origin.write('a.txt', 'two\n');
		await origin.commit('two');
		await origin.git('checkout', '--quiet', 'feature');
		await origin.write('f.txt', 'feature\n');
		await origin.commit('feature');
		await origin.git('checkout', '--quiet', 'main');
		const clone = absolutePath(join(await tempDirectory(), 'shallow'));
		await origin.git(
			'clone',
			'--quiet',
			'--depth=1',
			'--no-single-branch',
			`file://${origin.dir}`,
			clone
		);
		const who = await reviewer();
		const commit = await take(clone, 'HEAD', who);
		expect(commit.ok ? 'taken' : commit.error.kind).toBe('ShallowHistory');
		if (!commit.ok) expect(describeGitSourceError(commit.error)).toContain('git fetch --deepen');
		const range = await take(clone, 'origin/main...origin/feature', who);
		expect(range.ok ? 'taken' : range.error.kind).toBe('ShallowHistory');
		await GitRepo.open(clone).write('a.txt', 'edited\n');
		const workingTree = value(await take(clone, 'working-tree', who));
		expect(await changesOf(workingTree.snapshot)).toEqual({ 'a.txt': 'modified' });
	});

	it("gives git's refusal of another account's repository its own message, and honours safe.directory", async () => {
		const repo = await emptyRepo();
		await repo.write('a.txt', 'one\n');
		await repo.commit('one');
		const strangers = (who: Reviewer): Reviewer => ({
			...who,
			gitEnv: { ...who.gitEnv, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }
		});
		const refused = await take(repo.dir, 'working-tree', strangers(await reviewer()));
		expect(refused.ok ? 'taken' : refused.error.kind).toBe('DubiousOwnership');
		if (!refused.ok) {
			expect(describeGitSourceError(refused.error)).toContain('belongs to another user account');
			expect(describeGitSourceError(refused.error)).toContain('safe.directory');
		}
		const trusting = strangers(await reviewer('[safe]\n\tdirectory = *\n'));
		const taken = value(await take(repo.dir, 'HEAD', trusting));
		expect(await changesOf(taken.snapshot)).toEqual({ 'a.txt': 'added' });
		value(await take(repo.dir, 'working-tree', trusting));
	});

	it('stores what git would commit under line-ending settings, filters, attributes and global ignores', async () => {
		const repo = await emptyRepo();
		await repo.write('legacy.md', 'committed\r\nwith CRLF\r\n');
		await repo.write('.gitattributes', '*.txt text eol=lf\n*.up filter=upper\n');
		await repo.commit('base');
		// The fixture sets core.autocrlf in the repository, which would win over the reviewer's.
		await repo.git('config', '--unset', 'core.autocrlf');
		await repo.git('config', 'filter.upper.clean', 'tr a-z A-Z');
		await repo.git('config', 'filter.upper.smudge', 'cat');
		await repo.write('notes.txt', 'windows\r\nline endings\r\n');
		await repo.write('mixed.md', 'new file\r\nwith CRLF\r\n');
		await repo.write('legacy.md', 'committed\r\nwith CRLF\r\nstill CRLF\r\n');
		await repo.write('shout.up', 'quiet words\n');
		await repo.write('key.secret', 'ignored by the global ignore file\n');
		const home = await tempDirectory();
		const who = await reviewer(
			`[core]\n\tautocrlf = input\n\texcludesFile = ${join(home, 'global-ignore')}\n`
		);
		await GitRepo.open(home).write('global-ignore', '*.secret\n');
		const taken = value(await take(repo.dir, 'working-tree', who));
		expect(taken.snapshot.head).toBe(await treeGitWouldCommit(repo.dir, who));
		const text = async (name: string): Promise<string> =>
			Buffer.from(value(await readSnapshotFile(taken.snapshot, 'new', path(name))).bytes).toString(
				'utf8'
			);
		expect(await text('notes.txt')).toBe('windows\nline endings\n');
		expect(await text('mixed.md')).toBe('new file\nwith CRLF\n');
		// git leaves a file that was committed with CRLF as it is, rather than converting it.
		expect(await text('legacy.md')).toBe('committed\r\nwith CRLF\r\nstill CRLF\r\n');
		expect(await text('shout.up')).toBe('QUIET WORDS\n');
		expect(Object.keys(await changesOf(taken.snapshot))).not.toContain('key.secret');
	});

	it('does not download what a partial clone lacks, and says how to get it', async () => {
		const origin = await emptyRepo();
		await origin.git('config', 'uploadpack.allowFilter', 'true');
		await origin.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
		await origin.write('a.txt', 'old content\n');
		await origin.commit('one');
		await origin.write('a.txt', 'new content\n');
		await origin.commit('two');
		const clone = absolutePath(join(await tempDirectory(), 'partial'));
		await origin.git('clone', '--quiet', '--filter=blob:none', `file://${origin.dir}`, clone);
		const who = await reviewer();
		const commit = await take(clone, 'HEAD', who);
		expect(commit.ok ? 'taken' : commit.error.kind).toBe('PartialCloneMissing');
		if (!commit.ok) {
			expect(describeGitSourceError(commit.error)).toBe(
				`${value(await locateRepository(clone, { gitEnv: who.gitEnv })).commonDir} is a partial clone: some of the files or folders this needs were never downloaded, and diff delver does not download them, so that nothing is written to your repository. Review its uncommitted changes instead, or make a full clone (git clone without --filter) and open the same source there.`
			);
		}
		await GitRepo.open(clone).write('b.txt', 'new file\n');
		const workingTree = value(await take(clone, 'working-tree', who));
		expect(await changesOf(workingTree.snapshot)).toEqual({ 'b.txt': 'added' });
	});

	it.each<CloneFilter>(['blob:none', 'tree:0'])(
		'fetches nothing into a partial clone (%s): what it lacks is named, what it has is taken',
		async (filter) => {
			const { clone } = await partialClone(filter);
			const who = await reviewer();
			for (const source of ['HEAD', 'origin/main...feat']) {
				const taken = await take(clone.dir, source, who);
				expect(taken.ok ? 'taken' : taken.error.kind).toBe('PartialCloneMissing');
			}
			await clone.write('new.txt', 'new\n');
			const workingTree = value(await take(clone.dir, 'working-tree', who));
			expect(await changesOf(workingTree.snapshot)).toEqual({ 'new.txt': 'added' });
			const staged = value(await take(clone.dir, 'staged', who));
			expect(await changesOf(staged.snapshot)).toEqual({});
		}
	);

	it('takes several snapshots of one repository at once, all correct', async () => {
		const repo = await emptyRepo();
		await repo.write('a.txt', 'one\n');
		await repo.commit('base');
		await repo.write('a.txt', 'two\n');
		await repo.git('add', 'a.txt');
		await repo.write('b.txt', 'untracked\n');
		const who = await reviewer();
		const dataDirectory = await tempDirectory();
		const found = await located(repo.dir, who);
		const before = await listDirectory(repo.dir);
		const results = await Promise.all(
			(['working-tree', 'staged', 'working-tree', 'staged', 'working-tree'] as const).map((kind) =>
				snapshotGitSource(dataDirectory, found, { kind }, randomIds.snapshotId())
			)
		);
		expect(await listDirectory(repo.dir)).toEqual(before);
		const heads = results.map((result) => value(result).snapshot.head);
		expect(new Set([heads[0], heads[2], heads[4]]).size).toBe(1);
		expect(heads[1]).toBe(heads[3]);
		expect(heads[0]).not.toBe(heads[1]);
		const store = value(await openStore(dataDirectory, found.storeId));
		expect(value(await listSnapshots(store))).toHaveLength(5);
	});
});

describe('which store a repository uses', () => {
	it('is the same from a subdirectory, through a symbolic link and from a linked worktree', async () => {
		const repo = await emptyRepo();
		await repo.write('deep/er/file.txt', 'one\n');
		await repo.commit('base');
		const who = await reviewer();
		const link = absolutePath(join(await tempDirectory(), 'link'));
		await symlink(repo.dir, link);
		const worktree = absolutePath(join(await tempDirectory(), 'wt'));
		await repo.git('worktree', 'add', '--quiet', '--detach', worktree);
		const ids = await Promise.all(
			[repo.dir, join(repo.dir, 'deep/er'), link, join(link, 'deep'), worktree].map(
				async (dir) => (await located(absolutePath(dir), who)).storeId
			)
		);
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toMatch(/^[a-z0-9-]+-[0-9a-f]{16}$/);
	});

	it('differs for a nested repository, another clone and a submodule', async () => {
		const repo = await useFixture(submodules);
		const who = await reviewer();
		const clone = absolutePath(join(await tempDirectory(), 'clone'));
		await repo.git('clone', '--quiet', repo.dir, clone);
		const ids = await Promise.all(
			[repo.dir, clone, join(repo.dir, 'libs/changed')].map(
				async (dir) => (await located(absolutePath(dir), who)).storeId
			)
		);
		expect(new Set(ids).size).toBe(3);
	});

	it('is not found outside any repository', async () => {
		const dir = await tempDirectory();
		const result = await locateRepository(dir, {
			gitEnv: { ...(await reviewer()).gitEnv, GIT_CEILING_DIRECTORIES: join(dir, '..') }
		});
		expect(result.ok ? 'found' : result.error.kind).toBe('NotARepository');
		if (!result.ok) expect(describeGitSourceError(result.error)).toContain('not a git repository');
	});
});
