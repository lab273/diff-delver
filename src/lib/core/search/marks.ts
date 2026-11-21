/**
 * Marking matches on text drawn in pieces (a line's `line-pieces.ts`, a path's
 * `shown-path.tiny.ts`): pieces of text are cut where a match starts or ends,
 * so each piece lies wholly inside one match or outside every match, and a
 * piece that cannot be cut, such as an escape standing for one character, is
 * marked when it starts inside a match.
 */
import type { TextMatch } from './find-text.ts';

/** A match to mark on drawn text, and whether it is the one the person is on. */
export interface Mark extends TextMatch {
	readonly current: boolean;
}

/** A piece as drawn: outside any match, inside one, or inside the current one. */
export type MarkKind = 'match' | 'current' | undefined;

export interface MarkedPiece<P> {
	readonly piece: P;
	readonly mark: MarkKind;
}

/** How a kind of piece is measured and cut. */
export interface PieceShape<P> {
	/** How many characters of the searched text it stands for. */
	readonly size: (piece: P) => number;
	/** Characters `from` to `to` of a piece of text; undefined for one that cannot be cut. */
	readonly cut: (piece: P, from: number, to: number) => P | undefined;
}

function markAt(marks: readonly Mark[], at: number): MarkKind {
	for (const mark of marks) {
		if (at >= mark.start && at < mark.start + mark.length)
			return mark.current ? 'current' : 'match';
	}
	return undefined;
}

/** The pieces, cut where marks start and end, each with its mark. Marks are in order and do not overlap. */
export function withMarks<P>(
	pieces: readonly P[],
	marks: readonly Mark[],
	shape: PieceShape<P>
): readonly MarkedPiece<P>[] {
	if (marks.length === 0) return pieces.map((piece) => ({ piece, mark: undefined }));
	const edges = new Set<number>();
	for (const mark of marks) {
		edges.add(mark.start);
		edges.add(mark.start + mark.length);
	}
	const out: MarkedPiece<P>[] = [];
	let at = 0;
	for (const piece of pieces) {
		const size = shape.size(piece);
		let from = 0;
		for (let i = 1; i <= size; i += 1) {
			if (i < size && !edges.has(at + i)) continue;
			const part = from === 0 && i === size ? piece : shape.cut(piece, from, i);
			if (part === undefined) {
				// A piece that cannot be cut is marked as a whole, by where it starts.
				out.push({ piece, mark: markAt(marks, at) });
				break;
			}
			out.push({ piece: part, mark: markAt(marks, at + from) });
			from = i;
		}
		if (size === 0) out.push({ piece, mark: undefined });
		at += size;
	}
	return out;
}

/** A run of pieces drawn together: outside any match, or inside one mark of one kind. */
export interface MarkedRun<P> {
	readonly pieces: readonly P[];
	readonly mark: MarkKind;
}

/** Marked pieces as runs, so a match cut by colours is drawn as one mark, not several. */
export function markedRuns<P>(marked: readonly MarkedPiece<P>[]): readonly MarkedRun<P>[] {
	const runs: { pieces: P[]; mark: MarkKind }[] = [];
	for (const { piece, mark } of marked) {
		const last = runs.at(-1);
		if (last !== undefined && last.mark === mark) last.pieces.push(piece);
		else runs.push({ pieces: [piece], mark });
	}
	return runs;
}
