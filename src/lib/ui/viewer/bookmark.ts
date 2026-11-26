/** A tab-local reading place, using file identity and line numbers within one version. */
import { z } from 'zod';
import { GroupKeySchema, PartQuerySchema } from '#lib/api/schemas.ts';
import type { BlockState, OpenLine, PartState } from './viewer.svelte.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';

const lineSchema = z.object({ side: z.enum(['old', 'new']), line: z.number().int().positive() });
const bookmarkSchema = PartQuerySchema.pick({ path: true }).extend({
	group: GroupKeySchema,
	version: z.number().int().positive(),
	line: lineSchema.nullable(),
	open: z.boolean()
});

export type BookmarkLine = z.infer<typeof lineSchema>;
export type Bookmark = z.infer<typeof bookmarkSchema>;

function storageKey(id: ReportId): string {
	return `diff-delver:bookmark:${id}`;
}

export function readBookmark(id: ReportId): Bookmark | undefined {
	try {
		const saved = sessionStorage.getItem(storageKey(id));
		if (saved === null) return undefined;
		const parsed = bookmarkSchema.safeParse(JSON.parse(saved));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export function saveBookmark(id: ReportId, place: Bookmark): void {
	try {
		sessionStorage.setItem(storageKey(id), JSON.stringify(place));
	} catch {
		// The page can still keep the bookmark when browser storage is unavailable.
	}
}

function lineMarker(line: BookmarkLine): string {
	return `[data-reading-line="${line.side}:${String(line.line)}"]`;
}

export function bookmarkedRow(part: HTMLElement, line: BookmarkLine): HTMLTableRowElement | null {
	return part.querySelector(lineMarker(line))?.closest('tr') ?? null;
}

/** Find the first readable row in view, without measuring every row of a long part. */
export function lineInView(part: HTMLElement, top: number, bottom: number): BookmarkLine | null {
	const rows = part.querySelector('table')?.rows;
	if (rows === undefined) return null;
	let first = 0;
	let end = rows.length;
	while (first < end) {
		const middle = Math.floor((first + end) / 2);
		if ((rows[middle]?.getBoundingClientRect().bottom ?? 0) <= top) first = middle + 1;
		else end = middle;
	}
	for (let i = first; i < rows.length; i += 1) {
		const row = rows[i];
		if (row === undefined || row.getBoundingClientRect().top >= bottom) break;
		const line = readingLine(row);
		if (line !== null) return line;
	}
	return null;
}

/** The line a row draws, the new side's first. */
export function readingLine(row: HTMLTableRowElement): BookmarkLine | null {
	const marker =
		row.querySelector('[data-reading-line^="new:"]') ??
		row.querySelector('[data-reading-line^="old:"]');
	const [side, line] = marker?.getAttribute('data-reading-line')?.split(':') ?? [];
	return side === 'old' || side === 'new' ? { side, line: Number(line) } : null;
}

export interface BookmarkDestination {
	readonly part: PartState;
	readonly block: BlockState;
	readonly index: number;
	/** Where the line is drawn in its block, counting the block's rows in reading order. */
	readonly row: number;
	/** Prefer the part that owns the change, then context drawn with its own hunk. */
	readonly priority: number;
}

export function bookmarkDestination(
	part: PartState,
	target: BookmarkLine
): BookmarkDestination | undefined {
	if (part.lines.kind !== 'loaded') return undefined;
	for (const [index, block] of part.lines.blocks.entries()) {
		if (block.kind === 'hidden') {
			const span = block[target.side];
			if (target.line >= span.first && target.line <= span.last) {
				return { part, block, index, row: target.line - span.first, priority: 1 };
			}
			continue;
		}
		for (const [row, line] of block.lines.entries()) {
			if (line.kind === 'context') {
				if (line[target.side] === target.line) {
					return { part, block, index, row, priority: block.kind === 'hunk' ? 2 : 1 };
				}
			} else if (
				line.home.kind === 'here' &&
				(line.kind === 'added'
					? target.side === 'new' && line.new === target.line
					: target.side === 'old' && line.old === target.line)
			) {
				return { part, block, index, row, priority: 3 };
			}
		}
	}
	return undefined;
}

/** The saved stretch still between the lines opened from the ends. */
export function bookmarkContext(
	block: Extract<BlockState, { kind: 'hidden' }>
): readonly OpenLine[] {
	return block.bookmark.filter(
		(line) =>
			line.new >= block.new.first + block.top.length &&
			line.new <= block.new.last - block.bottom.length
	);
}

export function* openedContext(block: Extract<BlockState, { kind: 'hidden' }>): Iterable<OpenLine> {
	yield* block.top;
	yield* bookmarkContext(block);
	yield* block.bottom;
}
