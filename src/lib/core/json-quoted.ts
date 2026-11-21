import { isHiddenCharacter } from './hidden-characters.ts';

/**
 * Text written as a JSON string, so it stays on one line and says exactly what
 * it holds: `JSON.stringify`, with every character that cannot be seen or that
 * turns text round (`hidden-characters.ts`: U+2028, U+2029, U+0085, U+202E,
 * U+200B and the like) written as a `\uHHHH` escape too, which JSON leaves as
 * they are and which some readers take for line breaks or draw reversed. What
 * the string holds is unchanged. Used for every piece of an agent's or a
 * repository's text that an answer quotes.
 */
export function jsonQuoted(text: string): string {
	let out = '';
	for (const character of JSON.stringify(text)) {
		out += isHiddenCharacter(character) ? unicodeEscape(character) : character;
	}
	return out;
}

/** A character as JSON's `\uHHHH` escapes, one per UTF-16 code unit. */
function unicodeEscape(character: string): string {
	let out = '';
	for (let i = 0; i < character.length; i += 1) {
		out += `\\u${character.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
	}
	return out;
}
