/**
 * The colours kept for whole files: packed so they take only what they hold,
 * read back exactly as they were made, and never more of them kept than the
 * cache's ceiling.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseBlobId, type BlobId } from '#lib/core/blob-id.tiny.ts';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import { characterCount } from '#lib/core/character-count.tiny.ts';
import { TOKEN_KINDS, type ColourRun } from '#lib/core/highlight/colour-run.ts';
import { LONGEST_LINE_TO_COLOUR } from '#lib/core/highlight/limits.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseLineText, type LineText } from '#lib/core/line-text.tiny.ts';
import { ColourCache, PackedColours } from './file-colours.ts';

function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T {
	if (!result.ok) throw new Error('not valid');
	return result.value;
}

const blob = (n: number): BlobId => unwrap(parseBlobId(n.toString(16).padStart(40, '0')));
const bytes = (n: number): ByteSize => unwrap(parseByteSize(n));
const line = (text: string): LineText => unwrap(parseLineText(text));

const run = fc.record({
	start: fc.integer({ min: 0, max: LONGEST_LINE_TO_COLOUR }).map(characterCount),
	length: fc.integer({ min: 1, max: LONGEST_LINE_TO_COLOUR }).map(characterCount),
	kind: fc.constantFrom(...TOKEN_KINDS)
});

describe('packed colours', () => {
	it('give back every line’s runs as they were, in four bytes a run and four a line', () => {
		fc.assert(
			fc.property(fc.array(fc.array(run, { maxLength: 8 }), { maxLength: 40 }), (lines) => {
				const packed = new PackedColours(lines);
				expect(packed.lineCount).toBe(lines.length);
				for (const [i, runs] of lines.entries()) {
					expect(packed.line(lineNumberOf(i + 1))).toEqual(runs);
				}
				expect(packed.line(lineNumberOf(lines.length + 1))).toBeUndefined();
				const runs = lines.reduce((sum, l) => sum + l.length, 0);
				expect(packed.bytes).toBe(4 * runs + 4 * (lines.length + 1));
			})
		);
	});

	it('refuse a run too far along to keep, rather than keep it wrong', () => {
		const far: ColourRun = {
			start: characterCount(20_000),
			length: characterCount(1),
			kind: 'string'
		};
		expect(() => new PackedColours([[far]])).toThrow(RangeError);
	});
});

describe('the colour cache', () => {
	const file = (n: number): readonly LineText[] =>
		Array.from({ length: 50 }, (_, i) => line(`const a${String(n)}_${String(i)} = "x"; // y`));

	it('keeps no more than its ceiling, letting the files coloured longest ago go first', async () => {
		const sizes: number[] = [];
		const probe = new ColourCache(() => undefined);
		const first = await probe.colours(blob(1), 'typescript', bytes(2_000), file(1));
		if (first.kind !== 'coloured') throw new Error('not coloured');
		const one = probe.bytesKept;
		// Its colours, and a little for keeping the file at all.
		expect(one).toBeGreaterThan(first.lines.bytes);
		// Room for three files of this size.
		const cache = new ColourCache(() => undefined, one * 3 + one / 2);
		const kept = [];
		for (let n = 1; n <= 6; n += 1) {
			kept.push(cache.colours(blob(n), 'typescript', bytes(2_000), file(n)));
			await kept.at(-1);
			sizes.push(cache.bytesKept);
		}
		expect(sizes).toEqual([one, 2 * one, 3 * one, 3 * one, 3 * one, 3 * one]);
		// The newest three are kept: asked again, they are the same answer; the oldest is coloured anew.
		expect(cache.colours(blob(6), 'typescript', bytes(2_000), file(6))).toBe(kept[5]);
		expect(cache.colours(blob(4), 'typescript', bytes(2_000), file(4))).toBe(kept[3]);
		expect(cache.colours(blob(1), 'typescript', bytes(2_000), file(1))).not.toBe(kept[0]);
	});

	it('keeps a file larger than its ceiling only until the next one is done', async () => {
		const cache = new ColourCache(() => undefined, 1);
		await cache.colours(blob(1), 'typescript', bytes(2_000), file(1));
		const single = cache.bytesKept;
		expect(single).toBeGreaterThan(1);
		await cache.colours(blob(2), 'typescript', bytes(2_000), file(2));
		expect(cache.bytesKept).toBe(single);
	});
});
