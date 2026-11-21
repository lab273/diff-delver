/**
 * The colours of whole files, worked out when first asked for and kept for
 * the daemon's life, so a part's lines, the unchanged lines opened around
 * them and the whole file all agree, and a file is coloured once however
 * often it is shown. A file is kept by its git object id and language, so the
 * same file in two versions of a diff, or in two diffs, is coloured once;
 * files coloured longest ago are let go first when more than
 * `MOST_LINES_KEPT` lines are kept.
 */
import type { BlobId } from '#lib/core/blob-id.tiny.ts';
import type { ColourRun } from '#lib/core/highlight/colour-run.ts';
import type { Language } from '#lib/core/highlight/language.ts';
import { tooMuchToColour } from '#lib/core/highlight/limits.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import { colourLines } from './highlighter.ts';

/** Why a side of a file is shown plain. */
export type PlainReason =
	/** Its language is not one diff delver colours. */
	| 'language'
	/** It is too large to colour (`limits.ts`). */
	| 'large'
	/** Its lines are so long it looks minified. */
	| 'minified'
	/** It is binary. */
	| 'binary'
	/** Colouring it failed; the daemon's log says why. */
	| 'failed';

export type FileColours =
	| { readonly kind: 'coloured'; readonly lines: readonly (readonly ColourRun[])[] }
	| { readonly kind: 'plain'; readonly reason: PlainReason };

/** How many lines' colours are kept at most, across every file. */
export const MOST_LINES_KEPT = 300_000;

export class ColourCache {
	/** By blob and language, oldest first; a colouring under way is kept as its promise. */
	readonly #kept = new Map<string, { colours: Promise<FileColours>; lines: number }>();
	#lines = 0;

	/** The colours of the file `blob`, of `bytes` bytes and these lines, in `language`. */
	readonly #log: (line: string) => void;

	/** `log` hears why a file could not be coloured. */
	constructor(log: (line: string) => void) {
		this.#log = log;
	}

	colours(
		blob: BlobId,
		language: Language | undefined,
		bytes: number,
		lines: readonly LineText[]
	): Promise<FileColours> {
		if (language === undefined) return Promise.resolve({ kind: 'plain', reason: 'language' });
		const tooMuch = tooMuchToColour(bytes, lines.length);
		if (tooMuch !== undefined) return Promise.resolve({ kind: 'plain', reason: tooMuch });
		const key = `${blob}\u0000${language}`;
		const found = this.#kept.get(key);
		if (found !== undefined) {
			// Used again: now the newest.
			this.#kept.delete(key);
			this.#kept.set(key, found);
			return found.colours;
		}
		const colours = colourLines(lines, language).then(
			(coloured): FileColours => ({ kind: 'coloured', lines: coloured }),
			(error: unknown): FileColours => {
				this.#log(`Could not colour ${blob} as ${language}: ${String(error)}`);
				return { kind: 'plain', reason: 'failed' };
			}
		);
		this.#kept.set(key, { colours, lines: lines.length });
		this.#lines += lines.length;
		for (const [oldest, entry] of this.#kept) {
			if (this.#lines <= MOST_LINES_KEPT || oldest === key) break;
			this.#kept.delete(oldest);
			this.#lines -= entry.lines;
		}
		return colours;
	}
}
