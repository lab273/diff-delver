import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * The path of a file inside a git tree, as git writes it: relative, separated by
 * `/`, with no empty, `.` or `..` parts.
 */
export type RepoPath = Tiny<string, 'RepoPath'>;

export type InvalidRepoPathReason =
	'empty' | 'absolute' | 'trailing-slash' | 'empty-segment' | 'dot-segment' | 'nul-byte';

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
	return undefined;
}
