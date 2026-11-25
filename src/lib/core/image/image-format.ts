/**
 * Which files are images the page shows as pictures (DESIGN 8.4): PNG, JPEG,
 * GIF, WebP and SVG. A file is one when its name says so and its bytes agree:
 * a raster image starts with its format's signature, whatever its extension
 * says among the five, and an SVG is text that holds an `<svg` element. So a
 * file named `.png` that holds something else is shown as the binary file it
 * is, and the content type an image is served with is the one its bytes have.
 */
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';
import { looksBinary } from '../file-text.ts';
import type { RepoPath } from '../repo-path.tiny.ts';

export const IMAGE_FORMATS = ['png', 'jpeg', 'gif', 'webp', 'svg'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** The largest image diff delver shows, in bytes: 16 MiB. A larger one is described, not shown. */
export const MAX_IMAGE_SIZE: ByteSize = (() => {
	const size = parseByteSize(16 * 1024 * 1024);
	if (!size.ok) throw new RangeError('16 MiB is a byte size');
	return size.value;
})();

const RASTER_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function extensionOf(path: RepoPath): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Whether a file's name says it is an image the page could show, before its bytes are read. */
export function namedAsImage(path: RepoPath): boolean {
	const extension = extensionOf(path);
	return extension === 'svg' || RASTER_EXTENSIONS.has(extension);
}

function startsWith(bytes: Uint8Array, at: number, expected: readonly number[]): boolean {
	return expected.every((byte, i) => bytes[at + i] === byte);
}

const ascii = (text: string): number[] =>
	Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

/** The raster format whose signature the bytes start with, if any. */
function rasterFormatOf(bytes: Uint8Array): ImageFormat | undefined {
	if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
	if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
	if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a'))) return 'gif';
	if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP'))) return 'webp';
	return undefined;
}

/** The text an `<svg` element starts with, in bytes. */
const SVG_ELEMENT = ascii('<svg');

function holdsSvgElement(bytes: Uint8Array): boolean {
	let at = bytes.indexOf(SVG_ELEMENT[0] ?? 0);
	while (at !== -1) {
		if (startsWith(bytes, at, SVG_ELEMENT)) return true;
		at = bytes.indexOf(SVG_ELEMENT[0] ?? 0, at + 1);
	}
	return false;
}

/**
 * The format of the image at `path` with these bytes, or undefined when it is
 * not an image the page shows: its name is not an image's, or its bytes are
 * not one of the five formats.
 */
export function imageFormatOf(path: RepoPath, bytes: Uint8Array): ImageFormat | undefined {
	const extension = extensionOf(path);
	if (extension === 'svg') {
		return !looksBinary(bytes) && holdsSvgElement(bytes) ? 'svg' : undefined;
	}
	if (!RASTER_EXTENSIONS.has(extension)) return undefined;
	return rasterFormatOf(bytes);
}

/** The content type an image of this format is served with. */
export function contentTypeOf(format: ImageFormat): string {
	switch (format) {
		case 'png':
			return 'image/png';
		case 'jpeg':
			return 'image/jpeg';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		case 'svg':
			return 'image/svg+xml';
	}
}

/** The format's name as a person knows it: "PNG", "SVG". */
export function formatName(format: ImageFormat): string {
	switch (format) {
		case 'png':
			return 'PNG';
		case 'jpeg':
			return 'JPEG';
		case 'gif':
			return 'GIF';
		case 'webp':
			return 'WebP';
		case 'svg':
			return 'SVG';
	}
}
