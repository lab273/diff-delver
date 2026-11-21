import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * Where the next page of a paged answer starts (`get_manifest`, `get_diff`):
 * `v<version>-f<file>-l<line>-<key>`, such as `v2-f40-l0-k1f3a`. The version is
 * the one the first page was of, so a page is never stitched onto another
 * version's; the file and line say where to carry on; the key stands for the
 * filters the first page was asked with, so a cursor is never used with others.
 * Agents copy it as it is; it is not meant to be written by hand.
 */
export type PageCursor = Tiny<string, 'PageCursor'>;

export interface CursorPosition {
	readonly version: number;
	/** The index of the file to carry on from, in the list the filters give. */
	readonly file: number;
	/** The index of the line of that file's text to carry on from. */
	readonly line: number;
	readonly key: string;
}

export interface InvalidPageCursor {
	readonly kind: 'InvalidPageCursor';
	readonly value: string;
}

const CURSOR = /^v(\d{1,9})-f(\d{1,9})-l(\d{1,9})-(k[0-9a-z]{1,16})$/;

export function parsePageCursor(value: string): Result<CursorPosition, InvalidPageCursor> {
	const match = CURSOR.exec(value);
	if (match === null) return err({ kind: 'InvalidPageCursor', value });
	const [, version, file, line, key] = match;
	return ok({ version: Number(version), file: Number(file), line: Number(line), key: key ?? '' });
}

export function pageCursor(position: CursorPosition): PageCursor {
	return `v${String(position.version)}-f${String(position.file)}-l${String(position.line)}-${position.key}` as PageCursor;
}

/**
 * The key of some filters: a short hash of their text, `k` and up to eight
 * base-36 digits. Two different filters may share one, rarely; the version and
 * position are checked besides.
 */
export function filterKey(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `k${hash.toString(36)}`;
}
