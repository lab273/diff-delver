/**
 * Fixture repositories for reading diffs, each tagged `base` and `head`.
 *
 * Shared by the integration tests of `readDiff` and by
 * `scripts/capture-diff-fixtures.ts`, which records git's output for these same
 * repositories as the core parser's test fixtures.
 */
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { defineFixture, type Fixture } from './git-repo.ts';

const lines = (prefix: string, count: number): string =>
	Array.from({ length: count }, (_, i) => `${prefix} line ${String(i + 1)}\n`).join('');

/** The commit a submodule entry points at. git does not check that it exists. */
const SUBMODULE_BEFORE = '1111111111111111111111111111111111111111';
const SUBMODULE_AFTER = '2222222222222222222222222222222222222222';
const SUBMODULE_ADDED = '3333333333333333333333333333333333333333';

/** One file for every awkward kind of change. */
export const awkwardChanges: Fixture = defineFixture('awkward-changes', async (repo) => {
	await repo.write('modified.txt', 'one\n\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
	await repo.write('deleted.txt', 'gone\nfor\ngood\n');
	await repo.write('renamed-before.txt', lines('pure rename', 10));
	await repo.write('edited-before.txt', lines('rename with edits', 10));
	await repo.write('copy-source.txt', lines('copy source', 10));
	await repo.write('mode.sh', '#!/bin/sh\necho hi\n');
	await repo.write('becomes-link.txt', 'link me\n');
	await repo.write('becomes-submodule', 'was a file\n');
	await repo.write('binary.bin', new Uint8Array([0, 1, 2, 3, 0, 255]));
	await repo.write('empty-deleted', '');
	await repo.write('no-newline.txt', 'a\nb');
	await repo.write('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
	await repo.write('long-line.txt', `${'x'.repeat(20_000)}\n`);
	await repo.write('odd names/with space.txt', 'a file with a space in its name\n');
	repo.setGitlink('vendor/lib', parseCommit(SUBMODULE_BEFORE));
	await repo.commit('base', 'base');

	await repo.write(
		'modified.txt',
		'one\n\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n'
	);
	await repo.remove('deleted.txt');
	await repo.move('renamed-before.txt', 'renamed-after.txt');
	await repo.move('edited-before.txt', 'edited-after.txt');
	await repo.write(
		'edited-after.txt',
		lines('rename with edits', 10).replace('line 5\n', 'line five\n')
	);
	await repo.write('copy-target.txt', lines('copy source', 10));
	await repo.write('copy-source.txt', `${lines('copy source', 10)}one more\n`);
	await repo.setExecutable('mode.sh', true);
	await repo.symlink('becomes-link.txt', 'modified.txt');
	await repo.remove('becomes-submodule');
	repo.setGitlink('becomes-submodule', parseCommit(SUBMODULE_ADDED));
	await repo.write('binary.bin', new Uint8Array([0, 1, 2, 4, 0, 255]));
	await repo.remove('empty-deleted');
	await repo.write('no-newline.txt', 'a\nc');
	await repo.write('crlf.txt', 'one\r\nTWO\r\nthree\r\n');
	await repo.write('long-line.txt', `${'y'.repeat(20_000)}\n`);
	await repo.move('odd names/with space.txt', 'odd names/ünïcödé "quoted".txt');
	await repo.write('odd names/new\nline.txt', 'a newline in the name\n');
	await repo.write('odd names/tab\there.txt', 'a tab in the name\n');
	await repo.write('added.txt', 'new\nfile\n');
	await repo.write(
		'assets/logo.png',
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
	);
	repo.setGitlink('vendor/lib', parseCommit(SUBMODULE_AFTER));
	repo.setGitlink('vendor/added', parseCommit(SUBMODULE_ADDED));
	await repo.commit('head', 'head');
});

/** A plain modification in a SHA-256 repository, for 64-character object ids. */
export const sha256Repository: Fixture = defineFixture(
	'sha256-repository',
	async (repo) => {
		await repo.write('file.txt', 'before\n');
		await repo.commit('base', 'base');
		await repo.write('file.txt', 'after\n');
		await repo.commit('head', 'head');
	},
	{ objectFormat: 'sha256' }
);

/** An empty file added, alone: next to a deleted empty file git would call it a rename. */
export const emptyFileAdded: Fixture = defineFixture('empty-file-added', async (repo) => {
	await repo.write('README', 'hello\n');
	await repo.commit('base', 'base');
	await repo.write('empty', '');
	await repo.commit('head', 'head');
});

/** Every fixture that `scripts/capture-diff-fixtures.ts` records. */
export const diffFixtures: readonly Fixture[] = [awkwardChanges, emptyFileAdded, sha256Repository];

function parseCommit(value: string): CommitId {
	const parsed = parseCommitId(value);
	if (!parsed.ok) throw new Error(`Not a commit id: ${value}`);
	return parsed.value;
}
