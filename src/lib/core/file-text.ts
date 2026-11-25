/**
 * Reading a file's bytes as people see them: whether it is binary, and its lines.
 * Both follow git, so a file shown whole agrees with its diff.
 */
import { parseLineText, type LineText } from './line-text.tiny.ts';

/** How far into a file git looks for a NUL byte to decide that it is binary. */
export const BINARY_PROBE_BYTES = 8000;

/**
 * Whether git would treat the content as binary: a NUL byte in its first 8000
 * bytes (git's `buffer_is_binary`). Attributes are not consulted, as in the diff.
 */
export function looksBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** Decodes as the diff text is decoded: UTF-8, with U+FFFD for bytes that are not. */
const lossy = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * The lines of a file as text, without their `\n`; a carriage return before it is
 * kept, as in the diff. A last line with no newline after it is still a line, and
 * an empty file has none.
 */
export function linesOf(bytes: Uint8Array): readonly LineText[] {
	if (bytes.length === 0) return [];
	const text = lossy.decode(bytes);
	const parts = text.split('\n');
	if (text.endsWith('\n')) parts.pop();
	return parts.map((part) => {
		const line = parseLineText(part);
		if (!line.ok) throw new Error('A line split on newlines holds a newline');
		return line.value;
	});
}
