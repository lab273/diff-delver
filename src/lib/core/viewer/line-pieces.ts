/**
 * A line of a file as the page draws it (DESIGN 8.3): its text in pieces, so
 * that what cannot be seen, or could fool the eye, is shown for what it is.
 *
 * - A tab is kept as a tab, marked so it can be told from spaces.
 * - White space at the end of a changed line is marked, as git marks it.
 * - A carriage return at the end, from a file with CRLF line endings, is shown
 *   as `\r`, so a change of line endings is not a change of nothing.
 * - Control characters, and characters that change how text is drawn without
 *   being seen (zero-width spaces, the controls that reverse text direction, a
 *   byte-order mark, line and paragraph separators) are shown as escapes, such
 *   as `\x07` or `‮`, so code never reads differently from what it is.
 *
 * Everything else is text, drawn as text: never markup.
 */
import type { LineText } from '../line-text.tiny.ts';

export type LinePiece =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tab' }
	/** White space at the end of a changed line. */
	| { readonly kind: 'trailing'; readonly text: string }
	/** A character shown by its code, such as `\x1B`, with the character itself kept. */
	| { readonly kind: 'escape'; readonly shown: string; readonly character: string };

/** Characters that are not seen, or change how text around them is drawn. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]/u;

function escapeOf(character: string): string {
	const code = character.codePointAt(0) ?? 0;
	if (character === '\r') return '\\r';
	const hex = code.toString(16).toUpperCase();
	return code < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u${hex.padStart(4, '0')}`;
}

/**
 * The pieces of a line. `markTrailing` marks white space at its end, for a
 * changed line; a context line's is left alone, as git leaves it.
 */
export function linePieces(text: LineText, markTrailing: boolean): readonly LinePiece[] {
	const pieces: LinePiece[] = [];
	let end = text.length;
	if (markTrailing) {
		let at = text.endsWith('\r') ? text.length - 1 : text.length;
		while (at > 0 && (text.charAt(at - 1) === ' ' || text.charAt(at - 1) === '\t')) at -= 1;
		end = at;
	}
	let plain = '';
	const flush = (): void => {
		if (plain !== '') pieces.push({ kind: 'text', text: plain });
		plain = '';
	};
	let index = 0;
	for (const character of text) {
		const here = index;
		index += character.length;
		if (here >= end && (character === ' ' || character === '\t')) {
			flush();
			const last = pieces.at(-1);
			if (last?.kind === 'trailing') {
				pieces[pieces.length - 1] = { kind: 'trailing', text: last.text + character };
			} else pieces.push({ kind: 'trailing', text: character });
			continue;
		}
		if (character === '\t') {
			flush();
			pieces.push({ kind: 'tab' });
		} else if (HIDDEN.test(character)) {
			flush();
			pieces.push({ kind: 'escape', shown: escapeOf(character), character });
		} else plain += character;
	}
	flush();
	return pieces;
}
