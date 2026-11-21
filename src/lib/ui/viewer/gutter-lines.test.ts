import { expect, it } from 'vitest';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { ROWS_PER_CHUNK } from '#lib/core/viewer/chunks.ts';
import { sideBySide } from '#lib/core/viewer/side-by-side.ts';
import { GutterLines, type GutterRow } from './gutter-lines.ts';

const line = lineNumberOf;
const numbered = (count: number) => Array.from({ length: count }, (_, i) => line(i + 1));

it('follows the same side past rows occupied only by the other side', () => {
	const old = numbered(1000);
	const rows = [
		{ old: line(1), new: line(1) },
		...old.map((n) => ({ old: line(n + 1), new: undefined })),
		{ old: line(1002), new: line(2), chunk: 'hunk:1000' }
	];
	const lines = new GutterLines(rows);
	expect(lines.destination({ side: 'new', line: line(1) }, 'ArrowDown')).toMatchObject({
		line: 2,
		chunk: 'hunk:1000'
	});
	expect(lines.destination({ side: 'new', line: line(2) }, 'ArrowUp')).toMatchObject({
		line: 1
	});
	expect(lines.destination({ side: 'old', line: line(1001) }, 'ArrowDown')).toMatchObject({
		line: 1002,
		chunk: 'hunk:1000'
	});
});

it('resolves uneven replacements by logical row in each layout', () => {
	const old = numbered(1000);
	const changes = [
		...old.map((n) => ({ old: n, new: undefined })),
		{ old: undefined, new: line(1) },
		{ old: undefined, new: line(2) }
	];
	const placed = (rows: readonly GutterRow[]) =>
		new GutterLines(
			rows.map((row, i) => ({
				...row,
				chunk: `hunk:${String(Math.floor(i / ROWS_PER_CHUNK) * ROWS_PER_CHUNK)}`
			}))
		);
	const unified = placed(changes);
	expect(unified.destination({ side: 'old', line: line(1) }, 'ArrowRight')).toMatchObject({
		side: 'new',
		line: 1,
		chunk: 'hunk:1000'
	});
	expect(unified.destination({ side: 'new', line: line(1) }, 'ArrowLeft')).toMatchObject({
		side: 'old',
		line: 1000,
		chunk: 'hunk:800'
	});

	const split = placed(
		sideBySide(changes, (row) => (row.old === undefined ? 'new' : 'old')).map((row) => ({
			old: row.old?.old,
			new: row.new?.new
		}))
	);
	expect(split.destination({ side: 'old', line: line(1000) }, 'ArrowRight')).toMatchObject({
		side: 'new',
		line: 2,
		chunk: 'hunk:0'
	});
	expect(split.destination({ side: 'new', line: line(2) }, 'ArrowLeft')).toMatchObject({
		side: 'old',
		line: 2,
		chunk: 'hunk:0'
	});
});
