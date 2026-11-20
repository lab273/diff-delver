/**
 * Paths whose bytes are not valid UTF-8 (DESIGN 7.1).
 *
 * git stores a path as bytes, and nearly every path is UTF-8. One that is not
 * must still be one file with one exact identity, so it is decoded losslessly:
 * each byte that is not part of a valid UTF-8 sequence becomes the code point
 * U+DC00 plus the byte, from U+DC80 to U+DCFF. Those are lone surrogates, which
 * valid UTF-8 can never produce, so:
 *
 * - a valid UTF-8 path decodes to exactly its usual string;
 * - distinct byte strings give distinct paths;
 * - `repoPathBytes` gives the exact bytes back, to read the file from a tree.
 *
 * People and agents see the escaped form (`escaped-path.tiny.ts`): a path with
 * no backslash and no odd bytes as it is; any other with each odd byte as `\xHH`
 * and each backslash doubled, so that no two paths look the same.
 * `resolveEscapedPath` reads the form back, and `assign` accepts it.
 */
import { decodePathBytes, encodePathText, ESCAPE_BASE, hasOddBytes } from './path-codec.ts';
import { parseRepoPath, type InvalidRepoPath, type RepoPath } from './repo-path.tiny.ts';
import type { Result } from './result.ts';

export { escapedRepoPath, type EscapedPath } from './escaped-path.tiny.ts';
export { decodePathBytes, encodePathText, hasOddBytes };

/** A path from git's bytes, exact whatever the bytes are. */
export function repoPathFromBytes(bytes: Uint8Array): Result<RepoPath, InvalidRepoPath> {
	return parseRepoPath(decodePathBytes(bytes));
}

/** The path's bytes exactly as git stores them, to read the file from a tree. */
export function repoPathBytes(path: RepoPath): Uint8Array {
	return encodePathText(path);
}

/**
 * The path an escaped form stands for (`escapedRepoPath`), or undefined when it
 * stands for no valid path.
 *
 * - Text with no backslash is a plain path.
 * - Text whose every backslash starts `\\` or `\xHH` (HH from 80 to FF, either
 *   case) is an escaped form, and is read back. Odd bytes that turn out to spell
 *   valid UTF-8 are read as that text, which is the path those bytes are.
 * - Any other text with a backslash, such as `src\app.ts`, is the escaped form of
 *   no path, so it is taken as the literal path, as a person would mean it.
 */
export function resolveEscapedPath(text: string): RepoPath | undefined {
	const read = readEscapes(text);
	const path = parseRepoPath(read === undefined ? text : decodePathBytes(encodePathText(read)));
	return path.ok ? path.value : undefined;
}

/** The text with its escapes read, or undefined when a backslash starts no escape. */
function readEscapes(text: string): string | undefined {
	let out = '';
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i] ?? '';
		if (c !== '\\') {
			out += c;
			continue;
		}
		const next = text[i + 1];
		if (next === '\\') {
			out += '\\';
			i += 1;
		} else if (next === 'x') {
			const hex = text.slice(i + 2, i + 4);
			if (!/^[89A-Fa-f][0-9A-Fa-f]$/.test(hex)) return undefined;
			out += String.fromCharCode(ESCAPE_BASE + Number.parseInt(hex, 16));
			i += 3;
		} else {
			return undefined;
		}
	}
	return out;
}
