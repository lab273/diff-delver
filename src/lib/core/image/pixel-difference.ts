/**
 * Which pixels of an image changed (DESIGN 8.4), pure, over the RGBA bytes a
 * canvas gives: the two images lined up at their top left corners, over the
 * area of the wider and the taller. Two pixels are the same when all four of
 * their channels are, or when both are wholly see-through, whatever colour
 * they would be; a pixel only one image covers has changed. The picture this
 * gives marks each changed pixel in magenta, over a faded copy of the new
 * image, its colours taken most of the way to white so it reads as a pale
 * ground on a light background; what neither image covers, when their sizes
 * differ, is left clear.
 */
import { pixelCountOf, type PixelCount } from '../pixel-count.tiny.ts';
import { spanOf, type Dimensions } from './image-words.ts';

/** An image's pixels, row by row from the top left, four bytes each: red, green, blue and alpha. */
export interface Pixels extends Dimensions {
	readonly data: Uint8ClampedArray;
}

/** What comparing two images found: a picture of it, how many pixels changed, and of how many either covers. */
export interface PixelDifference extends Pixels {
	readonly changed: PixelCount;
	readonly compared: PixelCount;
}

/** The colour a changed pixel is marked in. */
export const CHANGED_COLOUR: readonly [number, number, number, number] = [255, 0, 255, 255];

/**
 * How much of an unchanged pixel's colour it keeps, the rest white, so the
 * image is a pale ground for the marks. Its opacity it keeps whole.
 */
export const FADED = 0.25;

/** A channel of an unchanged pixel, faded toward white. */
function faded(channel: number): number {
	return Math.round(channel * FADED + 255 * (1 - FADED));
}

/** The most pixels compared, over the area of both: 4,096 by 4,096. Larger images are not compared. */
export const MAX_COMPARED_PIXELS = 4096 * 4096;

/** Whether two images are small enough to compare, from their sizes alone. */
export function comparable(before: Dimensions, after: Dimensions): boolean {
	const span = spanOf(before, after);
	return span.width * span.height <= MAX_COMPARED_PIXELS;
}

/** Where pixel (x, y) starts in an image's data, or -1 when the image does not cover it. */
function offset(image: Pixels, x: number, y: number): number {
	return x < image.width && y < image.height ? (y * image.width + x) * 4 : -1;
}

function same(a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, j: number): boolean {
	const alphaA = a[i + 3] ?? 0;
	const alphaB = b[j + 3] ?? 0;
	if (alphaA === 0 && alphaB === 0) return true;
	return alphaA === alphaB && a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2];
}

/** Compares two images pixel by pixel, lined up at their top left corners. */
export function pixelDifference(before: Pixels, after: Pixels): PixelDifference {
	const { width, height } = spanOf(before, after);
	const data = new Uint8ClampedArray(width * height * 4);
	let changed = 0;
	let compared = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const out = (y * width + x) * 4;
			const i = offset(before, x, y);
			const j = offset(after, x, y);
			if (i === -1 && j === -1) continue;
			compared += 1;
			if (i !== -1 && j !== -1 && same(before.data, i, after.data, j)) {
				data[out] = faded(after.data[j] ?? 0);
				data[out + 1] = faded(after.data[j + 1] ?? 0);
				data[out + 2] = faded(after.data[j + 2] ?? 0);
				data[out + 3] = after.data[j + 3] ?? 0;
				continue;
			}
			changed += 1;
			data.set(CHANGED_COLOUR, out);
		}
	}
	return {
		width,
		height,
		data,
		changed: pixelCountOf(changed),
		compared: pixelCountOf(compared)
	};
}
