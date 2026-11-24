/**
 * A comment's words as a person is shown them. The words are kept exactly as
 * they were typed; drawn, each character that cannot be seen, or that turns
 * the text around it, is written as its escape, by the rule code and paths are
 * shown by (`hidden-characters.ts`), so a comment never reads differently from
 * what it is. Line breaks stay line breaks and tabs stay tabs: they are how the
 * reviewer laid the words out, and both are seen.
 */
import { textPieces, type TextPiece } from '../hidden-characters.ts';

/** One line of a comment, in the pieces it is drawn in. */
export type CommentLine = readonly TextPiece[];

/** A line's pieces, with each tab kept as the tab it is and not written as an escape. */
function linePieces(line: string): CommentLine {
	const pieces: TextPiece[] = [];
	const put = (text: string): void => {
		const last = pieces.at(-1);
		if (last?.kind === 'text') pieces[pieces.length - 1] = { kind: 'text', text: last.text + text };
		else pieces.push({ kind: 'text', text });
	};
	for (const [at, part] of line.split('\t').entries()) {
		if (at > 0) put('\t');
		for (const piece of textPieces(part)) {
			if (piece.kind === 'text') put(piece.text);
			else pieces.push(piece);
		}
	}
	return pieces;
}

/** A comment's words, line by line, as they are drawn. */
export function commentLines(body: string): readonly CommentLine[] {
	return body.split('\n').map(linePieces);
}
