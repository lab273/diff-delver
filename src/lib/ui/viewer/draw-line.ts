/**
 * Draws a line of a file into an element as text, never markup: tabs marked so
 * they can be told from spaces, white space at the end of a changed line
 * marked as git marks it, and characters that cannot be seen, or turn text
 * round, shown by their code (`line-pieces.ts`).
 *
 * The line is built with `textContent` rather than a template, so no white
 * space of the template's own can slip into code drawn with its white space kept.
 */
import type { Action } from 'svelte/action';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import { linePieces, type LinePiece } from '#lib/core/viewer/line-pieces.ts';

export interface DrawnLine {
	readonly text: LineText;
	/** A changed line, whose trailing white space is marked. */
	readonly changed: boolean;
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
			return document.createTextNode(piece.text);
		case 'tab':
			return span('tab', '\t');
		case 'trailing':
			return span('trailing', piece.text, 'White space at the end of the line');
		case 'escape':
			return span('escape', piece.shown, `A character that is not seen: ${piece.shown}`);
	}
}

export const drawLine: Action<HTMLElement, DrawnLine> = (node, line) => {
	const draw = (drawn: DrawnLine): void => {
		node.replaceChildren(...linePieces(drawn.text, drawn.changed).map(nodeOf));
	};
	draw(line);
	return { update: draw };
};
