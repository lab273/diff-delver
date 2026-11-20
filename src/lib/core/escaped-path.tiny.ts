import type { Tiny } from './tiny.ts';

/**
 * A repository path as people and agents read it: unchanged when it is valid
 * UTF-8, otherwise with its odd bytes written `\xHH` (`path-bytes.ts`). Made only
 * by `escapedRepoPath`.
 */
export type EscapedPath = Tiny<string, 'EscapedPath'>;

export function escapedPathFrom(text: string): EscapedPath {
	return text as EscapedPath;
}
