import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';
import { parseTreeId } from '#lib/core/tree-id.tiny.ts';
import { assign } from '#lib/core/diff/assign.ts';
import { makeDiff } from '#lib/core/diff/diff.ts';
import { initialState } from '#lib/core/diff/state.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { escapedRepoPath, repoPathBytes } from '#lib/core/path-bytes.ts';
import {
	awkwardChanges,
	emptyFileAdded,
	oddPathBytes,
	pathBytes,
	sha256Repository
} from '../../../../tests/support/diff-fixtures.ts';
import { emptyRepo, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../tests/support/git-repo.ts';
import { readDiff } from './read-diff.ts';
import { runGit } from './run-git.ts';

async function diffOf(fixture: typeof awkwardChanges): Promise<readonly FileDiff[]> {
	const repo = await useFixture(fixture);
	const base = await repo.snapshot('base');
	const head = await repo.snapshot('head');
	const result = await readDiff(repo.dir, base.tree, head.tree);
	if (!result.ok) throw new Error(`readDiff failed: ${result.error.kind}`);
	return result.value;
}

describe('readDiff', () => {
	it('reads every awkward kind of change from a real repository', async () => {
		const files = await diffOf(awkwardChanges);
		const summary = Object.fromEntries(
			files.map((f) => [
				f.path,
				[
					f.status,
					f.content.kind === 'text' ? f.content.hunks.length : f.content.kind,
					f.old?.path ?? null
				]
			])
		);
		expect(summary).toEqual({
			'added.txt': ['added', 1, null],
			'assets/logo.png': ['added', 'binary', null],
			'becomes-link.txt': ['type-changed', 2, 'becomes-link.txt'],
			'becomes-submodule': ['type-changed', 'submodule', 'becomes-submodule'],
			'binary.bin': ['modified', 'binary', 'binary.bin'],
			'copy-source.txt': ['modified', 1, 'copy-source.txt'],
			'copy-target.txt': ['copied', 0, 'copy-source.txt'],
			'crlf.txt': ['modified', 1, 'crlf.txt'],
			'deleted.txt': ['deleted', 1, 'deleted.txt'],
			'edited-after.txt': ['renamed', 1, 'edited-before.txt'],
			'empty-deleted': ['deleted', 0, 'empty-deleted'],
			'long-line.txt': ['modified', 1, 'long-line.txt'],
			'mode.sh': ['modified', 0, 'mode.sh'],
			'modified.txt': ['modified', 2, 'modified.txt'],
			'no-newline.txt': ['modified', 1, 'no-newline.txt'],
			'odd names/new\nline.txt': ['added', 1, null],
			'odd names/tab\there.txt': ['added', 1, null],
			'odd names/ünïcödé "quoted".txt': ['renamed', 0, 'odd names/with space.txt'],
			'renamed-after.txt': ['renamed', 0, 'renamed-before.txt'],
			'separators.js': ['modified', 6, 'separators.js'],
			'vendor/added': ['added', 'submodule', null],
			'vendor/lib': ['modified', 'submodule', 'vendor/lib']
		});
	});

	it('gives the same diff for commit ids as for their trees', async () => {
		const repo = await useFixture(emptyFileAdded);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const byTree = await readDiff(repo.dir, base.tree, head.tree);
		const byCommit = await readDiff(repo.dir, base.commit, head.commit);
		expect(byCommit).toEqual(byTree);
		expect(byTree.ok && byTree.value.map((f) => [f.status, f.path, f.content])).toEqual([
			['added', 'empty', { kind: 'text', hunks: [] }]
		]);
	});

	it('reads a SHA-256 repository', async () => {
		const [file] = await diffOf(sha256Repository);
		expect(file?.new?.blob).toHaveLength(64);
	});

	it('reads two equal trees as no changes', async () => {
		const repo = await useFixture(emptyFileAdded);
		const head = await repo.snapshot('head');
		expect(await readDiff(repo.dir, head.tree, head.tree)).toEqual({ ok: true, value: [] });
	});

	it('is not affected by repository settings that change diff output', async () => {
		const repo = await useFixture(awkwardChanges);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const before = await readDiff(repo.dir, base.tree, head.tree);
		for (const [key, value] of [
			['diff.noprefix', 'true'],
			['diff.mnemonicPrefix', 'true'],
			['diff.renames', 'false'],
			['diff.algorithm', 'patience'],
			['diff.context', '10'],
			['diff.suppressBlankEmpty', 'true'],
			['core.quotePath', 'false'],
			['color.ui', 'always'],
			['diff.external', 'false'],
			['diff.indentHeuristic', 'false'],
			['diff.interHunkContext', '10'],
			['diff.relative', 'true'],
			['diff.ignoreSubmodules', 'all'],
			['core.bigFileThreshold', '10'],
			['diff.custom.xfuncname', '^  filler'],
			['diff.custom.binary', 'true'],
			['core.attributesFile', join(repo.dir, 'more-attributes')]
		] as const) {
			await repo.git('config', key, value);
		}
		expect(await readDiff(repo.dir, base.tree, head.tree)).toEqual(before);
	});

	it('is not affected by attributes in the work tree, info/attributes or core.attributesFile', async () => {
		const repo = await useFixture(awkwardChanges);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const before = await readDiff(repo.dir, base.tree, head.tree);
		await repo.write('.gitattributes', '*.txt -diff\n*.js diff=custom\n');
		await repo.write('odd names/.gitattributes', '* binary\n');
		await repo.write('.git/info/attributes', 'modified.txt binary\n*.bin diff\n*.sh -text\n');
		await repo.write('more-attributes', 'crlf.txt -diff\n');
		await repo.git('config', 'core.attributesFile', join(repo.dir, 'more-attributes'));
		await repo.git('config', 'diff.custom.xfuncname', '^  filler');
		expect(await readDiff(repo.dir, base.tree, head.tree)).toEqual(before);
	});

	it('is not affected by attributes committed in the trees it compares', async () => {
		const repo = await emptyRepo();
		await repo.write('.gitattributes', '*.txt -diff\n');
		await repo.write('t.txt', 'one\n');
		const base = await repo.commit('base');
		await repo.write('t.txt', 'two\n');
		const head = await repo.commit('head');
		const result = await readDiff(repo.dir, base.tree, head.tree);
		const [file] = result.ok ? result.value : [];
		expect(file?.content.kind === 'text' && file.content.hunks[0]?.lines.length).toBe(2);
	});

	it('reads a repository whose path holds quotes, backslashes, colons and a newline', async () => {
		const outer = await emptyRepo();
		const repo = await GitRepo.init(absolutePath(join(outer.dir, 'odd "dir"\\:\nname')));
		await repo.write('t.txt', 'one\n');
		const base = await repo.commit('base');
		await repo.write('t.txt', 'two\n');
		const head = await repo.commit('head');
		const result = await readDiff(repo.dir, base.tree, head.tree);
		expect(result.ok && result.value.map((f) => f.path)).toEqual(['t.txt']);
	});

	it('keeps paths that are not UTF-8 distinct and exact, so each file reads back', async () => {
		const repo = await useFixture(oddPathBytes);
		const head = await repo.snapshot('head');
		const files = await diffOf(oddPathBytes);
		// The file literally named `caf\xE9.txt` and the one whose name holds the
		// byte E9 look different, and each is assigned by its own form.
		expect(files.map((f) => escapedRepoPath(f.path))).toEqual([
			'caf\\\\xE9.txt',
			'caf\\xE8.txt',
			'caf\\xE9.txt',
			'dir\\xFF/inner.txt'
		]);
		const diff = makeDiff(files);
		if (!diff.ok) throw new Error('makeDiff failed');
		const outcome = assign(diff.value, initialState(diff.value), [
			{ file: 'caf\\xE9.txt', section: 'odd' },
			{ file: 'caf\\\\xE9.txt', section: 'literal' }
		]);
		expect(outcome.rejected).toEqual([]);
		const bucketOf = (path: RepoPath): string => {
			const file = outcome.state.files.get(path);
			const bucket = file?.kind === 'lines' ? file.new.get(2)?.bucket : undefined;
			return bucket?.kind === 'section' ? bucket.section : String(bucket?.kind);
		};
		expect(files.map((f) => bucketOf(f.path))).toEqual([
			'literal',
			'uncategorised',
			'odd',
			'uncategorised'
		]);
		expect(files.map((f) => repoPathBytes(f.path))).toEqual([
			pathBytes('caf\\xE9.txt'),
			pathBytes('caf', 0xe8, '.txt'),
			pathBytes('caf', 0xe9, '.txt'),
			pathBytes('dir', 0xff, '/inner.txt')
		]);
		// Each path's bytes name its file in the head tree.
		const request = Buffer.concat(
			files.map((f) =>
				Buffer.concat([Buffer.from(`${head.tree}:`), repoPathBytes(f.path), Buffer.from('\n')])
			)
		);
		const read = await runGit({ cwd: repo.dir, args: ['cat-file', '--batch'], input: request });
		const missing = read.ok ? read.value.stdout.toString('utf8').match(/missing/g) : ['git failed'];
		expect(missing).toBeNull();
		expect(read.ok && read.value.stdout.toString('utf8').match(/^one$/gm)?.length).toBe(4);
	});

	it('reports a tree the repository does not have', async () => {
		const repo = await emptyRepo();
		const missing = parseTreeId('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
		const other = parseTreeId('a'.repeat(40));
		if (!missing.ok || !other.ok) throw new Error('bad test ids');
		const result = await readDiff(repo.dir, other.value, missing.value);
		expect(result.ok ? undefined : result.error.kind).toBe('BadRevision');
	});
});
