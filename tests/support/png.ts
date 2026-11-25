/**
 * Writing PNG files from pixels, for fixture repositories with images: eight
 * bits per channel, RGBA, no interlacing and no colour profile, so every
 * browser decodes the same pixels. Pure apart from Node's zlib.
 */
import { crc32, deflateSync } from 'node:zlib';

/** A colour as red, green, blue and alpha, each 0 to 255. */
export type Colour = readonly [number, number, number, number];

/** An image to write: its size and the colour of each pixel, by its column and row from the top left. */
export interface Picture {
	readonly width: number;
	readonly height: number;
	readonly pixel: (x: number, y: number) => Colour;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.byteLength);
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const check = Buffer.alloc(4);
	check.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, check]);
}

/** The bytes of a PNG file of the picture. */
export function encodePng(picture: Picture): Uint8Array {
	const { width, height } = picture;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bits per channel
	header[9] = 6; // RGBA
	// Compression, filter and interlace methods stay 0.
	const rows = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y += 1) {
		const start = y * (1 + width * 4);
		rows[start] = 0; // no filter
		for (let x = 0; x < width; x += 1) {
			const [r, g, b, a] = picture.pixel(x, y);
			rows.set([r, g, b, a], start + 1 + x * 4);
		}
	}
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', header),
			chunk('IDAT', deflateSync(rows)),
			chunk('IEND', new Uint8Array())
		])
	);
}

/** A picture of one colour with rectangles drawn over it, the later ones on top. */
export function drawn(
	width: number,
	height: number,
	background: Colour,
	rectangles: readonly {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
		readonly colour: Colour;
	}[]
): Picture {
	return {
		width,
		height,
		pixel: (x, y) => {
			let colour = background;
			for (const r of rectangles) {
				if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) colour = r.colour;
			}
			return colour;
		}
	};
}
