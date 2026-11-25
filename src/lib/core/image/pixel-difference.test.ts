import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pixelCountOf } from '../pixel-count.tiny.ts';
import {
	CHANGED_COLOUR,
	comparable,
	MAX_COMPARED_PIXELS,
	pixelDifference,
	type Pixels
} from './pixel-difference.ts';

type Colour = readonly [number, number, number, number];

function image(width: number, height: number, pixel: (x: number, y: number) => Colour): Pixels {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
	}
	return { width: pixelCountOf(width), height: pixelCountOf(height), data };
}

const BLUE: Colour = [0, 0, 255, 255];
const RED: Colour = [255, 0, 0, 255];

function at(found: Pixels, x: number, y: number): number[] {
	const i = (y * found.width + x) * 4;
	return [...found.data.subarray(i, i + 4)];
}

describe('pixel difference', () => {
	it('marks what changed in magenta over a faded copy of the new image, and counts it', () => {
		const before = image(3, 2, () => BLUE);
		const after = image(3, 2, (x, y) => (x === 1 && y === 0 ? RED : BLUE));
		const found = pixelDifference(before, after);
		expect(found.changed).toBe(1);
		expect(found.compared).toBe(6);
		expect(at(found, 1, 0)).toEqual([...CHANGED_COLOUR]);
		// Unchanged: the new image's colour at a quarter of its opacity.
		expect(at(found, 0, 0)).toEqual([0, 0, 255, 64]);
	});

	it('finds nothing changed between an image and itself, nor between two wholly see-through pixels', () => {
		const picture = image(4, 4, (x, y) => [x * 60, y * 60, 9, 255]);
		expect(pixelDifference(picture, picture).changed).toBe(0);
		const clearA = image(1, 1, () => [10, 20, 30, 0]);
		const clearB = image(1, 1, () => [99, 0, 0, 0]);
		expect(pixelDifference(clearA, clearB).changed).toBe(0);
		// A pixel only part see-through keeps its colour in the comparison.
		const halfA = image(1, 1, () => [10, 20, 30, 128]);
		const halfB = image(1, 1, () => [11, 20, 30, 128]);
		expect(pixelDifference(halfA, halfB).changed).toBe(1);
	});

	it('lines up images of different sizes at the top left; what only one covers changed, what neither covers is clear', () => {
		const wide = image(4, 1, () => BLUE);
		const tall = image(1, 3, () => BLUE);
		const found = pixelDifference(wide, tall);
		expect([found.width, found.height]).toEqual([4, 3]);
		// (0,0) both; (1..3,0) only the wide one; (0,1..2) only the tall one.
		expect(found.compared).toBe(6);
		expect(found.changed).toBe(5);
		expect(at(found, 2, 2)).toEqual([0, 0, 0, 0]);
	});

	it('counts each changed pixel once, whatever the two images hold', () => {
		const side = fc.integer({ min: 1, max: 6 });
		const colour = fc.tuple(
			fc.integer({ min: 0, max: 255 }),
			fc.integer({ min: 0, max: 255 }),
			fc.integer({ min: 0, max: 255 }),
			fc.constantFrom(0, 128, 255)
		);
		const picture = fc
			.tuple(side, side)
			.chain(([w, h]) =>
				fc
					.array(colour, { minLength: w * h, maxLength: w * h })
					.map((pixels) => image(w, h, (x, y) => pixels[y * w + x] ?? [0, 0, 0, 0]))
			);
		fc.assert(
			fc.property(picture, picture, (a, b) => {
				const found = pixelDifference(a, b);
				let marked = 0;
				for (let i = 0; i < found.data.length; i += 4) {
					if (CHANGED_COLOUR.every((c, k) => found.data[i + k] === c)) marked += 1;
				}
				// A faded pixel is never wholly opaque, so never mistaken for a mark.
				expect(marked).toBe(found.changed);
				expect(pixelDifference(b, a).changed).toBe(found.changed);
				expect(found.changed).toBeLessThanOrEqual(found.compared);
			})
		);
	});

	it('compares only images that are not too large', () => {
		const size = (w: number, h: number) => ({ width: pixelCountOf(w), height: pixelCountOf(h) });
		expect(comparable(size(4096, 4096), size(10, 10))).toBe(true);
		expect(comparable(size(4097, 10), size(10, 4096))).toBe(false);
		expect(MAX_COMPARED_PIXELS).toBe(4096 * 4096);
	});
});
