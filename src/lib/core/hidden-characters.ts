/**
 * Characters that are not seen, or change how the text around them is drawn
 * (DESIGN 8.3): control characters, zero-width spaces, the controls that
 * reverse text direction, a byte-order mark, line and paragraph separators,
 * and code points with no character. Code and paths are shown with each of
 * them written as an escape, so neither reads differently from what it is.
 *
 * One rule for both: `\xHH` for a character below U+0080 and `\uHHHH` from
 * there up, so an escape never looks like the `\xHH` (80 to FF) a path uses
 * for a byte that is not valid UTF-8 (`escaped-path.tiny.ts`).
 */

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]/u;

/** Whether one character (one code point) is hidden, as above. */
export function isHiddenCharacter(character: string): boolean {
	return HIDDEN.test(character);
}

/** A hidden character written as an escape: `\x07`, `\r`, `\u202E`. */
export function escapeCharacter(character: string): string {
	if (character === '\r') return '\\r';
	const code = character.codePointAt(0) ?? 0;
	const hex = code.toString(16).toUpperCase();
	return code < 0x80 ? `\\x${hex.padStart(2, '0')}` : `\\u${hex.padStart(4, '0')}`;
}

/**
 * Text, such as a folder's name, with each hidden character written as its
 * escape. For a repository path, `shownPath` (`shown-path.tiny.ts`) also keeps
 * names that are not valid UTF-8 and backslashes apart.
 */
export function visibleText(text: string): string {
	let out = '';
	for (const character of text)
		out += isHiddenCharacter(character) ? escapeCharacter(character) : character;
	return out;
}
