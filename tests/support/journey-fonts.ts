/**
 * The one font the journey browser's fontconfig knows (tests/support/fontconfig/
 * fonts.conf): the bundled Inter, unpacked from the app's WOFF into TrueType.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { woffToSfnt } from '../../scripts/woff-to-sfnt.ts';

const REPOSITORY = join(import.meta.dirname, '..', '..');
const SOURCE = join(REPOSITORY, 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff');
/** Must match the <dir> in fonts.conf. */
const DIRECTORY = join(REPOSITORY, 'node_modules/.cache/diff-delver-journey-fonts');

/** Writes the TrueType file, if it is not there already with the same bytes. */
export function prepareJourneyFonts(): void {
	const sfnt = woffToSfnt(readFileSync(SOURCE));
	if (!sfnt.ok) {
		throw new Error(
			`Could not unpack ${SOURCE}: ${sfnt.error.reason}. Run pnpm install to restore the font.`
		);
	}
	const target = join(DIRECTORY, 'Inter-Regular.ttf');
	let current: Buffer | undefined;
	try {
		current = readFileSync(target);
	} catch {
		current = undefined;
	}
	if (current?.equals(sfnt.value) === true) return;
	mkdirSync(DIRECTORY, { recursive: true });
	writeFileSync(target, sfnt.value);
}
