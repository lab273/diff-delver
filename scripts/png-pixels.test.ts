/** Exact PNG comparison (scripts/png-pixels.ts): one channel of one pixel is a difference. */
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { comparePngPixels } from './png-pixels.ts';

/** A PNG of the given size, filled with one colour, with some pixels changed. */
function image(
	width: number,
	height: number,
	changes: readonly { x: number; y: number; rgba: readonly number[] }[] = []
): Buffer {
	const png = new PNG({ width, height });
	png.data.fill(200);
	for (const { x, y, rgba } of changes) {
		rgba.forEach((value, c) => {
			png.data[(y * width + x) * 4 + c] = value;
		});
	}
	return PNG.sync.write(png);
}

describe('comparePngPixels', () => {
	it('finds two images with the same pixels the same', () => {
		expect(comparePngPixels(image(4, 3), image(4, 3))).toEqual({ kind: 'Same' });
	});

	it('looks at the pixels, not at how the file was compressed', () => {
		const png = PNG.sync.read(image(4, 3));
		const loose = PNG.sync.write(png, { deflateLevel: 0 });
		const tight = PNG.sync.write(png, { deflateLevel: 9 });
		expect(loose.equals(tight)).toBe(false);
		expect(comparePngPixels(loose, tight)).toEqual({ kind: 'Same' });
	});

	it('counts a difference of one in one channel of one pixel, with no tolerance', () => {
		const result = comparePngPixels(image(4, 3), image(4, 3, [{ x: 2, y: 1, rgba: [201] }]));
		expect(result.kind).toBe('Different');
		if (result.kind !== 'Different') return;
		expect(result.pixels).toBe(1);
		const diff = PNG.sync.read(result.diff);
		expect([...diff.data.subarray((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)]).toEqual([
			255, 0, 255, 255
		]);
	});

	it('counts the pixels outside the smaller image when the sizes differ', () => {
		const result = comparePngPixels(image(4, 3), image(4, 4));
		expect(result).toMatchObject({
			kind: 'Different',
			pixels: 4,
			expectedSize: '4×3',
			actualSize: '4×4'
		});
	});
});
