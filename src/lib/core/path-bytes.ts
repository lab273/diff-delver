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
 * People and agents see the escaped form: each odd byte as `\xHH`, and, in such a
 * path only, each backslash doubled so the form reads back unambiguously. `assign`
 * accepts that form. A valid path is shown as it is.
 */
import { escapedPathFrom, type EscapedPath } from './escaped-path.tiny.ts';
import {
	codeOf,
	decodePathBytes,
	encodePathText,
	ESCAPE_BASE,
	hasOddBytes,
	isEscape
} from './path-codec.ts';
import { parseRepoPath, type InvalidRepoPath, type RepoPath } from './repo-path.tiny.ts';
import type { Result } from './result.ts';

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
 * The path as people and agents see it: unchanged when it is valid UTF-8;
 * otherwise each odd byte as `\xHH` and each backslash as `\\`.
 */
export function escapedRepoPath(path: RepoPath): EscapedPath {
	if (!hasOddBytes(path)) return escapedPathFrom(path);
	let out = '';
	for (const char of path) {
		const code = codeOf(char);
		if (isEscape(code)) out += `\\x${(code - ESCAPE_BASE).toString(16).toUpperCase()}`;
		else if (char === '\\') out += '\\\\';
		else out += char;
	}
	return escapedPathFrom(out);
}

/**
 * Reads the escaped form back into the path it stands for. Undefined when the
 * text is not the escaped form of a path with odd bytes: it has no `\xHH` for a
 * byte from 80 to FF, or a backslash that starts neither `\\` nor such a byte.
 */
export function unescapeRepoPath(text: string): RepoPath | undefined {
	let out = '';
	let odd = false;
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
			if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
			const byte = Number.parseInt(hex, 16);
			if (byte < 0x80) return undefined;
			out += String.fromCharCode(ESCAPE_BASE + byte);
			odd = true;
			i += 3;
		} else {
			return undefined;
		}
	}
	if (!odd) return undefined;
	const path = parseRepoPath(out);
	return path.ok ? path.value : undefined;
}
