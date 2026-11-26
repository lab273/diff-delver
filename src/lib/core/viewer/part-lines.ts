/**
 * What one part shows when it is open (DESIGN 4.3, 8.3): its file's hunks in
 * order, and between them the unchanged lines git did not show, as places the
 * reviewer can open.
 *
 * - A hunk holding any of this part's changes is shown whole: context lines,
 *   this part's own changes (with whether each is new since the previous
 *   version), and changes that belong to another group, which are shown muted
 *   with where they are, never hidden.
 * - A hunk holding none of this part's changes is shown as one block that says
 *   where its changes are, so the unchanged lines around it are never taken for
 *   the whole file, and context opened next to it never runs across changed lines.
 * - Between them, and above the first and below the last, the unchanged lines
 *   are hidden: the same lines on both sides, numbered on each. They are read
 *   from the head tree, so a file deleted or added whole has none, and the end
 *   of a file needs its line count, which the caller reads.
 *
 * A file whose change has no lines (a rename, a mode change), but has text on
 * both sides, shows its whole content as unchanged lines to open.
 */
import type { DiffFile } from '../diff/diff.ts';
import type { AddedLine, ContextLine, DeletedLine, Hunk, HunkSpan } from '../diff/file-diff.ts';
import {
	fileSlices,
	PATH_ORDER,
	placeId,
	type GroupKey,
	type Place,
	type SliceHunk,
	type StepsOf
} from '../diff/slices.ts';
import type { ViewKind } from '../diff/slices.ts';
import type { OrderStep } from '../order-step.tiny.ts';
import type { AssignmentState } from '../diff/state.ts';
import { linesInSet, type UnitSet } from '../diff/unit-set.ts';
import type { HunkId } from '../hunk-id.tiny.ts';
import type { LineCount } from '../line-count.tiny.ts';
import { lineNumberOf, type LineNumber } from '../line-number.tiny.ts';
import type { LineText } from '../line-text.tiny.ts';

/** Lines `first` to `last` of one side. */
export interface LineSpan {
	readonly first: LineNumber;
	readonly last: LineNumber;
}

/** Where a changed line of the part belongs. */
export type LineHome =
	/** One of this part's own changes. */
	| { readonly kind: 'here'; readonly fresh: boolean }
	/** A change read in another place, another group or another step of this one, shown muted. */
	| { readonly kind: 'elsewhere'; readonly group: GroupKey; readonly step: OrderStep | undefined };

export type ShownLine =
	| { readonly kind: 'context'; readonly line: ContextLine }
	| { readonly kind: 'deleted'; readonly line: DeletedLine; readonly home: LineHome }
	| { readonly kind: 'added'; readonly line: AddedLine; readonly home: LineHome };

export type PartBlock =
	/** Unchanged lines not shown: the same lines on both sides. */
	| { readonly kind: 'hidden'; readonly old: LineSpan; readonly new: LineSpan }
	/** A hunk with changes of this part. */
	| {
			readonly kind: 'hunk';
			readonly id: HunkId;
			/** The text git shows after the second `@@`, usually the enclosing function. */
			readonly heading: LineText;
			readonly lines: readonly ShownLine[];
	  }
	/** A hunk with none of this part's changes: where they are, and its lines if opened. */
	| {
			readonly kind: 'elsewhere';
			readonly id: HunkId;
			readonly places: readonly Place[];
			readonly lines: readonly ShownLine[];
	  };

/** How many lines of a side come before a hunk (see `HunkSpan`). */
function before(span: HunkSpan): number {
	return span.length === 0 ? span.start : span.start - 1;
}

function hidden(oldFirst: number, newFirst: number, count: number): PartBlock | undefined {
	if (count <= 0) return undefined;
	return {
		kind: 'hidden',
		old: { first: lineNumberOf(oldFirst), last: lineNumberOf(oldFirst + count - 1) },
		new: { first: lineNumberOf(newFirst), last: lineNumberOf(newFirst + count - 1) }
	};
}

/** A hunk's lines as one slice classifies them, with each change's home seen from `partPlace`. */
function shown(
	sliceHunk: SliceHunk,
	slicePlace: Place,
	partPlace: Place,
	file: DiffFile,
	fresh: UnitSet
): readonly ShownLine[] {
	const part = placeId(partPlace);
	const freshOld = linesInSet(fresh, file.file.path, 'old');
	const freshNew = linesInSet(fresh, file.file.path, 'new');
	return sliceHunk.lines.map((l): ShownLine => {
		if (l.kind === 'context') return { kind: 'context', line: l.line };
		const place: Place = l.kind === 'own' ? slicePlace : { group: l.group, step: l.step };
		const here = placeId(place) === part;
		const elsewhere: LineHome = { kind: 'elsewhere', group: place.group, step: place.step };
		const line = l.line;
		switch (line.kind) {
			case 'added':
				return {
					kind: 'added',
					line,
					home: here ? { kind: 'here', fresh: freshNew.has(line.new) } : elsewhere
				};
			case 'deleted':
				return {
					kind: 'deleted',
					line,
					home: here ? { kind: 'here', fresh: freshOld.has(line.old) } : elsewhere
				};
		}
	});
}

/**
 * The blocks of one part: the part of `file` in `place` in `view`, with
 * `steps` the reading orders. `headLineCount` is how many lines the file has
 * in the head tree, for the unchanged lines below its last hunk; undefined
 * when it has no text there.
 */
export function partBlocks(
	file: DiffFile,
	place: Place,
	state: AssignmentState,
	view: ViewKind,
	fresh: UnitSet,
	headLineCount: LineCount | undefined,
	steps: StepsOf = PATH_ORDER
): readonly PartBlock[] {
	const wanted = placeId(place);
	// Each hunk once, as the first slice holding it classifies it, and whether this part holds it.
	const hunks = new Map<HunkId, { readonly hunk: SliceHunk; readonly place: Place }>();
	const ours = new Set<HunkId>();
	for (const { group, step, slice } of fileSlices(file, state, view, steps)) {
		const at: Place = { group, step };
		for (const h of slice.hunks) {
			if (!hunks.has(h.hunk.id)) hunks.set(h.hunk.id, { hunk: h, place: at });
			if (placeId(at) === wanted) {
				ours.add(h.hunk.id);
				hunks.set(h.hunk.id, { hunk: h, place: at });
			}
		}
	}
	const blocks: PartBlock[] = [];
	const bothSides = file.file.old !== undefined && file.file.new !== undefined;
	let oldDone = 0;
	let newDone = 0;
	const ordered: readonly Hunk[] = [...file.hunks.values()];
	for (const hunk of ordered) {
		if (bothSides) {
			const gap = hidden(oldDone + 1, newDone + 1, before(hunk.new) - newDone);
			if (gap !== undefined) blocks.push(gap);
		}
		oldDone = before(hunk.old) + hunk.old.length;
		newDone = before(hunk.new) + hunk.new.length;
		const found = hunks.get(hunk.id);
		if (found === undefined) continue;
		const lines = shown(found.hunk, found.place, place, file, fresh);
		if (ours.has(hunk.id)) {
			blocks.push({ kind: 'hunk', id: hunk.id, heading: hunk.heading, lines });
		} else {
			const places = new Map<string, Place>();
			for (const line of lines) {
				if (line.kind !== 'context' && line.home.kind === 'elsewhere') {
					const at = { group: line.home.group, step: line.home.step };
					places.set(placeId(at), at);
				}
			}
			blocks.push({ kind: 'elsewhere', id: hunk.id, places: [...places.values()], lines });
		}
	}
	if (bothSides && headLineCount !== undefined) {
		const gap = hidden(oldDone + 1, newDone + 1, headLineCount - newDone);
		if (gap !== undefined) blocks.push(gap);
	}
	return blocks;
}
