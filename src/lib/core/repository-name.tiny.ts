import type { AbsolutePath } from './absolute-path.tiny.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * The repository a store holds snapshots of, as it was named when the store was
 * made, for the Storage page: a local repository's git directory, or later a
 * remote's URL. Any text that is not empty and holds no NUL.
 */
export type RepositoryName = Tiny<string, 'RepositoryName'>;

export interface InvalidRepositoryName {
	readonly kind: 'InvalidRepositoryName';
	readonly value: string;
}

export function parseRepositoryName(value: string): Result<RepositoryName, InvalidRepositoryName> {
	if (value === '' || value.includes('\0')) return err({ kind: 'InvalidRepositoryName', value });
	return ok(value as RepositoryName);
}

/** A local repository named by its path, which is never empty and holds no NUL. */
export function repositoryNameOf(path: AbsolutePath): RepositoryName {
	const text: string = path;
	return text as RepositoryName;
}
