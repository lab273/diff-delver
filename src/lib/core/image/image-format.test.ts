import { describe, expect, it } from 'vitest';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import {
	bytesToKnowFormat,
	contentTypeOf,
	imageFormatOf,
	namedAsImage,
	SVG_BYTES
} from './image-format.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const bytes = (...values: readonly (number | string)[]): Uint8Array =>
	new Uint8Array(
		values.flatMap((v) =>
			typeof v === 'number' ? [v] : Array.from({ length: v.length }, (_, i) => v.charCodeAt(i))
		)
	);

const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = bytes('GIF89a', 1, 0);
const WEBP = bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ');

describe('image formats', () => {
	it('are known by name before the bytes are read', () => {
		for (const name of ['a.png', 'b/c.JPG', 'd.jpeg', 'e.gif', 'f.webp', 'g.svg']) {
			expect(namedAsImage(path(name))).toBe(true);
		}
		for (const name of ['a.txt', 'png', '.png', 'b.png.bak', 'c.svgz', 'dir.png/file']) {
			expect(namedAsImage(path(name))).toBe(false);
		}
	});

	it('are what the bytes say among the raster formats, whatever the extension', () => {
		expect(imageFormatOf(path('a.png'), PNG)).toBe('png');
		expect(imageFormatOf(path('a.jpg'), JPEG)).toBe('jpeg');
		expect(imageFormatOf(path('a.gif'), GIF)).toBe('gif');
		expect(imageFormatOf(path('a.webp'), WEBP)).toBe('webp');
		// A JPEG named as a PNG is served as the JPEG it is.
		expect(imageFormatOf(path('photo.png'), JPEG)).toBe('jpeg');
		// A file named as a PNG that is none is no image, nor are bytes with no name for them.
		expect(imageFormatOf(path('a.png'), bytes(0x89, 'PNG', 0, 1, 2, 3))).toBeUndefined();
		expect(imageFormatOf(path('a.png'), new Uint8Array())).toBeUndefined();
		expect(imageFormatOf(path('a.bin'), PNG)).toBeUndefined();
	});

	it('takes an SVG to be text holding an svg element', () => {
		const svg = bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>\n');
		expect(imageFormatOf(path('logo.svg'), svg)).toBe('svg');
		expect(imageFormatOf(path('logo.svg'), bytes('<html></html>'))).toBeUndefined();
		expect(imageFormatOf(path('logo.svg'), bytes('<svg', 0))).toBeUndefined();
		// Raster bytes are not an SVG, nor an SVG a raster image.
		expect(imageFormatOf(path('logo.svg'), PNG)).toBeUndefined();
		expect(imageFormatOf(path('logo.png'), svg)).toBeUndefined();
		// Its svg element must start within its first SVG_BYTES, as only those are read.
		const late = (at: number) =>
			new Uint8Array([...bytes(`<!--${' '.repeat(at - 7)}-->`), ...bytes('<svg/>')]);
		expect(imageFormatOf(path('logo.svg'), late(SVG_BYTES - 4))).toBe('svg');
		expect(imageFormatOf(path('logo.svg'), late(SVG_BYTES))).toBeUndefined();
		expect(bytesToKnowFormat(path('logo.svg'))).toBe(SVG_BYTES);
		expect(bytesToKnowFormat(path('logo.png'))).toBeGreaterThanOrEqual(12);
	});

	it('are served with their content type', () => {
		expect(contentTypeOf('png')).toBe('image/png');
		expect(contentTypeOf('jpeg')).toBe('image/jpeg');
		expect(contentTypeOf('gif')).toBe('image/gif');
		expect(contentTypeOf('webp')).toBe('image/webp');
		expect(contentTypeOf('svg')).toBe('image/svg+xml');
	});
});
