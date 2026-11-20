/**
 * The lossless decoding of path bytes (DESIGN 7.1), on its own so that
 * `repo-path.tiny.ts` can check a path against it without a cycle. Described in
 * `path-bytes.ts`, which is where the rest of the code imports it from.
 */
export const ESCAPE_BASE = 0xdc00;
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

/**
 * Whether a code point stands for an odd byte. Strings are walked by code point,
 * so the low half of a real surrogate pair (U+10080 is D800 DC80) is never taken
 * for one.
 */
export const isEscape = (code: number): boolean => code >= FIRST_ESCAPE && code <= LAST_ESCAPE;

export const codeOf = (char: string): number => char.codePointAt(0) ?? 0;

/** Whether the path holds bytes that are not valid UTF-8. */
export function hasOddBytes(path: string): boolean {
	for (const char of path) if (isEscape(codeOf(char))) return true;
	return false;
}

const utf8Encoder = new TextEncoder();

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

/** Any UTF-16 surrogate code unit, paired or not. */
const SURROGATE = /[\uD800-\uDFFF]/;

/** Why a string is not the decoding of any bytes. */
export type NotDecodedProblem = 'unpaired-surrogate' | 'escapes-spell-text';

/**
 * Whether the string is exactly what `decodePathBytes` gives for some bytes, so
 * that it and no other string stands for those bytes. Two ways it can fail:
 *
 * - a lone surrogate outside U+DC80 to U+DCFF stands for no byte at all, and
 *   would be written as the bytes of U+FFFD, the same as a real "�";
 * - odd-byte code points that together spell valid UTF-8 (U+DCC3 U+DCA9 is
 *   the bytes of "é") stand for the same bytes as the plain text, which is how
 *   those bytes decode.
 */
export function notDecoded(text: string): NotDecodedProblem | undefined {
	if (!SURROGATE.test(text)) return undefined;
	for (const char of text) {
		const code = codeOf(char);
		if (code >= 0xd800 && code <= 0xdfff && !isEscape(code)) return 'unpaired-surrogate';
	}
	return decodePathBytes(encodePathText(text)) === text ? undefined : 'escapes-spell-text';
}
