import { describe, expect, it } from 'vitest';
import { pixelCountOf } from '../pixel-count.tiny.ts';
import { describeDimensions, drawnScale, sameDimensions, spanOf } from './image-words.ts';
import { compareModeName, COMPARE_MODES, nextCompareMode } from './compare-modes.ts';

const size = (w: number, h: number) => ({ width: pixelCountOf(w), height: pixelCountOf(h) });

describe('images in words', () => {
	it('draws a small image larger, by a whole number, the same for both sides', () => {
		expect(drawnScale([size(48, 32)])).toBe(4);
		expect(drawnScale([size(40, 16), size(64, 24)])).toBe(3);
		expect(drawnScale([size(4, 4)])).toBe(8);
		expect(drawnScale([size(800, 600)])).toBe(1);
		expect(drawnScale([])).toBe(1);
		expect(drawnScale([size(0, 0)])).toBe(1);
	});

	it('says an image’s size and whether two differ', () => {
		expect(describeDimensions(size(1280, 720))).toBe('1,280 × 720 pixels');
		expect(describeDimensions(size(1, 1))).toBe('1 × 1 pixel');
		expect(sameDimensions(size(3, 4), size(3, 4))).toBe(true);
		expect(sameDimensions(size(3, 4), size(4, 3))).toBe(false);
		expect(spanOf(size(40, 16), size(30, 24))).toEqual(size(40, 24));
	});

	it('steps through the ways to compare, back to the first', () => {
		expect(COMPARE_MODES.map(compareModeName)).toEqual([
			'Side by side',
			'Slider',
			'Onion skin',
			'Pixel difference'
		]);
		expect(nextCompareMode('side-by-side')).toBe('slider');
		expect(nextCompareMode('pixel-difference')).toBe('side-by-side');
	});
});
