/**
 * Where each line of a later tree was in an earlier one, from git's diff between
 * the two (DESIGN 6.2): the heads of two versions of a diff, or their bases.
 * This is what "the same line" means when a diff is updated: a line of the later
 * tree is the same as a line of the earlier one when git's own diff of the two
 * trees leaves it unchanged, so its text is byte for byte the same and it sits
 * in the same file (followed through a rename), with only edits elsewhere moving
 * its number.
 *
 * A file git calls copied, added, binary, a submodule or a change of kind has no
 * lines that carry over: a copy is new code in a new place, however alike. A
 * path git does not list did not change at all, so every line is the same line.
 *
 * Built in one pass over the diff's hunks; a lookup is a binary search.
 */
import type { FileDiff, Hunk } from '../diff/file-diff.ts';
import type { RepoPath } from '../repo-path.tiny.ts';

/** git's diff from an earlier tree to a later one, or that the two cannot be compared. */
export type TreeChanges =
	| { readonly kind: 'diff'; readonly files: readonly FileDiff[] }
	/** The trees are not in one store, so nothing can be said to be the same. */
	| { readonly kind: 'unrelated' };

/** The same two trees: nothing changed. */
export const NO_TREE_CHANGES: TreeChanges = { kind: 'diff', files: [] };

/** A line with a letter or a digit in it, which identifies it better than punctuation does. */
export function meaningful(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text);
}

/** Where a line of the later tree was in the earlier one. */
export interface LineOrigin {
	readonly path: RepoPath;
	readonly line: number;
	/**
	 * Only punctuation and blank lines lie between this line, itself one with no
	 * letter or digit, and an edit git made next to it: its place was decided by
	 * how git lined up lines that look alike, such as the `}` of a deleted
	 * function and the `}` of a new one, so it is weak evidence of being the same
	 * line (see `carry-over.ts`).
	 */
	readonly weak: boolean;
}

/** A run of unchanged lines of the later file, `offset` from their earlier numbers. */
interface Stretch {
	readonly first: number;
	readonly last: number;
	readonly offset: number;
}

type FileOrigin =
	| {
			readonly kind: 'edited';
			readonly from: RepoPath;
			readonly stretches: readonly Stretch[];
			/** The weakly placed unchanged lines, by later number. */
			readonly weak: ReadonlySet<number>;
	  }
	| { readonly kind: 'none' };

const END = Number.MAX_SAFE_INTEGER;

export class TreeLineMap {
	readonly #files: ReadonlyMap<RepoPath, FileOrigin> | undefined;

	private constructor(files: ReadonlyMap<RepoPath, FileOrigin> | undefined) {
		this.#files = files;
	}

	static of(changes: TreeChanges): TreeLineMap {
		switch (changes.kind) {
			case 'unrelated':
				return new TreeLineMap(undefined);
			case 'diff': {
				const files = new Map<RepoPath, FileOrigin>();
				for (const file of changes.files) {
					// A deleted file has no later path to look up.
					if (file.new === undefined) continue;
					files.set(file.new.path, originOf(file));
				}
				return new TreeLineMap(files);
			}
		}
	}

	/** The earlier path of a later one whose lines can be followed; undefined when none can. */
	earlierPath(path: RepoPath): RepoPath | undefined {
		if (this.#files === undefined) return undefined;
		const origin = this.#files.get(path);
		if (origin === undefined) return path;
		switch (origin.kind) {
			case 'edited':
				return origin.from;
			case 'none':
				return undefined;
		}
	}

	/** Where line `line` of `path` in the later tree was; undefined when it is new or changed. */
	origin(path: RepoPath, line: number): LineOrigin | undefined {
		if (this.#files === undefined) return undefined;
		const origin = this.#files.get(path);
		if (origin === undefined) return { path, line, weak: false };
		switch (origin.kind) {
			case 'none':
				return undefined;
			case 'edited': {
				const stretch = stretchHolding(origin.stretches, line);
				return stretch === undefined
					? undefined
					: { path: origin.from, line: line + stretch.offset, weak: origin.weak.has(line) };
			}
		}
	}
}

function originOf(file: FileDiff): FileOrigin {
	if (file.old === undefined) return { kind: 'none' };
	switch (file.status) {
		case 'modified':
		case 'renamed':
			break;
		case 'added':
		case 'deleted':
		case 'copied':
		case 'type-changed':
			return { kind: 'none' };
	}
	switch (file.content.kind) {
		case 'text':
			return {
				kind: 'edited',
				from: file.old.path,
				stretches: stretchesOf(file.content.hunks),
				weak: weakLinesOf(file.content.hunks)
			};
		case 'binary':
		case 'submodule':
			return { kind: 'none' };
	}
}

/**
 * The unchanged lines of the later file as stretches with their offsets: every
 * line that is not an added line, between the edits the hunks make.
 */
function stretchesOf(hunks: readonly Hunk[]): readonly Stretch[] {
	const stretches: Stretch[] = [];
	let start = 1;
	let offset = 0;
	const close = (last: number): void => {
		if (start <= last) stretches.push({ first: start, last, offset });
	};
	for (const hunk of hunks) {
		let nextNew = hunk.new.length === 0 ? hunk.new.start + 1 : hunk.new.start;
		for (const line of hunk.lines) {
			switch (line.kind) {
				case 'context':
					nextNew = line.new + 1;
					break;
				case 'added':
					close(line.new - 1);
					start = line.new + 1;
					nextNew = line.new + 1;
					offset -= 1;
					break;
				case 'deleted':
					close(nextNew - 1);
					start = nextNew;
					offset += 1;
					break;
			}
		}
	}
	close(END);
	return stretches;
}

/**
 * The context lines of the hunks that are weakly placed (see `LineOrigin`): with
 * no letter or digit, and only such lines between them and an edit, looking
 * either way within the hunk.
 */
function weakLinesOf(hunks: readonly Hunk[]): ReadonlySet<number> {
	const weak = new Set<number>();
	for (const hunk of hunks) {
		for (const order of [hunk.lines, hunk.lines.toReversed()]) {
			let afterEdit = false;
			for (const line of order) {
				if (line.kind !== 'context') afterEdit = true;
				else if (afterEdit && !meaningful(line.text)) weak.add(line.new);
				else afterEdit = false;
			}
		}
	}
	return weak;
}

function stretchHolding(stretches: readonly Stretch[], line: number): Stretch | undefined {
	let low = 0;
	let high = stretches.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const stretch = stretches[middle];
		if (stretch === undefined) return undefined;
		if (line < stretch.first) high = middle - 1;
		else if (line > stretch.last) low = middle + 1;
		else return stretch;
	}
	return undefined;
}
