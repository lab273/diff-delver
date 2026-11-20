/**
 * Reads the diff between two trees of a repository with one fixed git invocation
 * and turns it into the model's `FileDiff` list.
 *
 * The output must not depend on the reviewed repository's settings (DESIGN 3.1).
 * Its local config (`core.bigFileThreshold`, `diff.<driver>.*`, ...), its
 * `.gitattributes` files and its `info/attributes` would all change it, and git
 * has no switch to ignore a repository's own config or `info/attributes`. So the
 * diff runs in an empty bare repository made for the purpose, which borrows the
 * reviewed repository's objects as an alternate: it sees the same trees and
 * blobs, and none of the settings.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import type { DiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { parseDiffTreeOutput } from '#lib/core/diff/diff-tree-output.ts';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { TreeId } from '#lib/core/tree-id.tiny.ts';
import { runGit, runGitText, type GitError } from './run-git.ts';

/** Anything git can diff as a tree: a tree id, or a commit id standing for its tree. */
export type TreeIsh = TreeId | CommitId;

export type ReadDiffError = GitError | DiffOutputError;

/** Number of unchanged lines shown around each change. */
export const CONTEXT_LINES = 3;

/** git's built-in empty tree, which every repository has without storing it. */
const EMPTY_TREE = {
	sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
	sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
} as const;

export type ObjectFormat = keyof typeof EMPTY_TREE;

/**
 * The arguments of the one git command that produces every diff, so all sources
 * give the same line identity (DESIGN 3.1). Plumbing (`diff-tree`) is used because
 * porcelain `diff` reads more user config; the `-c` settings pin the rest. It runs
 * in an isolated repository (see the top of this file), so only the defaults and
 * these settings apply.
 *
 * - `--attr-source` set to the empty tree: no `.gitattributes` from any tree or
 *   work tree, so no `-diff`, `binary`, `diff=<driver>` or `text` changes the output.
 * - `-r -z --patch-with-raw`: every file, a NUL-separated listing, then patches.
 * - `-M -C`: renames and copies (copies only from files changed in the same diff).
 * - `--histogram` and the indent heuristic: the diff algorithm. `--full-index
 *   --no-abbrev`: full ids.
 * - No colour, no external diff drivers, no textconv, submodules as one line, paths
 *   from the root.
 */
export function diffTreeArgs(
	base: TreeIsh,
	head: TreeIsh,
	format: ObjectFormat = 'sha1'
): readonly string[] {
	return [
		`--attr-source=${EMPTY_TREE[format]}`,
		'-c',
		'core.quotePath=true',
		'-c',
		'core.attributesFile=',
		'-c',
		'core.bigFileThreshold=512m',
		'-c',
		'diff.suppressBlankEmpty=false',
		'-c',
		'diff.orderFile=',
		'-c',
		'diff.indentHeuristic=true',
		'-c',
		'diff.relative=false',
		'diff-tree',
		'-r',
		'-z',
		'--patch-with-raw',
		'--no-color',
		'--no-ext-diff',
		'--no-textconv',
		'--histogram',
		'--indent-heuristic',
		'--no-relative',
		'-M',
		'-C',
		'-l1000',
		'--full-index',
		'--no-abbrev',
		'--src-prefix=a/',
		'--dst-prefix=b/',
		`--unified=${CONTEXT_LINES}`,
		'--inter-hunk-context=0',
		'--ignore-submodules=none',
		'--submodule=short',
		'--end-of-options',
		base,
		head
	];
}

/** A line of an alternates file, quoted as git reads it, so any path survives. */
function alternatesLine(path: string): string {
	const quoted = path.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n');
	return `"${quoted}"\n`;
}

/**
 * Runs the diff command for two trees of the repository at `repository` and
 * returns git's raw output, as `readDiff` reads it and `pnpm fixtures:capture`
 * records it.
 */
export async function runDiffTree(
	repository: AbsolutePath,
	base: TreeIsh,
	head: TreeIsh
): Promise<Result<Buffer, GitError>> {
	const objects = await runGitText({
		cwd: repository,
		args: ['rev-parse', '--path-format=absolute', '--git-path', 'objects']
	});
	if (!objects.ok) return objects;
	const format = await runGitText({ cwd: repository, args: ['rev-parse', '--show-object-format'] });
	if (!format.ok) return format;
	const objectFormat: ObjectFormat = format.value === 'sha256' ? 'sha256' : 'sha1';

	const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-diff-'));
	try {
		const dir = parseAbsolutePath(scratch);
		if (!dir.ok) throw new Error(`The temporary directory is not absolute: ${scratch}`);
		const init = await runGit({
			cwd: dir.value,
			args: ['init', '--quiet', '--bare', `--object-format=${objectFormat}`, '.']
		});
		if (!init.ok) return init;
		await writeFile(join(scratch, 'objects', 'info', 'alternates'), alternatesLine(objects.value));
		const output = await runGit({
			cwd: dir.value,
			args: diffTreeArgs(base, head, objectFormat)
		});
		return output.ok ? ok(output.value.stdout) : output;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** The diff between two trees of the repository at `repository`, one entry per changed file. */
export async function readDiff(
	repository: AbsolutePath,
	base: TreeIsh,
	head: TreeIsh
): Promise<Result<readonly FileDiff[], ReadDiffError>> {
	const output = await runDiffTree(repository, base, head);
	if (!output.ok) return err(output.error);
	return parseDiffTreeOutput(output.value.toString('utf8'));
}
