/**
 * The carry-over's invariants (DESIGN 6.2), over random histories of a few
 * files: a base, a head edited from it, a later head edited from that, and a
 * base that may have moved too, with random sections, ignored lines and marks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbitraryAssignRequest, marksFrom } from '../../../../tests/support/synthetic-diff.ts';
import {
	diffOf,
	treeDiff,
	type Tree,
	type TreeDiffOptions
} from '../../../../tests/support/tree-diffs.ts';
import { assign } from '../diff/assign.ts';
import { autoIgnore } from '../diff/auto-ignore.ts';
import type { Bucket } from '../diff/bucket.ts';
import { coverage } from '../diff/coverage.ts';
import type { Diff } from '../diff/diff.ts';
import { fileAssignment, initialState, sideMap, type AssignmentState } from '../diff/state.ts';
import { linesInSet, fileUnitInSet, unitSetSize, type UnitSet } from '../diff/unit-set.ts';
import { sameReviewedMarks } from '../review/reviewed-marks.ts';
import type { Side } from '../side.tiny.ts';
import {
	assignmentRowsOf,
	assignmentStateFromRows,
	reviewedMarksFromRows,
	reviewedRowsOf,
	sameAssignmentState
} from '../storage/stored-units.ts';
import { carryOver } from './carry-over.ts';
import { MARK_DISTANCE } from './carry-over.ts';
import { NO_TREE_CHANGES, TreeLineMap } from './line-map.ts';

const TEXTS = ['', '}', '{', '  return x;', 'alpha', 'beta', 'gamma', 'delta', '// note'];
const PATHS = ['a.ts', 'b.ts', 'src/c.ts', 'pnpm-lock.yaml'];

const content = fc.array(fc.constantFrom(...TEXTS), { maxLength: 14 });

interface Edit {
	readonly at: number;
	readonly remove: number;
	readonly insert: readonly string[];
}

const edit: fc.Arbitrary<Edit> = fc.record({
	at: fc.nat(16),
	remove: fc.nat(3),
	insert: fc.array(fc.constantFrom(...TEXTS), { maxLength: 3 })
});

function applyEdits(lines: readonly string[], edits: readonly Edit[]): readonly string[] {
	let out = [...lines];
	for (const e of edits) {
		const at = Math.min(e.at, out.length);
		out = [...out.slice(0, at), ...e.insert, ...out.slice(at + e.remove)];
	}
	return out;
}

/** A tree edited from another: some files edited, some dropped, maybe one added. */
function editedTree(from: Tree): fc.Arbitrary<Tree> {
	const paths = [...from.keys()];
	return fc
		.tuple(
			fc.array(fc.array(edit, { maxLength: 3 }), {
				minLength: paths.length,
				maxLength: paths.length
			}),
			fc.array(fc.boolean(), { minLength: paths.length, maxLength: paths.length }),
			fc.option(fc.tuple(fc.constantFrom(...PATHS), content))
		)
		.map(([edits, drop, added]) => {
			const out = new Map<string, readonly string[]>();
			for (const [i, path] of paths.entries()) {
				// Mostly kept: a dropped file is one in eight.
				if (drop[i] === true && i % 4 === 0) continue;
				out.set(path, applyEdits(from.get(path) ?? [], edits[i] ?? []));
			}
			if (added !== null && !out.has(added[0])) out.set(added[0], added[1]);
			return out;
		});
}

const baseTree: fc.Arbitrary<Tree> = fc
	.subarray(PATHS, { minLength: 1 })
	.chain((paths) => fc.tuple(...paths.map((p) => content.map((c) => [p, c] as const))))
	.map((entries) => new Map(entries));

interface History {
	readonly base: Tree;
	readonly head: Tree;
	readonly base2: Tree;
	readonly head2: Tree;
	/** Renames in the second diff and between the heads, when the later head moved a file. */
	readonly second: TreeDiffOptions;
	readonly heads: TreeDiffOptions;
}

/** Moves a file of the tree to `moved/<path>`, if it has it. */
function moved(t: Tree, path: string | null): { tree: Tree; renames: Record<string, string> } {
	const lines = path === null ? undefined : t.get(path);
	if (path === null || lines === undefined) return { tree: t, renames: {} };
	const out = new Map(t);
	out.delete(path);
	out.set(`moved/${path}`, lines);
	return { tree: out, renames: { [path]: `moved/${path}` } };
}

const history: fc.Arbitrary<History> = baseTree.chain((base) =>
	editedTree(base).chain((head) =>
		fc
			.tuple(fc.boolean(), editedTree(base), editedTree(head), fc.option(fc.constantFrom(...PATHS)))
			.map(([rebased, edited, later, move]) => {
				const base2 = rebased ? edited : base;
				const renamed = head.has(move ?? '') ? moved(later, move) : moved(later, null);
				const fromBase = Object.keys(renamed.renames).every((p) => base2.has(p));
				return {
					base,
					head,
					base2,
					head2: renamed.tree,
					heads: { renames: renamed.renames },
					second: fromBase ? { renames: renamed.renames } : {}
				};
			})
	)
);

/** A history with a random sorting of its first diff and random marks on it. */
const scenario = history.chain((h) => {
	const before = diffOf(h.base, h.head);
	return fc.tuple(
		fc.constant(h),
		fc.constant(before),
		fc.array(arbitraryAssignRequest(before), { maxLength: 6 }),
		fc.array(fc.boolean(), { minLength: 1, maxLength: 40 })
	);
});

function sorted(diff: Diff, requests: Parameters<typeof assign>[2]): AssignmentState {
	return assign(diff, autoIgnore(diff, initialState(diff)).state, requests).state;
}

/** Each change line's text, with whether it is in the set, its bucket and whether it is marked. */
interface LineFacts {
	readonly side: Side;
	readonly text: string;
	readonly bucket: Bucket;
	readonly marked: boolean;
	readonly fresh: boolean;
}

function facts(diff: Diff, state: AssignmentState, marks: UnitSet, fresh: UnitSet): LineFacts[] {
	const out: LineFacts[] = [];
	for (const file of diff.files) {
		const path = file.file.path;
		const assignment = fileAssignment(state, file);
		if (file.file.content.kind !== 'text') continue;
		for (const hunk of file.file.content.hunks) {
			for (const line of hunk.lines) {
				if (line.kind === 'context') continue;
				const side: Side = line.kind === 'deleted' ? 'old' : 'new';
				const number = line.kind === 'deleted' ? line.old : line.new;
				const value = sideMap(assignment, side).get(number);
				if (value === undefined) throw new Error('A change line has no assignment.');
				out.push({
					side,
					text: line.text,
					bucket: value.bucket,
					marked: linesInSet(marks, path, side).has(number),
					fresh: linesInSet(fresh, path, side).has(number)
				});
			}
		}
	}
	return out;
}

/**
 * The marked lines that have, within MARK_DISTANCE shown lines of them in the
 * same hunk, a new line, or a pair of neighbouring shown lines that were not
 * neighbours in the previous version's tree: an edit lies between them. Worked
 * out from git's line maps, not as the carry-over does it.
 */
function marksNearChanges(
	diff: Diff,
	marks: UnitSet,
	fresh: UnitSet,
	maps: { readonly heads: TreeLineMap; readonly bases: TreeLineMap }
): readonly string[] {
	const found: string[] = [];
	for (const file of diff.files) {
		const path = file.file.path;
		for (const hunk of file.hunks.values()) {
			const shown = hunk.lines;
			const isMarked = (i: number): boolean => {
				const line = shown[i];
				if (line === undefined || line.kind === 'context') return false;
				return line.kind === 'added'
					? linesInSet(marks, path, 'new').has(line.new)
					: linesInSet(marks, path, 'old').has(line.old);
			};
			const isNew = (i: number): boolean => {
				const line = shown[i];
				if (line === undefined || line.kind === 'context') return false;
				return line.kind === 'added'
					? linesInSet(fresh, path, 'new').has(line.new)
					: linesInSet(fresh, path, 'old').has(line.old);
			};
			/** Whether the shown lines from `first` to `last` hold an edit on one side. */
			const edited = (first: number, last: number, side: Side): boolean => {
				const map = side === 'new' ? maps.heads : maps.bases;
				const at = side === 'new' ? file.file.new?.path : file.file.old?.path;
				if (at === undefined) return false;
				let previous: { path: string; line: number } | undefined;
				for (let i = first; i <= last; i += 1) {
					const line = shown[i];
					if (line === undefined) continue;
					const n =
						line.kind === 'context'
							? side === 'new'
								? line.new
								: line.old
							: line.kind === 'added'
								? side === 'new'
									? line.new
									: undefined
								: side === 'old'
									? line.old
									: undefined;
					if (n === undefined) continue;
					const origin = map.origin(at, n);
					if (origin === undefined) return true;
					if (previous !== undefined) {
						if (origin.path !== previous.path || origin.line !== previous.line + 1) return true;
					}
					previous = origin;
				}
				return false;
			};
			for (let i = 0; i < shown.length; i += 1) {
				if (!isMarked(i)) continue;
				const first = Math.max(0, i - MARK_DISTANCE);
				const last = Math.min(shown.length - 1, i + MARK_DISTANCE);
				let near = edited(first, last, 'new') || edited(first, last, 'old');
				for (let j = first; j <= last; j += 1) if (isNew(j)) near = true;
				if (near) found.push(`${path} ${hunk.id} line ${String(i)}`);
			}
		}
	}
	return found;
}

function tally(keys: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	return counts;
}

function bucketKey(bucket: Bucket): string {
	switch (bucket.kind) {
		case 'section':
			return `section:${bucket.section}`;
		case 'ignored':
			return `ignored:${JSON.stringify(bucket.by)}`;
		case 'uncategorised':
			return 'uncategorised';
	}
}

/** Every count in `small` is at most its count in `large`. */
function within(small: Map<string, number>, large: Map<string, number>): boolean {
	return [...small].every(([key, count]) => count <= (large.get(key) ?? 0));
}

describe('carry-over invariants', () => {
	it('holds them after any history', () => {
		fc.assert(
			fc.property(scenario, ([h, before, requests, flags]) => {
				const state = sorted(before, requests);
				const marks = marksFrom(before, flags);
				const after = diffOf(h.base2, h.head2, h.second);
				const carried = carryOver({
					previous: { diff: before, state, marks },
					diff: after,
					heads: { kind: 'diff', files: treeDiff(h.head, h.head2, h.heads) },
					bases: { kind: 'diff', files: treeDiff(h.base, h.base2) }
				});

				// Every change unit of the new diff is in exactly one bucket.
				const rows = assignmentStateFromRows(after, assignmentRowsOf(after, carried.state));
				expect(rows.ok).toBe(true);
				const covered = coverage(after, carried.state);
				const inSections = [...covered.sections.values()].reduce((sum, t) => sum + t.units, 0);
				expect(covered.uncategorised.units + covered.ignored.units + inSections).toBe(
					after.unitCount
				);
				// Marks and new units are units of the new diff, and never both.
				expect(reviewedMarksFromRows(after, reviewedRowsOf(carried.marks)).ok).toBe(true);
				expect(reviewedMarksFromRows(after, reviewedRowsOf(carried.fresh)).ok).toBe(true);
				for (const [path, file] of carried.marks.files) {
					if (file.file) expect(fileUnitInSet(carried.fresh, path)).toBe(false);
					expect(file.old.intersect(linesInSet(carried.fresh, path, 'old')).isEmpty).toBe(true);
					expect(file.new.intersect(linesInSet(carried.fresh, path, 'new')).isEmpty).toBe(true);
				}

				const old = facts(before, state, marks, { files: new Map() });
				const now = facts(after, carried.state, carried.marks, carried.fresh);
				// No mark appears on a line that was not marked before: each marked line
				// of the new diff has a marked line with the same text and side before.
				const markedKey = (f: LineFacts) => `${f.side}\0${f.text}`;
				expect(
					within(
						tally(now.filter((f) => f.marked).map(markedKey)),
						tally(old.filter((f) => f.marked).map(markedKey))
					)
				).toBe(true);
				// A matched line keeps its bucket: every line that is not new has a line
				// with the same text, side and bucket before. New lines are not reviewed.
				const placedKey = (f: LineFacts) => `${f.side}\0${f.text}\0${bucketKey(f.bucket)}`;
				const matched = now.filter((f) => !f.fresh);
				expect(within(tally(matched.map(placedKey)), tally(old.map(placedKey)))).toBe(true);
				expect(now.filter((f) => f.fresh && f.marked)).toEqual([]);
				// New lines start not sorted yet, unless a built-in rule ignored them.
				expect(
					now.filter(
						(f) => f.fresh && f.bucket.kind !== 'uncategorised' && f.bucket.kind !== 'ignored'
					)
				).toEqual([]);

				// No mark within MARK_DISTANCE shown lines of a new line or of an edit between the versions.
				expect(
					marksNearChanges(after, carried.marks, carried.fresh, {
						heads: TreeLineMap.of({ kind: 'diff', files: treeDiff(h.head, h.head2, h.heads) }),
						bases: TreeLineMap.of({ kind: 'diff', files: treeDiff(h.base, h.base2) })
					})
				).toEqual([]);

				// The summary agrees with the states.
				const s = carried.summary;
				expect(s.newToReview + s.newIgnored).toBe(unitSetSize(carried.fresh));
				expect(s.gone).toBe(before.unitCount - (after.unitCount - unitSetSize(carried.fresh)));
				expect(s.reviewedBefore).toBe(unitSetSize(marks));
				expect(s.reviewedKept).toBe(unitSetSize(carried.marks));
				expect(s.reviewedKept).toBeLessThanOrEqual(s.reviewedBefore);
				expect(s.filesGone).toBeLessThanOrEqual(s.filesChanged);
				// A file at one path is one file, however it changed.
				const paths = new Set([...before.files, ...after.files].map((f) => f.file.path));
				expect(s.filesChanged).toBeLessThanOrEqual(paths.size);
				if (s.filesChanged === 0) {
					expect(unitSetSize(carried.fresh)).toBe(0);
					expect(s.gone).toBe(0);
				}
			}),
			{ numRuns: 150 }
		);
	});

	it('changes nothing when the diff is the same', () => {
		fc.assert(
			fc.property(scenario, ([, before, requests, flags]) => {
				const state = sorted(before, requests);
				const marks = marksFrom(before, flags);
				const carried = carryOver({
					previous: { diff: before, state, marks },
					diff: before,
					heads: NO_TREE_CHANGES,
					bases: NO_TREE_CHANGES
				});
				expect(sameAssignmentState(before, state, carried.state)).toBe(true);
				expect(sameReviewedMarks(marks, carried.marks)).toBe(true);
				expect(unitSetSize(carried.fresh)).toBe(0);
				expect(carried.summary.filesChanged).toBe(0);
			}),
			{ numRuns: 100 }
		);
	});
});
