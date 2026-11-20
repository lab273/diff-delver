/** Unpacking WOFF into TrueType (scripts/woff-to-sfnt.ts), on the real bundled font. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { woffToSfnt } from './woff-to-sfnt.ts';

const INTER = join(
	import.meta.dirname,
	'..',
	'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'
);

describe('woffToSfnt', () => {
	it('gives the TrueType font, of the size the WOFF header says, the same every time', async () => {
		const woff = await readFile(INTER);
		const first = woffToSfnt(woff);
		const second = woffToSfnt(woff);
		if (!first.ok || !second.ok) throw new Error('not unpacked');
		expect(first.value.readUInt32BE(0)).toBe(woff.readUInt32BE(4));
		// totalSfntSize in the WOFF header is the size of the original font.
		expect(first.value.length).toBe(woff.readUInt32BE(16));
		expect(first.value.equals(second.value)).toBe(true);
		const tags = Array.from({ length: first.value.readUInt16BE(4) }, (_, i) =>
			first.value.toString('latin1', 12 + i * 16, 16 + i * 16)
		);
		expect(tags).toContain('glyf');
		expect(tags).toContain('name');
	});

	it('refuses what is not WOFF, and a file cut short', async () => {
		expect(woffToSfnt(Buffer.from('not a font at all, really not one')).ok).toBe(false);
		const woff = await readFile(INTER);
		expect(woffToSfnt(woff.subarray(0, 60))).toMatchObject({
			ok: false,
			error: { kind: 'InvalidWoff' }
		});
	});
});
