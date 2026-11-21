/**
 * Draws a line of a file into an element as text, never markup: tabs marked so
 * they can be told from spaces, white space at the end of a changed line
 * marked as git marks it, and characters that cannot be seen, or turn text
 * round, shown by their code (`line-pieces.ts`), and its text coloured by
 * language when its colours are known, each kind of code a class of its own
 * (`code-keyword`, `code-string`, ...) that the page's styles colour.
 *
 * Matches of a search are marked on it, the one the person is on apart from
 * the others (`search/marks.ts`).
 *
 * The line is built with `textContent` rather than a template, so no white
 * space of the template's own can slip into code drawn with its white space kept.
 * It is drawn again only when what it shows changed, so marking a search's
 * matches costs a comparison on every line that has none.
 */
import type { Action } from 'svelte/action';
import type { ColourRun } from '#lib/core/highlight/colour-run.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import { LINE_PIECE_SHAPE, linePieces, type LinePiece } from '#lib/core/viewer/line-pieces.ts';
import { markedRuns, withMarks, type Mark, type MarkKind } from '#lib/core/search/marks.ts';

export interface DrawnLine {
	readonly text: LineText;
	/** A changed line, whose trailing white space is marked. */
	readonly changed: boolean;
	/** Its colours, in order; none for a line drawn plain. */
	readonly runs?: readonly ColourRun[] | undefined;
	/** A search's matches on it, in order. */
	readonly marks?: readonly Mark[] | undefined;
}

function span(className: string, text: string, title?: string): HTMLSpanElement {
	const element = document.createElement('span');
	element.className = className;
	element.textContent = text;
	if (title !== undefined) element.title = title;
	return element;
}

function nodeOf(piece: LinePiece): Node {
	switch (piece.kind) {
		case 'text':
			return piece.colour === undefined
				? document.createTextNode(piece.text)
				: span(`code-${piece.colour}`, piece.text);
		case 'tab':
			return span('tab', '\t');
		case 'trailing':
			return span('trailing', piece.text, 'White space at the end of the line');
		case 'escape':
			return span('escape', piece.shown, `A character that is not seen: ${piece.shown}`);
	}
}

/** Pieces' nodes, inside one mark when they are part of a match. */
export function markedNodes(nodes: readonly Node[], mark: MarkKind): readonly Node[] {
	if (mark === undefined) return nodes;
	const element = document.createElement('mark');
	element.className = mark === 'current' ? 'match current' : 'match';
	element.append(...nodes);
	return [element];
}

function sameMarks(a: readonly Mark[] | undefined, b: readonly Mark[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	return a.every((m, i) => {
		const other = b[i];
		return (
			other !== undefined &&
			m.start === other.start &&
			m.length === other.length &&
			m.current === other.current
		);
	});
}

export const drawLine: Action<HTMLElement, DrawnLine> = (node, line) => {
	let shown: DrawnLine | undefined;
	const draw = (drawn: DrawnLine): void => {
		if (
			shown !== undefined &&
			shown.text === drawn.text &&
			shown.changed === drawn.changed &&
			shown.runs === drawn.runs &&
			sameMarks(shown.marks, drawn.marks)
		) {
			return;
		}
		shown = drawn;
		const pieces = linePieces(drawn.text, drawn.changed, drawn.runs);
		const runs = markedRuns(withMarks(pieces, drawn.marks ?? [], LINE_PIECE_SHAPE));
		node.replaceChildren(...runs.flatMap((run) => markedNodes(run.pieces.map(nodeOf), run.mark)));
	};
	draw(line);
	return { update: draw };
};
