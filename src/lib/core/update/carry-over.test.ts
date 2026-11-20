import { describe, expect, it } from 'vitest';
import {
	diffOf,
	tree,
	treeDiff,
	type Tree,
	type TreeDiffOptions
} from '../../../../tests/support/tree-diffs.ts';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { assign, type AssignRequest } from '../diff/assign.ts';
import { autoIgnore } from '../diff/auto-ignore.ts';
import type { Diff } from '../diff/diff.ts';
import { fileAssignment, initialState, sideMap, type AssignmentState } from '../diff/state.ts';
import {
	fileUnitInSet,
	fileUnitsOf,
	linesInSet,
	unitSetSize,
	type UnitSet
} from '../diff/unit-set.ts';
import { RangeSet } from '../range-set.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { NO_MARKS, sameReviewedMarks, type ReviewedMarks } from '../review/reviewed-marks.ts';
import type { Side } from '../side.tiny.ts';
import { sameAssignmentState } from '../storage/stored-units.ts';
import { listFiles } from '../reports/file-list.ts';
import { carryOver, type CarriedOver } from './carry-over.ts';
import { NO_TREE_CHANGES } from './line-map.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const numbered = (prefix: string, count: number): readonly string[] =>
	Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}`);

/** Every change unit of a diff marked reviewed. */
function allMarked(diff: Diff): ReviewedMarks {
	return {
		files: new Map(
			diff.files.map((f) => [
				f.file.path,
				{ old: f.changed.old, new: f.changed.new, file: f.hasFileUnit }
			])
		)
	};
}

function sorted(diff: Diff, requests: readonly AssignRequest[] = []): AssignmentState {
	const start = autoIgnore(diff, initialState(diff)).state;
	return assign(diff, start, requests).state;
}

interface Scenario {
	readonly base: Tree;
	readonly head: Tree;
	/** The new base; the same as `base` unless the base moved (a rebase). */
	readonly base2?: Tree;
	readonly head2: Tree;
	/** Renames and copies in the first diff, the second, between the heads and between the bases. */
	readonly first?: TreeDiffOptions;
	readonly second?: TreeDiffOptions;
	readonly heads?: TreeDiffOptions;
	readonly bases?: TreeDiffOptions;
	readonly requests?: readonly AssignRequest[];
	readonly marks?: (diff: Diff) => ReviewedMarks;
}

function update(s: Scenario): CarriedOver & { readonly before: Diff; readonly after: Diff } {
	const base2 = s.base2 ?? s.base;
	const before = diffOf(s.base, s.head, s.first);
	const after = diffOf(base2, s.head2, s.second);
	const state = sorted(before, s.requests);
	const marks = (s.marks ?? allMarked)(before);
	const carried = carryOver({
		previous: { diff: before, state, marks },
		diff: after,
		heads: { kind: 'diff', files: treeDiff(s.head, s.head2, s.heads) },
		bases: { kind: 'diff', files: treeDiff(s.base, base2, s.bases) }
	});
	return { ...carried, before, after };
}

function side(set: UnitSet, file: string, which: Side): readonly number[] {
	return [...linesInSet(set, path(file), which).values()];
}

function bucketOf(state: AssignmentState, diff: Diff, file: string, which: Side, line: number) {
	const f = diff.byPath.get(path(file));
	if (f === undefined) throw new Error(file);
	return sideMap(fileAssignment(state, f), which).get(line);
}

const BASE = tree({ 'app.ts': numbered('line', 20) });

describe('carry-over', () => {
	it('changes nothing when the diff is the same', () => {
		const head = tree({ 'app.ts': [...numbered('line', 10), 'added', ...numbered('more', 10)] });
		const before = diffOf(BASE, head);
		const state = sorted(before, [{ file: 'app.ts', section: 'alpha' }]);
		const marks = allMarked(before);
		const carried = carryOver({
			previous: { diff: before, state, marks },
			diff: before,
			heads: NO_TREE_CHANGES,
			bases: NO_TREE_CHANGES
		});
		expect(sameAssignmentState(before, state, carried.state)).toBe(true);
		expect(sameReviewedMarks(marks, carried.marks)).toBe(true);
		expect(unitSetSize(carried.fresh)).toBe(0);
		expect(carried.summary).toEqual({
			filesChanged: 0,
			filesGone: 0,
			newToReview: 0,
			newIgnored: 0,
			gone: 0,
			reviewedBefore: before.unitCount,
			reviewedKept: before.unitCount
		});
	});

	it('keeps a change whose context shifted because of edits above it', () => {
		const head = tree({
			'app.ts': [...numbered('line', 15), 'added here', ...numbered('line', 20).slice(15)]
		});
		// Three lines inserted at the top, far from the change.
		const head2 = tree({ 'app.ts': ['top 1', 'top 2', 'top 3', ...(head.get('app.ts') ?? [])] });
		const r = update({ base: BASE, head, head2 });
		// The change moved from +16 to +19 and keeps its mark; the new top lines are new.
		expect(side(r.marks, 'app.ts', 'new')).toEqual([19]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([1, 2, 3]);
		expect(r.summary.newToReview).toBe(3);
		expect(r.summary.reviewedKept).toBe(r.summary.reviewedBefore);
	});

	it('keeps the sorting of a line that now sits beside new lines, but not its mark', () => {
		const head = tree({
			'app.ts': [...numbered('line', 10), 'reviewed', ...numbered('line', 20).slice(10)]
		});
		const head2 = tree({
			'app.ts': [
				...numbered('line', 10),
				'reviewed',
				'brand new',
				...numbered('line', 20).slice(10)
			]
		});
		const r = update({
			base: BASE,
			head,
			head2,
			requests: [{ file: 'app.ts', section: 'alpha' }]
		});
		expect(side(r.marks, 'app.ts', 'new')).toEqual([]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([12]);
		expect(bucketOf(r.state, r.after, 'app.ts', 'new', 11)?.bucket).toEqual({
			kind: 'section',
			section: 'alpha'
		});
		expect(bucketOf(r.state, r.after, 'app.ts', 'new', 12)?.bucket.kind).toBe('uncategorised');
	});

	it('treats a line that moved within a file as new where it is now', () => {
		const head = tree({ 'app.ts': ['moving', ...numbered('line', 20)] });
		const head2 = tree({ 'app.ts': [...numbered('line', 20), 'moving'] });
		const r = update({ base: BASE, head, head2 });
		expect(side(r.marks, 'app.ts', 'new')).toEqual([]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([21]);
		// Where it was, it is no longer part of the diff.
		expect(r.summary.gone).toBe(1);
		expect(r.summary.reviewedKept).toBe(0);
	});

	it('does not smear a lone brace or a blank line across unrelated code', () => {
		const base = tree({ 'app.ts': numbered('keep', 10) });
		const head = tree({
			'app.ts': [
				...numbered('keep', 5),
				'function alpha() {',
				'  return 1;',
				'}',
				'',
				...numbered('keep', 10).slice(5)
			]
		});
		// alpha is replaced by beta: git keeps its "}" and blank line between its two edits.
		const head2 = tree({
			'app.ts': [
				...numbered('keep', 5),
				'function beta() {',
				'  return 2;',
				'}',
				'',
				...numbered('keep', 10).slice(5)
			]
		});
		const r = update({ base, head, head2, requests: [{ file: 'app.ts', section: 'alpha' }] });
		expect(side(r.marks, 'app.ts', 'new')).toEqual([]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([6, 7, 8, 9]);
		// The marks would go by distance anyway; this is what keeps beta's "}" and blank line
		// with beta, not sorted yet, instead of left in alpha's section.
		expect(bucketOf(r.state, r.after, 'app.ts', 'new', 8)?.bucket.kind).toBe('uncategorised');
		expect(bucketOf(r.state, r.after, 'app.ts', 'new', 9)?.bucket.kind).toBe('uncategorised');
	});

	it('keeps a brace when a line of the same run with letters in it is kept too', () => {
		const base = tree({ 'app.ts': numbered('keep', 10) });
		const head = tree({
			'app.ts': [
				...numbered('keep', 5),
				'function alpha() {',
				'  return 1;',
				'}',
				...numbered('keep', 10).slice(5)
			]
		});
		const head2 = tree({
			'app.ts': [
				...numbered('keep', 5),
				'function alpha() {',
				'  return 2;',
				'}',
				...numbered('keep', 10).slice(5)
			]
		});
		const r = update({ base, head, head2 });
		// Only the edited line is new; the brace is anchored by the function's first line, so it
		// keeps its place, but every line of the function is near the edit and needs another look.
		expect(side(r.marks, 'app.ts', 'new')).toEqual([]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([7]);
	});

	it('keeps repeated lines in their own places when an edit elsewhere shifts them', () => {
		const keep = numbered('keep', 12);
		const base = tree({ 'app.ts': keep });
		const block = ['{', '}', ''];
		const head = tree({
			'app.ts': [...keep.slice(0, 3), ...block, ...keep.slice(3, 6), ...block, ...keep.slice(6)]
		});
		const head2 = tree({ 'app.ts': ['first', ...(head.get('app.ts') ?? [])] });
		const firstBlock = () => ({
			files: new Map([
				[path('app.ts'), { old: RangeSet.empty, new: RangeSet.fromNumbers([4, 5, 6]), file: false }]
			])
		});
		const r = update({ base, head, head2, marks: firstBlock });
		// Only the first block was reviewed; it moved down one line, and the second stays unreviewed.
		expect(side(r.marks, 'app.ts', 'new')).toEqual([5, 6, 7]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([1]);
		expect(r.summary.reviewedKept).toBe(3);
	});

	it('gives punctuation placed only by an edit next to it as new, even if it looks unchanged', () => {
		const keep = numbered('keep', 12);
		const base = tree({ 'app.ts': keep });
		const head = tree({ 'app.ts': ['{', '}', '', ...keep] });
		// A line written just above the braces: git keeps them, but nothing says they are the same.
		const head2 = tree({ 'app.ts': ['first', '{', '}', '', ...keep] });
		const r = update({ base, head, head2 });
		expect(side(r.marks, 'app.ts', 'new')).toEqual([]);
		expect(side(r.fresh, 'app.ts', 'new')).toEqual([1, 2, 3, 4]);
	});

	it('follows a file renamed between the versions', () => {
		const head = tree({
			'app.ts': [...numbered('line', 10), 'added', ...numbered('line', 20).slice(10)]
		});
		const head2 = tree({ 'renamed.ts': head.get('app.ts') ?? [] });
		const r = update({
			base: BASE,
			head,
			head2,
			second: { renames: { 'app.ts': 'renamed.ts' } },
			heads: { renames: { 'app.ts': 'renamed.ts' } },
			requests: [{ file: 'app.ts', section: 'alpha' }]
		});
		expect(side(r.marks, 'renamed.ts', 'new')).toEqual([11]);
		expect(bucketOf(r.state, r.after, 'renamed.ts', 'new', 11)?.bucket.kind).toBe('section');
		// Its line carried over; the rename itself is a change the previous version did not have.
		expect(r.fresh.files.get(path('renamed.ts'))).toEqual(
			fileUnitsOf(RangeSet.empty, RangeSet.empty, true)
		);
		expect(r.summary).toMatchObject({ filesChanged: 1, newToReview: 1, gone: 0 });
	});

	it('gives the moved lines of a file split in two as new in the second file', () => {
		const head = tree({ 'app.ts': [...numbered('line', 20), ...numbered('feature', 4)] });
		const head2 = tree({ 'app.ts': numbered('line', 20), 'feature.ts': numbered('feature', 4) });
		const r = update({ base: BASE, head, head2 });
		expect(side(r.fresh, 'feature.ts', 'new')).toEqual([1, 2, 3, 4]);
		expect(r.marks.files.has(path('feature.ts'))).toBe(false);
		// app.ts has no change any more: it left the diff, with its four lines.
		expect(r.summary).toMatchObject({ filesChanged: 2, filesGone: 1, gone: 4, newToReview: 4 });
	});

	it('gives lines merged in from another file as new, and counts the other file as gone', () => {
		const base = tree({ 'a.ts': numbered('a', 5) });
		const head = tree({ 'a.ts': numbered('a', 5), 'b.ts': numbered('b', 3) });
		const head2 = tree({ 'a.ts': [...numbered('a', 5), ...numbered('b', 3)] });
		const r = update({ base, head, head2 });
		expect(side(r.fresh, 'a.ts', 'new')).toEqual([6, 7, 8]);
		expect(r.summary).toMatchObject({ filesChanged: 2, filesGone: 1, gone: 3, newToReview: 3 });
		expect(r.summary.reviewedKept).toBe(0);
	});

	it('counts a file whose change disappeared as gone, keeping the others', () => {
		const base = tree({ 'a.ts': numbered('a', 5), 'b.ts': numbered('b', 5) });
		const head = tree({
			'a.ts': [...numbered('a', 5), 'new a'],
			'b.ts': [...numbered('b', 5), 'new b']
		});
		const head2 = tree({ 'a.ts': [...numbered('a', 5), 'new a'], 'b.ts': numbered('b', 5) });
		const r = update({ base, head, head2 });
		expect(side(r.marks, 'a.ts', 'new')).toEqual([6]);
		expect(r.summary).toEqual({
			filesChanged: 1,
			filesGone: 1,
			newToReview: 0,
			newIgnored: 0,
			gone: 1,
			reviewedBefore: 2,
			reviewedKept: 1
		});
	});

	it('gives the deletions of a deleted file that came back edited as new', () => {
		const base = tree({ 'gone.ts': numbered('old', 4), 'other.ts': ['x'] });
		const head = tree({ 'other.ts': ['x'] });
		const head2 = tree({
			'gone.ts': [...numbered('old', 4).slice(0, 2), 'changed'],
			'other.ts': ['x']
		});
		const r = update({ base, head, head2 });
		// The same base lines are deleted, but in an edit now, not with the whole file.
		expect(side(r.fresh, 'gone.ts', 'old')).toEqual([3, 4]);
		expect(side(r.fresh, 'gone.ts', 'new')).toEqual([3]);
		expect(r.summary.reviewedKept).toBe(0);
	});

	it('keeps deletions and additions through a rebase that moved the base under them', () => {
		const base = tree({ 'app.ts': numbered('line', 30) });
		// The author removes line 20 and adds a line after line 25.
		const edit = (lines: readonly string[], offset: number): readonly string[] => [
			...lines.slice(0, 19 + offset),
			...lines.slice(20 + offset, 25 + offset),
			'mine',
			...lines.slice(25 + offset)
		];
		const head = tree({ 'app.ts': edit(base.get('app.ts') ?? [], 0) });
		// Upstream added two lines at the top; the branch is rebased onto that.
		const base2 = tree({ 'app.ts': ['upstream 1', 'upstream 2', ...(base.get('app.ts') ?? [])] });
		const head2 = tree({ 'app.ts': edit(base2.get('app.ts') ?? [], 2) });
		const r = update({ base, head, base2, head2 });
		expect(side(r.marks, 'app.ts', 'old')).toEqual([22]);
		expect(side(r.marks, 'app.ts', 'new')).toEqual([27]);
		expect(unitSetSize(r.fresh)).toBe(0);
		expect(r.summary.filesChanged).toBe(0);
	});

	it('treats a deleted line as new when the rebase changed it in the base', () => {
		const base = tree({ 'app.ts': numbered('line', 10) });
		const head = tree({ 'app.ts': numbered('line', 10).filter((l) => l !== 'line 5') });
		const base2 = tree({
			'app.ts': numbered('line', 10).map((l) => (l === 'line 5' ? 'line five' : l))
		});
		const head2 = tree({ 'app.ts': numbered('line', 10).filter((l) => l !== 'line 5') });
		const r = update({ base, head, base2, head2 });
		expect(side(r.fresh, 'app.ts', 'old')).toEqual([5]);
		expect(r.summary.reviewedKept).toBe(0);
		expect(r.summary.gone).toBe(1);
	});

	it('gives a copy new lines, however alike', () => {
		const head = tree({ 'app.ts': [...numbered('line', 20), 'added'] });
		const head2 = tree({
			'app.ts': [...numbered('line', 20), 'added'],
			'copy.ts': [...numbered('line', 20), 'added']
		});
		const r = update({ base: BASE, head, head2, heads: { copies: { 'app.ts': 'copy.ts' } } });
		expect(side(r.marks, 'app.ts', 'new')).toEqual([21]);
		expect(side(r.fresh, 'copy.ts', 'new')).toHaveLength(21);
		expect(r.summary.reviewedKept).toBe(1);
	});

	it('keeps sections, roles and the agent’s ignored lines with their reasons', () => {
		const head = tree({
			'app.ts': [...numbered('line', 10), 'a', 'b', ...numbered('line', 20).slice(10)]
		});
		const head2 = tree({ 'app.ts': ['top', ...(head.get('app.ts') ?? [])] });
		const r = update({
			base: BASE,
			head,
			head2,
			requests: [
				{ file: 'app.ts', lines: '+11', section: 'alpha', role: 'test' },
				{ file: 'app.ts', lines: '+12', section: 'ignored', reason: 'Generated' }
			]
		});
		expect(bucketOf(r.state, r.after, 'app.ts', 'new', 12)).toEqual({
			bucket: { kind: 'section', section: 'alpha' },
			role: 'test'
		});
		expect(bucketOf(r.state, r.after, 'app.ts', 'new', 13)?.bucket).toEqual({
			kind: 'ignored',
			by: { kind: 'agent', reason: 'Generated' }
		});
	});

	it('ignores a new lockfile by its rule, as in a first version, and does not count it to review', () => {
		const head = tree({ 'app.ts': [...numbered('line', 20), 'added'] });
		const head2 = tree({
			'app.ts': [...numbered('line', 20), 'added'],
			'pnpm-lock.yaml': ['lock: 1']
		});
		const r = update({ base: BASE, head, head2 });
		expect(bucketOf(r.state, r.after, 'pnpm-lock.yaml', 'new', 1)?.bucket).toEqual({
			kind: 'ignored',
			by: { kind: 'rule', rule: 'lockfile' }
		});
		expect(r.summary).toMatchObject({ filesChanged: 1, newToReview: 0, newIgnored: 1 });
	});

	it('keeps a file-level unit only when it is exactly the same change', () => {
		const empty = tree({ 'empty.txt': [] });
		const sameEmpty = update({ base: tree({}), head: empty, head2: empty });
		expect(fileUnitInSet(sameEmpty.marks, path('empty.txt'))).toBe(true);
		expect(unitSetSize(sameEmpty.fresh)).toBe(0);
		// The empty file got a line: its line is new.
		const filled = update({ base: tree({}), head: empty, head2: tree({ 'empty.txt': ['now'] }) });
		expect(side(filled.fresh, 'empty.txt', 'new')).toEqual([1]);
		expect(filled.summary).toMatchObject({ gone: 1, reviewedKept: 0, filesChanged: 1 });

		// A mode change kept as it was; a binary file whose change differs is new.
		const before = syntheticDiff([
			{ path: 'bin.dat', change: 'binary' },
			{ path: 'run.sh', change: 'mode' }
		]);
		const after = syntheticDiff([
			{ path: 'bin.dat', change: 'mode' },
			{ path: 'run.sh', change: 'mode' }
		]);
		const carried = carryOver({
			previous: { diff: before, state: initialState(before), marks: allMarked(before) },
			diff: after,
			heads: NO_TREE_CHANGES,
			bases: NO_TREE_CHANGES
		});
		expect(fileUnitInSet(carried.marks, path('run.sh'))).toBe(true);
		expect(fileUnitInSet(carried.fresh, path('bin.dat'))).toBe(true);
	});

	it('carries nothing over when the trees cannot be compared', () => {
		const head = tree({ 'app.ts': [...numbered('line', 20), 'added'] });
		const before = diffOf(BASE, head);
		const carried = carryOver({
			previous: { diff: before, state: sorted(before), marks: allMarked(before) },
			diff: before,
			heads: { kind: 'unrelated' },
			bases: { kind: 'unrelated' }
		});
		expect(unitSetSize(carried.marks)).toBe(0);
		expect(unitSetSize(carried.fresh)).toBe(before.unitCount);
	});

	it('marks nothing when nothing was marked', () => {
		const head = tree({ 'app.ts': [...numbered('line', 20), 'added'] });
		const r = update({ base: BASE, head, head2: head, marks: () => NO_MARKS });
		expect(unitSetSize(r.marks)).toBe(0);
		expect(r.summary.reviewedBefore).toBe(0);
	});

	it('gives the file list what is new to review in each file, but not what is ignored', () => {
		const head = tree({ 'app.ts': [...numbered('line', 20), 'added'] });
		const head2 = tree({
			'app.ts': [...numbered('line', 20), 'added', 'more', 'still more'],
			'pnpm-lock.yaml': ['lock: 1']
		});
		const r = update({ base: BASE, head, head2 });
		const listed = listFiles(r.after, r.state, [], r.fresh).flatMap((g) =>
			g.files.map((f) => [g.kind, f.path, f.newChanges])
		);
		expect(listed).toEqual([
			['ignored', 'pnpm-lock.yaml', 0],
			['uncategorised', 'app.ts', 2]
		]);
	});

	it('works out a blank-line-only change of the same run without a meaningful anchor as new', () => {
		const base = tree({ 'app.ts': numbered('keep', 10) });
		const head = tree({ 'app.ts': [...numbered('keep', 5), '', ...numbered('keep', 10).slice(5)] });
		const head2 = tree({
			'app.ts': ['top', ...numbered('keep', 5), '', ...numbered('keep', 10).slice(5)]
		});
		const r = update({ base, head, head2 });
		// Not between two edits (only one edit, above it), so the blank line keeps its mark.
		expect(side(r.marks, 'app.ts', 'new')).toEqual([7]);
	});
});
