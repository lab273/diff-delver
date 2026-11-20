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
import { parseRepoPath, type InvalidRepoPath, type RepoPath } from './repo-path.tiny.ts';
import type { Result } from './result.ts';

const ESCAPE_BASE = 0xdc00;
const FIRST_ESCAPE = 0xdc80;
const LAST_ESCAPE = 0xdcff;

const isContinuation = (b: number | undefined): boolean =>
	b !== undefined && b >= 0x80 && b <= 0xbf;

/** The length of the well-formed UTF-8 sequence at `at`, or 0 if there is none (Unicode table 3-7). */
function sequenceLength(bytes: Uint8Array, at: number): number {
	const b0 = bytes[at] ?? 0;
	const b1 = bytes[at + 1];
	const inRange = (b: number | undefined, low: number, high: number): boolean =>
		b !== undefined && b >= low && b <= high;
	if (b0 < 0x80) return 1;
	if (b0 >= 0xc2 && b0 <= 0xdf) return isContinuation(b1) ? 2 : 0;
	const cont = (from: number, count: number): boolean => {
		for (let i = from; i < from + count; i += 1) if (!isContinuation(bytes[at + i])) return false;
		return true;
	};
	if (b0 === 0xe0) return inRange(b1, 0xa0, 0xbf) && cont(2, 1) ? 3 : 0;
	if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) return cont(1, 2) ? 3 : 0;
	if (b0 === 0xed) return inRange(b1, 0x80, 0x9f) && cont(2, 1) ? 3 : 0;
	if (b0 === 0xf0) return inRange(b1, 0x90, 0xbf) && cont(2, 2) ? 4 : 0;
	if (b0 >= 0xf1 && b0 <= 0xf3) return cont(1, 3) ? 4 : 0;
	if (b0 === 0xf4) return inRange(b1, 0x80, 0x8f) && cont(2, 2) ? 4 : 0;
	return 0;
}

/** Every sequence it sees is valid. `ignoreBOM` keeps a leading U+FEFF, which is part of the name. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** Decodes path bytes, keeping each byte that is not valid UTF-8 as U+DC80 to U+DCFF. */
export function decodePathBytes(bytes: Uint8Array): string {
	let out = '';
	let runStart = 0;
	let at = 0;
	while (at < bytes.length) {
		const length = sequenceLength(bytes, at);
		if (length > 0) {
			at += length;
			continue;
		}
		out += utf8.decode(bytes.subarray(runStart, at));
		out += String.fromCharCode(ESCAPE_BASE + (bytes[at] ?? 0));
		at += 1;
		runStart = at;
	}
	return out + utf8.decode(bytes.subarray(runStart, at));
}

/** A path from git's bytes, exact whatever the bytes are. */
export function repoPathFromBytes(bytes: Uint8Array): Result<RepoPath, InvalidRepoPath> {
	return parseRepoPath(decodePathBytes(bytes));
}

/**
 * Whether a code point stands for an odd byte. Strings are walked by code point,
 * so the low half of a real surrogate pair (U+10080 is D800 DC80) is never taken
 * for one.
 */
const isEscape = (code: number): boolean => code >= FIRST_ESCAPE && code <= LAST_ESCAPE;

const codeOf = (char: string): number => char.codePointAt(0) ?? 0;

/** Whether the path holds bytes that are not valid UTF-8. */
export function hasOddBytes(path: string): boolean {
	for (const char of path) if (isEscape(codeOf(char))) return true;
	return false;
}

const utf8Encoder = new TextEncoder();

/** The path's bytes exactly as git stores them, to read the file from a tree. */
export function repoPathBytes(path: RepoPath): Uint8Array {
	return encodePathText(path);
}

/**
 * Encodes text as UTF-8, except that U+DC80 to U+DCFF become the single bytes
 * they stand for: the inverse of `decodePathBytes`.
 */
export function encodePathText(path: string): Uint8Array {
	if (!hasOddBytes(path)) return utf8Encoder.encode(path);
	const parts: Uint8Array[] = [];
	let run = '';
	for (const char of path) {
		const code = codeOf(char);
		if (isEscape(code)) {
			parts.push(utf8Encoder.encode(run), Uint8Array.of(code - ESCAPE_BASE));
			run = '';
		} else {
			run += char;
		}
	}
	parts.push(utf8Encoder.encode(run));
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
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
