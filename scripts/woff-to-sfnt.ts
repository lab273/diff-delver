/**
 * Unpacks a WOFF 1.0 font into the TrueType (sfnt) file it was made from. The
 * journey browser needs one font it can open as a plain file through fontconfig
 * (tests/support/fontconfig/fonts.conf); the bundled fonts ship only as WOFF and
 * WOFF2. Lossless and deterministic: the same WOFF always gives the same bytes.
 * https://www.w3.org/TR/WOFF/
 */
import { inflateSync } from 'node:zlib';
import { err, ok, type Result } from '../src/lib/core/result.ts';

export interface InvalidWoff {
	readonly kind: 'InvalidWoff';
	readonly reason: string;
}

const WOFF_HEADER = 44;
const WOFF_ENTRY = 20;
const SFNT_HEADER = 12;
const SFNT_ENTRY = 16;

const align4 = (n: number): number => (n + 3) & ~3;

export function woffToSfnt(woff: Buffer): Result<Buffer, InvalidWoff> {
	const invalid = (reason: string): Result<Buffer, InvalidWoff> =>
		err({ kind: 'InvalidWoff', reason });
	if (woff.length < WOFF_HEADER || woff.toString('latin1', 0, 4) !== 'wOFF') {
		return invalid('it does not start with the WOFF signature');
	}
	const flavor = woff.readUInt32BE(4);
	const numTables = woff.readUInt16BE(12);
	if (woff.length < WOFF_HEADER + numTables * WOFF_ENTRY)
		return invalid('its table directory is cut short');

	const tables: { tag: number; checksum: number; data: Buffer }[] = [];
	for (let i = 0; i < numTables; i += 1) {
		const at = WOFF_HEADER + i * WOFF_ENTRY;
		const tag = woff.readUInt32BE(at);
		const offset = woff.readUInt32BE(at + 4);
		const compLength = woff.readUInt32BE(at + 8);
		const origLength = woff.readUInt32BE(at + 12);
		const checksum = woff.readUInt32BE(at + 16);
		if (offset + compLength > woff.length) return invalid('a table runs past the end of the file');
		const stored = woff.subarray(offset, offset + compLength);
		const data = compLength < origLength ? inflateSync(stored) : Buffer.from(stored);
		if (data.length !== origLength) return invalid('a table has the wrong length once unpacked');
		tables.push({ tag, checksum, data });
	}

	let entrySelector = 0;
	while (2 ** (entrySelector + 1) <= numTables) entrySelector += 1;
	const searchRange = 2 ** entrySelector * 16;

	const size =
		SFNT_HEADER +
		numTables * SFNT_ENTRY +
		tables.reduce((sum, t) => sum + align4(t.data.length), 0);
	const out = Buffer.alloc(size);
	out.writeUInt32BE(flavor, 0);
	out.writeUInt16BE(numTables, 4);
	out.writeUInt16BE(searchRange, 6);
	out.writeUInt16BE(entrySelector, 8);
	out.writeUInt16BE(numTables * 16 - searchRange, 10);
	let offset = SFNT_HEADER + numTables * SFNT_ENTRY;
	tables.forEach((table, i) => {
		const at = SFNT_HEADER + i * SFNT_ENTRY;
		out.writeUInt32BE(table.tag, at);
		out.writeUInt32BE(table.checksum, at + 4);
		out.writeUInt32BE(offset, at + 8);
		out.writeUInt32BE(table.data.length, at + 12);
		table.data.copy(out, offset);
		offset += align4(table.data.length);
	});
	return ok(out);
}
