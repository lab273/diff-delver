import type { LineNumber } from '#lib/core/line-number.tiny.ts';
import type { Side } from '#lib/core/side.tiny.ts';

export interface GutterLine {
	readonly side: Side;
	readonly line: LineNumber;
}

export interface GutterRow {
	readonly old: LineNumber | undefined;
	readonly new: LineNumber | undefined;
	/** The viewer chunk holding this row, when it may need drawing. */
	readonly chunk?: string;
}

interface Position extends GutterLine {
	readonly row: number;
	readonly chunk: string | undefined;
}

type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

function rowAtOrAfter(positions: readonly Position[], row: number): number {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		const candidate = positions[middle];
		if (candidate !== undefined && candidate.row < row) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Code rows in reading order, independent of which chunks currently have DOM nodes. */
export class GutterLines {
	readonly #positions: Record<Side, Position[]> = { old: [], new: [] };
	readonly #at: Record<Side, Map<LineNumber, number>> = { old: new Map(), new: new Map() };
	readonly first: Position | undefined;

	constructor(rows: Iterable<GutterRow>) {
		let row = 0;
		for (const item of rows) {
			for (const side of ['old', 'new'] satisfies Side[]) {
				const line = item[side];
				if (line === undefined) continue;
				const position = { row, side, line, chunk: item.chunk };
				this.first ??= position;
				this.#at[side].set(line, this.#positions[side].length);
				this.#positions[side].push(position);
			}
			row += 1;
		}
	}

	destination(from: GutterLine, arrow: Arrow): Position | undefined {
		const at = this.#at[from.side].get(from.line);
		if (at === undefined) return undefined;
		const positions = this.#positions[from.side];
		switch (arrow) {
			case 'ArrowUp':
				return positions[at - 1];
			case 'ArrowDown':
				return positions[at + 1];
			case 'ArrowLeft':
				return from.side === 'new' ? this.#across(positions[at], 'old') : undefined;
			case 'ArrowRight':
				return from.side === 'old' ? this.#across(positions[at], 'new') : undefined;
		}
	}

	#across(from: Position | undefined, side: Side): Position | undefined {
		if (from === undefined) return undefined;
		const positions = this.#positions[side];
		const at = rowAtOrAfter(positions, from.row);
		const before = positions[at - 1];
		const after = positions[at];
		if (before === undefined) return after;
		if (after === undefined) return before;
		return from.row - before.row <= after.row - from.row ? before : after;
	}
}
