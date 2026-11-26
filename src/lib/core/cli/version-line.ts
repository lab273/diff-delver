/**
 * What `diff-delver --version` prints, and reading it back: the command on
 * disk is asked its version by a running shim (`versionOnDisk`), by the release
 * scripts and by the agent trials. "diff-delver 0.0.1-dev+3f2a1b9c0d4e (a3f9c21)",
 * the commit in brackets only when the build knew it.
 */
import { versionWithCommit, type BuildCommit } from '../build-identity.ts';
import { parseCodeVersion, type CodeVersion } from '../code-version.tiny.ts';

export function versionLine(version: CodeVersion, commit: BuildCommit | undefined): string {
	return `diff-delver ${versionWithCommit(version, commit)}`;
}

/** The version a `--version` line names, with or without its commit; undefined for any other text. */
export function versionOfLine(printed: string): CodeVersion | undefined {
	const found = /^diff-delver (\S+)(?: \([^()\n]*\))?\s*$/.exec(printed);
	if (found?.[1] === undefined) return undefined;
	const parsed = parseCodeVersion(found[1]);
	return parsed.ok ? parsed.value : undefined;
}
