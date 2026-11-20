import { notDecoded } from './path-codec.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * The path of a file inside a git tree, as git writes it: relative, separated by
 * `/`, with no empty, `.` or `..` parts. Bytes that are not UTF-8 are held as
 * U+DC80 to U+DCFF (`path-bytes.ts`), and the string is exactly what those
 * bytes decode to, so each path has one string and each string one path.
 */
export type RepoPath = Tiny<string, 'RepoPath'>;

export type InvalidRepoPathReason =
	| 'empty'
	| 'absolute'
	| 'trailing-slash'
	| 'empty-segment'
	| 'dot-segment'
	| 'nul-byte'
	/** A lone surrogate that stands for no byte (`path-codec.ts`). */
	| 'unpaired-surrogate'
	/** Odd-byte code points that spell valid UTF-8, which is written as plain text. */
	| 'escapes-spell-text';

export interface InvalidRepoPath {
	readonly kind: 'InvalidRepoPath';
	readonly value: string;
	readonly reason: InvalidRepoPathReason;
}

export function parseRepoPath(value: string): Result<RepoPath, InvalidRepoPath> {
	const reason = findProblem(value);
	if (reason !== undefined) {
		return err({ kind: 'InvalidRepoPath', value, reason });
	}
	return ok(value as RepoPath);
}

function findProblem(value: string): InvalidRepoPathReason | undefined {
	if (value === '') return 'empty';
	if (value.includes('\0')) return 'nul-byte';
	if (value.startsWith('/')) return 'absolute';
	if (value.endsWith('/')) return 'trailing-slash';
	for (const segment of value.split('/')) {
		if (segment === '') return 'empty-segment';
		if (segment === '.' || segment === '..') return 'dot-segment';
	}
	return notDecoded(value);
}
