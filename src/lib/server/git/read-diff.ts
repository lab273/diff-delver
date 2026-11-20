/**
 * Reads the diff between two trees of a repository with one fixed git invocation
 * and turns it into the model's `FileDiff` list.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import type { DiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { parseDiffTreeOutput } from '#lib/core/diff/diff-tree-output.ts';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';
import { err, type Result } from '#lib/core/result.ts';
import type { TreeId } from '#lib/core/tree-id.tiny.ts';
import { runGit, type GitError } from './run-git.ts';

/** Anything git can diff as a tree: a tree id, or a commit id standing for its tree. */
export type TreeIsh = TreeId | CommitId;

export type ReadDiffError = GitError | DiffOutputError;

/** Number of unchanged lines shown around each change. */
export const CONTEXT_LINES = 3;

/**
 * The arguments of the one git command that produces every diff, so all sources
 * give the same line identity (DESIGN 3.1). Plumbing (`diff-tree`) is used because
 * porcelain `diff` reads more user config; the `-c` settings pin the rest.
 *
 * - `-r -z --patch-with-raw`: every file, a NUL-separated listing, then patches.
 * - `-M -C`: renames and copies (copies only from files changed in the same diff).
 * - `--histogram`: the diff algorithm. `--full-index --no-abbrev`: full ids.
 * - No colour, no external diff drivers, no textconv, submodules as one line.
 */
export function diffTreeArgs(base: TreeIsh, head: TreeIsh): readonly string[] {
	return [
		'-c',
		'core.quotePath=true',
		'-c',
		'diff.suppressBlankEmpty=false',
		'-c',
		'diff.orderFile=',
		'-c',
		'core.attributesFile=',
		'diff-tree',
		'-r',
		'-z',
		'--patch-with-raw',
		'--no-color',
		'--no-ext-diff',
		'--no-textconv',
		'--histogram',
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

/** The diff between two trees of the repository at `repository`, one entry per changed file. */
export async function readDiff(
	repository: AbsolutePath,
	base: TreeIsh,
	head: TreeIsh
): Promise<Result<readonly FileDiff[], ReadDiffError>> {
	const output = await runGit({ cwd: repository, args: diffTreeArgs(base, head) });
	if (!output.ok) return err(output.error);
	return parseDiffTreeOutput(output.value.stdout.toString('utf8'));
}
