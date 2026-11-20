/**
 * Exact comparison of two PNG images, pixel for pixel. No tolerance of any kind:
 * not for colour, not for anti-aliasing, not for a count of pixels. Two images are
 * the same when they have the same size and every pixel has the same red, green,
 * blue and alpha. The bytes of the files may differ (an encoder may compress the
 * same pixels differently); the pixels may not.
 */
import { PNG } from 'pngjs';
import { pixelCountOf, type PixelCount } from '../src/lib/core/pixel-count.tiny.ts';

export type PixelComparison =
	| { readonly kind: 'Same' }
	| {
			readonly kind: 'Different';
			/** How many pixels differ, counting every pixel outside the other image when the sizes differ. */
			readonly pixels: PixelCount;
			readonly expectedSize: string;
			readonly actualSize: string;
			/** The expected image, faded, with every differing pixel in solid magenta. */
			readonly diff: Buffer;
	  };

const size = (png: PNG): string => `${String(png.width)}×${String(png.height)}`;

/** Compares two PNG files' pixels exactly. */
export function comparePngPixels(expected: Buffer, actual: Buffer): PixelComparison {
	const a = PNG.sync.read(expected);
	const b = PNG.sync.read(actual);
	if (a.width === b.width && a.height === b.height && a.data.equals(b.data))
		return { kind: 'Same' };

	const width = Math.max(a.width, b.width);
	const height = Math.max(a.height, b.height);
	const diff = new PNG({ width, height });
	let pixels = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const inA = x < a.width && y < a.height;
			const inB = x < b.width && y < b.height;
			const ia = (y * a.width + x) * 4;
			const ib = (y * b.width + x) * 4;
			const same =
				inA &&
				inB &&
				a.data[ia] === b.data[ib] &&
				a.data[ia + 1] === b.data[ib + 1] &&
				a.data[ia + 2] === b.data[ib + 2] &&
				a.data[ia + 3] === b.data[ib + 3];
			if (same) {
				// Faded towards white, so the differences stand out.
				for (let c = 0; c < 3; c += 1)
					diff.data[at + c] = 255 - Math.round((255 - (a.data[ia + c] ?? 0)) / 4);
				diff.data[at + 3] = 255;
			} else {
				pixels += 1;
				diff.data[at] = 255;
				diff.data[at + 1] = 0;
				diff.data[at + 2] = 255;
				diff.data[at + 3] = 255;
			}
		}
	}
	return {
		kind: 'Different',
		pixels: pixelCountOf(pixels),
		expectedSize: size(a),
		actualSize: size(b),
		diff: PNG.sync.write(diff)
	};
}
