/**
 * The colours of whole files, worked out when first asked for and kept for
 * the daemon's life, so a part's lines, the unchanged lines opened around
 * them and the whole file all agree, and a file is coloured once however
 * often it is shown. A file is kept by its git object id and language, so the
 * same file in two versions of a diff, or in two diffs, is coloured once.
 *
 * What is kept is packed: each run of colour in four bytes and each line in
 * four more (`PackedColours`), so a file's colours take what they hold and no
 * more, about 20 bytes a line for ordinary code. Files coloured longest ago
 * are let go first once more than `MOST_BYTES_KEPT` are kept: that, with one
 * file being coloured at a time at most per request, is the cache's ceiling.
 */
import type { BlobId } from '#lib/core/blob-id.tiny.ts';
import type { ByteSize } from '#lib/core/byte-size.tiny.ts';
import { characterCount } from '#lib/core/character-count.tiny.ts';
import { TOKEN_KINDS, type ColourRun, type TokenKind } from '#lib/core/highlight/colour-run.ts';
import type { Language } from '#lib/core/highlight/language.ts';
import { tooMuchToColour } from '#lib/core/highlight/limits.ts';
import type { LineNumber } from '#lib/core/line-number.tiny.ts';
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
	| { readonly kind: 'coloured'; readonly lines: PackedColours }
	| { readonly kind: 'plain'; readonly reason: PlainReason };

/**
 * How many bytes of colours are kept at most, across every file: 64 MiB.
 * Measured, 300,000 lines of ordinary TypeScript take 6.9 MB of the heap this
 * way, against 76 MB kept as objects, and 300,000 lines of 140 runs each take
 * 265 MB against 3 GB; the heap a full cache takes is at most about one and a
 * half times what it counts.
 */
export const MOST_BYTES_KEPT = 64 * 1024 * 1024;

/** What keeping one file costs besides its colours, counted so that many small files are bounded too. */
const BYTES_PER_FILE = 512;

/** A run's start and length each take this many bits of its four bytes, and its kind the rest. */
const POSITION_BITS = 14;
const MOST_POSITION = 2 ** POSITION_BITS - 1;

/**
 * A file's colours, packed: for each line, its runs of colour in order, each
 * run one 32-bit number (its start, its length and its kind), and where each
 * line's runs begin. A run that would not fit, which the limit on a line's
 * length rules out, is an error, so a file is never coloured wrongly.
 */
export class PackedColours {
	readonly #runs: Uint32Array;
	/** Line `i`'s runs are `#runs[#starts[i]]` up to `#starts[i + 1]`. */
	readonly #starts: Uint32Array;

	constructor(lines: readonly (readonly ColourRun[])[]) {
		this.#starts = new Uint32Array(lines.length + 1);
		let total = 0;
		for (const runs of lines) total += runs.length;
		this.#runs = new Uint32Array(total);
		let at = 0;
		for (const [i, runs] of lines.entries()) {
			this.#starts[i] = at;
			for (const run of runs) {
				if (run.start > MOST_POSITION || run.length > MOST_POSITION) {
					throw new RangeError(`A run of colour at ${String(run.start)} is too far along to keep`);
				}
				const kind = TOKEN_KINDS.indexOf(run.kind);
				this.#runs[at] =
					((kind << (2 * POSITION_BITS)) | (run.start << POSITION_BITS) | run.length) >>> 0;
				at += 1;
			}
		}
		this.#starts[lines.length] = at;
	}

	/** How many lines the file has. */
	get lineCount(): number {
		return this.#starts.length - 1;
	}

	/** The bytes the colours take. */
	get bytes(): number {
		return this.#runs.byteLength + this.#starts.byteLength;
	}

	/** The runs of colour of line `number`, or undefined past the end of the file. */
	line(number: LineNumber): readonly ColourRun[] | undefined {
		const from = this.#starts[number - 1];
		const to = this.#starts[number];
		if (from === undefined || to === undefined) return undefined;
		const runs: ColourRun[] = [];
		for (let at = from; at < to; at += 1) {
			const packed = this.#runs[at] ?? 0;
			const kind: TokenKind | undefined = TOKEN_KINDS[packed >>> (2 * POSITION_BITS)];
			if (kind === undefined) throw new RangeError('A kept run of colour has no kind');
			runs.push({
				start: characterCount((packed >>> POSITION_BITS) & MOST_POSITION),
				length: characterCount(packed & MOST_POSITION),
				kind
			});
		}
		return runs;
	}
}

export class ColourCache {
	/** By blob and language, oldest first; a colouring under way is kept as its promise. */
	readonly #kept = new Map<string, { colours: Promise<FileColours>; bytes: number }>();
	#bytes = 0;
	readonly #log: (line: string) => void;
	readonly #most: number;

	/** `log` hears why a file could not be coloured; `most` is how many bytes are kept at most. */
	constructor(log: (line: string) => void, most: number = MOST_BYTES_KEPT) {
		this.#log = log;
		this.#most = most;
	}

	/** How many bytes the colours kept take. */
	get bytesKept(): number {
		return this.#bytes;
	}

	/** The colours of the file `blob`, of `size` bytes and these lines, in `language`. */
	colours(
		blob: BlobId,
		language: Language | undefined,
		size: ByteSize,
		lines: readonly LineText[]
	): Promise<FileColours> {
		if (language === undefined) return Promise.resolve({ kind: 'plain', reason: 'language' });
		const tooMuch = tooMuchToColour(size, lines.length);
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
			(coloured): FileColours => {
				const packed = new PackedColours(coloured);
				// Counted once it is done, if it is still kept.
				const kept = this.#kept.get(key);
				if (kept?.colours === colours) {
					kept.bytes = packed.bytes + BYTES_PER_FILE;
					this.#bytes += kept.bytes;
					this.#letGo(key);
				}
				return { kind: 'coloured', lines: packed };
			},
			(error: unknown): FileColours => {
				this.#log(`Could not colour ${blob} as ${language}: ${String(error)}`);
				return { kind: 'plain', reason: 'failed' };
			}
		);
		this.#kept.set(key, { colours, bytes: 0 });
		return colours;
	}

	/** Lets go of the files coloured longest ago until no more than the most is kept, `keep` aside. */
	#letGo(keep: string): void {
		for (const [oldest, entry] of this.#kept) {
			if (this.#bytes <= this.#most) break;
			if (oldest === keep) continue;
			this.#kept.delete(oldest);
			this.#bytes -= entry.bytes;
		}
	}
}
