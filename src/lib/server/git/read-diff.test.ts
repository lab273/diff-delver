import { describe, expect, it } from 'vitest';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';
import { parseTreeId } from '#lib/core/tree-id.tiny.ts';
import {
	awkwardChanges,
	emptyFileAdded,
	sha256Repository
} from '../../../../tests/support/diff-fixtures.ts';
import { emptyRepo, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { readDiff } from './read-diff.ts';

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
			['diff.external', 'false']
		] as const) {
			await repo.git('config', key, value);
		}
		expect(await readDiff(repo.dir, base.tree, head.tree)).toEqual(before);
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
