/**
 * Images as the page draws and describes them (DESIGN 8.4): how much larger
 * a small image is drawn so its pixels can be seen, and its size in words.
 */
import type { PixelCount } from '../pixel-count.tiny.ts';
import { formatCount } from '../viewer/words.ts';

/** The width and height of an image, in pixels. */
export interface Dimensions {
	readonly width: PixelCount;
	readonly height: PixelCount;
}

/** A small image is drawn larger, by a whole number, until its longer side is about this many pixels. */
const SMALL_DRAWN_TO = 192;

/** It is never drawn more than this many times its size. */
const MOST_ENLARGED = 8;

/**
 * How many times their size images are drawn, the same for each so they line
 * up: a whole number, so each pixel is a square of screen pixels, from 1 for
 * an image at least `SMALL_DRAWN_TO` pixels on its longer side up to
 * `MOST_ENLARGED` for a tiny one. Larger images are drawn at their size, or
 * narrower when the page is.
 */
export function drawnScale(images: readonly Dimensions[]): number {
	const longest = Math.max(0, ...images.map((d) => Math.max(d.width, d.height)));
	if (longest === 0) return 1;
	return Math.max(1, Math.min(MOST_ENLARGED, Math.floor(SMALL_DRAWN_TO / longest)));
}

/** "48 × 32 pixels", "1 × 1 pixel". */
export function describeDimensions(d: Dimensions): string {
	const unit = d.width === 1 && d.height === 1 ? 'pixel' : 'pixels';
	return `${formatCount(d.width)} × ${formatCount(d.height)} ${unit}`;
}

/** Whether two images differ in width or height. */
export function sameDimensions(a: Dimensions, b: Dimensions): boolean {
	return a.width === b.width && a.height === b.height;
}

/** The size of the area both images are drawn in, lined up at the top left: the wider and the taller. */
export function spanOf(a: Dimensions, b: Dimensions): Dimensions {
	return {
		width: a.width > b.width ? a.width : b.width,
		height: a.height > b.height ? a.height : b.height
	};
}
