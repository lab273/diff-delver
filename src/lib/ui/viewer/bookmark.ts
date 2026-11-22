/** A tab-local reading place, using file identity and line numbers within one version. */
import { z } from 'zod';
import { GroupKeySchema, PartQuerySchema } from '#lib/api/schemas.ts';
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
export function lineInView(part: HTMLElement, top: number): BookmarkLine | null {
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
		if (row === undefined || row.getBoundingClientRect().top >= window.innerHeight) break;
		const marker =
			row.querySelector('[data-reading-line^="new:"]') ??
			row.querySelector('[data-reading-line^="old:"]');
		const [side, line] = marker?.getAttribute('data-reading-line')?.split(':') ?? [];
		if (side === 'old' || side === 'new') return { side, line: Number(line) };
	}
	return null;
}
