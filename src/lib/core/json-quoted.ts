/**
 * Text written as a JSON string, so it stays on one line and says exactly what
 * it holds: `JSON.stringify`, with U+2028 and U+2029 escaped too, which JSON
 * leaves as they are and which some readers take for line breaks. Used for
 * every piece of an agent's or a repository's text that an answer quotes.
 */
export function jsonQuoted(text: string): string {
	return JSON.stringify(text)
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}
