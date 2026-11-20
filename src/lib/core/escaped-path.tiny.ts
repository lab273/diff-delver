import { codeOf, ESCAPE_BASE, hasOddBytes, isEscape } from './path-codec.ts';
import type { RepoPath } from './repo-path.tiny.ts';
import type { Tiny } from './tiny.ts';

/**
 * A repository path as people and agents read it (`path-bytes.ts`). Made only by
 * `escapedRepoPath`, here, so no other text can pass for one.
 */
export type EscapedPath = Tiny<string, 'EscapedPath'>;

/**
 * The path as people and agents see it. A path with no backslash and no odd
 * bytes is shown exactly as it is. Any other path is escaped: each odd byte as
 * `\xHH` (80 to FF, upper case) and each backslash as `\\`.
 *
 * So every escaped form other than a plain path holds a backslash, and every
 * backslash in it starts `\\` or `\xHH`: distinct paths never share an escaped
 * form, and `resolveEscapedPath` reads each one back to its path.
 */
export function escapedRepoPath(path: RepoPath): EscapedPath {
	const text: string = path;
	if (!text.includes('\\') && !hasOddBytes(text)) return text as EscapedPath;
	let out = '';
	for (const char of text) {
		const code = codeOf(char);
		if (isEscape(code)) out += `\\x${(code - ESCAPE_BASE).toString(16).toUpperCase()}`;
		else if (char === '\\') out += '\\\\';
		else out += char;
	}
	return out as EscapedPath;
}
