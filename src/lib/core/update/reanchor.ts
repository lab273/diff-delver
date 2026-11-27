/**
 * Where a thread's lines are in a later tree (DESIGN 6.2 step 5, 6.3): an
 * earlier review's comment is on lines of one side of a file, and when the
 * Delve is updated it follows them, through git's diff between the two
 * versions' heads (for a comment on the new side) or bases (the old side).
 *
 * A line git leaves unchanged is followed to its new number, through a rename
 * too. Lines git replaced are followed to what replaced them, so a comment on
 * a line the agent then rewrote sits on the rewritten line and says its code
 * changed. Lines inserted inside the range, between two of its lines, are
 * taken into it and count as a change; lines inserted just before or after it
 * are not its lines. When every line of it was removed and nothing replaced
 * them, or its file was deleted, turned into another kind of file, or the two
 * trees cannot be compared, its lines are gone: the thread is kept, outdated,
 * with the code it was on quoted.
 *
 * A thread on the old side is on the code before the change: git's diff
 * between the two versions' bases rarely touches it, since the base seldom
 * moves. What changes is whether the change still removes it, so
 * `followThread` also counts its code changed when the earlier version's diff
 * removed some of its lines and the later one's no longer removes them all:
 * the agent put that code back, or kept it.
 *
 * Pure, and in proportion to the file's hunks and the range's length.
 */
import type { Diff } from '../diff/diff.ts';
import type { FileDiff } from '../diff/file-diff.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { lineNumberOf } from '../line-number.tiny.ts';
import type { CommentAnchor } from '../review/draft-comment.ts';
import type { TreeChanges } from './line-map.ts';

/** A thread's lines in the later tree, or that they are gone. */
export type Reanchored =
	| {
			readonly kind: 'lines';
			readonly anchor: CommentAnchor;
			/** Whether git changed any of its lines, or put lines among them. */
			readonly edited: boolean;
	  }
	| { readonly kind: 'gone' };

/**
 * One place git edited a file: `oldCount` lines from `oldStart` removed (none
 * for an insertion, which then sits before old line `oldStart`), and
 * `newCount` lines from `newStart` put in their place.
 */
interface Edit {
	readonly oldStart: number;
	readonly oldCount: number;
	readonly newStart: number;
	readonly newCount: number;
}

/**
 * Where `anchor`, on lines of the earlier tree, is in the later one, given
 * git's diff between the two trees of its side.
 */
export function reanchor(anchor: CommentAnchor, changes: TreeChanges): Reanchored {
	if (changes.kind === 'unrelated') return { kind: 'gone' };
	const file = changes.files.find(
		(f) => f.old?.path === anchor.path && f.status !== 'copied' && f.status !== 'added'
	);
	// git does not list the file: nothing in it changed.
	if (file === undefined) return { kind: 'lines', anchor, edited: false };
	const later = file.new;
	if (later === undefined || file.content.kind !== 'text') return { kind: 'gone' };
	switch (file.status) {
		case 'modified':
		case 'renamed':
			break;
		case 'deleted':
		case 'type-changed':
		case 'copied':
		case 'added':
			return { kind: 'gone' };
	}
	const edits = editsOf(file);
	const first = Number(anchor.first);
	const last = Number(anchor.last);
	let low = Number.POSITIVE_INFINITY;
	let high = 0;
	let edited = false;
	const take = (from: number, to: number): void => {
		if (from < low) low = from;
		if (to > high) high = to;
	};
	let shift = 0;
	let next = 0;
	for (let line = first; line <= last; line += 1) {
		// Edits wholly before this line move it.
		for (let e = edits[next]; e !== undefined && e.oldStart + e.oldCount <= line; e = edits[next]) {
			if (e.oldCount === 0 && e.oldStart > first) {
				// Lines put in between two of the range's own lines.
				edited = true;
				if (e.newCount > 0) take(e.newStart, e.newStart + e.newCount - 1);
			}
			shift += e.newCount - e.oldCount;
			next += 1;
		}
		const holding = edits[next];
		if (holding !== undefined && holding.oldCount > 0 && holding.oldStart <= line) {
			// Removed: what replaced it, if anything, stands for it.
			edited = true;
			if (holding.newCount > 0) take(holding.newStart, holding.newStart + holding.newCount - 1);
			continue;
		}
		take(line + shift, line + shift);
	}
	if (high === 0) return { kind: 'gone' };
	return {
		kind: 'lines',
		anchor: {
			path: later.path,
			side: anchor.side,
			first: lineNumberOf(low),
			last: lineNumberOf(high)
		},
		edited
	};
}

/** git's edits to a file, in order: each run of removed and added lines between unchanged ones. */
function editsOf(file: FileDiff): readonly Edit[] {
	if (file.content.kind !== 'text') return [];
	const edits: Edit[] = [];
	for (const hunk of file.content.hunks) {
		let lastOld = hunk.old.length === 0 ? Number(hunk.old.start) : Number(hunk.old.start) - 1;
		let lastNew = hunk.new.length === 0 ? Number(hunk.new.start) : Number(hunk.new.start) - 1;
		let open:
			{ oldStart: number; oldCount: number; newStart: number; newCount: number } | undefined;
		const close = (): void => {
			if (open !== undefined) edits.push(open);
			open = undefined;
		};
		for (const line of hunk.lines) {
			switch (line.kind) {
				case 'context':
					close();
					lastOld = line.old;
					lastNew = line.new;
					break;
				case 'deleted':
					open ??= { oldStart: lastOld + 1, oldCount: 0, newStart: lastNew + 1, newCount: 0 };
					open.oldCount += 1;
					lastOld = line.old;
					break;
				case 'added':
					open ??= { oldStart: lastOld + 1, oldCount: 0, newStart: lastNew + 1, newCount: 0 };
					open.newCount += 1;
					lastNew = line.new;
					break;
			}
		}
		close();
	}
	return edits;
}

/** The two versions' diffs and git's diffs between their trees, as an update or a catch-up reads them. */
export interface VersionChanges {
	/** git's diff from the earlier version's head tree to the later one's. */
	readonly heads: TreeChanges;
	/** git's diff from the earlier version's base tree to the later one's. */
	readonly bases: TreeChanges;
	/** The earlier version's diff; undefined when it could not be read, and the old side is followed by its tree alone. */
	readonly before: Diff | undefined;
	readonly after: Diff;
}

/**
 * Where a thread's lines are in the later version (`reanchor`, through the
 * trees of its side), with an old-side thread's code counted changed too
 * when the change no longer removes a line it removed before: each such
 * line is followed to the later tree on its own, and the later diff must
 * still remove it there. Lines of the thread the change never removed, such
 * as the unchanged lines around a removal, say nothing either way.
 */
export function followThread(anchor: CommentAnchor, changes: VersionChanges): Reanchored {
	const moved = reanchor(anchor, anchor.side === 'new' ? changes.heads : changes.bases);
	if (moved.kind === 'gone' || moved.edited || anchor.side === 'new') return moved;
	if (changes.before === undefined) return moved;
	const before = removedLines(changes.before, anchor.path);
	const after = removedLines(changes.after, moved.anchor.path);
	for (let line = Number(anchor.first); line <= Number(anchor.last); line += 1) {
		if (!before.has(line)) continue;
		const one = lineNumberOf(line);
		const there = reanchor({ ...anchor, first: one, last: one }, changes.bases);
		if (there.kind === 'gone' || there.edited) return { ...moved, edited: true };
		if (!after.has(Number(there.anchor.first))) return { ...moved, edited: true };
	}
	return moved;
}

/** The lines a diff removes from the file whose old path is `path`; a copy removes none of its source's. */
function removedLines(diff: Diff, path: RepoPath): { has(line: number): boolean } {
	const file = diff.files.find((f) => f.file.old?.path === path && f.file.status !== 'copied');
	return file === undefined ? { has: () => false } : file.changed.old;
}
