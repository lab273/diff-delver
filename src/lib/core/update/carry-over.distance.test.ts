/**
 * The reviewed marks an update keeps (DESIGN 6.2 step 3): a matched line keeps
 * its mark only when nothing within `MARK_DISTANCE` shown lines of it is new or
 * was removed (see the top of `carry-over.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
	diffOf,
	tree,
	treeDiff,
	type Tree,
	type TreeDiffOptions
} from '../../../../tests/support/tree-diffs.ts';
import { assign, type AssignRequest } from '../diff/assign.ts';
import { autoIgnore } from '../diff/auto-ignore.ts';
import type { Diff } from '../diff/diff.ts';
import { fileAssignment, initialState, sideMap } from '../diff/state.ts';
import { linesInSet, type UnitSet } from '../diff/unit-set.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import type { ReviewedMarks } from '../review/reviewed-marks.ts';
import type { Side } from '../side.tiny.ts';
import { carryOver, MARK_DISTANCE } from './carry-over.ts';
import { describeKeptMarks } from './update-summary.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const numbered = (prefix: string, count: number): readonly string[] =>
	Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}`);

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

interface Scenario {
	readonly base: Tree;
	readonly head: Tree;
	readonly base2?: Tree;
	readonly head2: Tree;
	readonly first?: TreeDiffOptions;
	readonly second?: TreeDiffOptions;
	readonly heads?: TreeDiffOptions;
	readonly requests?: readonly AssignRequest[];
}

function update(s: Scenario) {
	const base2 = s.base2 ?? s.base;
	const before = diffOf(s.base, s.head, s.first);
	const after = diffOf(base2, s.head2, s.second);
	const state = assign(
		before,
		autoIgnore(before, initialState(before)).state,
		s.requests ?? []
	).state;
	const carried = carryOver({
		previous: { diff: before, state, marks: allMarked(before) },
		diff: after,
		heads: { kind: 'diff', files: treeDiff(s.head, s.head2, s.heads) },
		bases: { kind: 'diff', files: treeDiff(s.base, base2) }
	});
	return { ...carried, before, after };
}

function lines(set: UnitSet, file: string, side: Side): readonly number[] {
	return [...linesInSet(set, path(file), side).values()];
}

/** The text of the marked lines of one side of a file in the new version. */
function markedText(r: ReturnType<typeof update>, file: string, side: Side): readonly string[] {
	const found = r.after.byPath.get(path(file));
	if (found === undefined) throw new Error(file);
	const marked = linesInSet(r.marks, path(file), side);
	return [...found.hunks.values()].flatMap((hunk) =>
		hunk.lines
			.filter((l) =>
				l.kind === 'added'
					? side === 'new' && marked.has(l.new)
					: l.kind === 'deleted' && side === 'old' && marked.has(l.old)
			)
			.map((l) => l.text)
	);
}

describe('the marks an update keeps', () => {
	it('is three shown lines', () => {
		expect(MARK_DISTANCE).toBe(3);
	});

	it('reads again an error check that now sits under a replaced call', () => {
		// The reviewer's example: a function replaced by another that shares its error handling.
		const base = tree({ 'store.go': ['package store', '', 'import "errors"'] });
		const a = [
			'func a() (int, error) {',
			'\tv, err := load()',
			'\tif err != nil {',
			'\t\treturn 0, err',
			'\t}',
			'\treturn v, nil',
			'}'
		];
		const b = [
			'func b() (int, error) {',
			'\tw, err := deleteEverything()',
			'\tif err != nil {',
			'\t\treturn 0, err',
			'\t}',
			'\treturn w, nil',
			'}'
		];
		const head = tree({ 'store.go': [...(base.get('store.go') ?? []), '', ...a] });
		const head2 = tree({ 'store.go': [...(base.get('store.go') ?? []), '', ...b] });
		const r = update({ base, head, head2 });
		// git matches the error check, its return and the braces across the two functions...
		expect(lines(r.fresh, 'store.go', 'new')).toEqual([5, 6, 10]);
		// ...but every line of b() is within three lines of a new one, so none stays reviewed.
		expect(markedText(r, 'store.go', 'new')).toEqual([]);
		expect(describeKeptMarks(r.summary)).toMatch(/need another look/);
	});

	it('does not keep the closing brace of a function that replaced another, beside one unchanged', () => {
		const base = tree({ 'app.ts': numbered('keep', 4) });
		const c = ['function c() {', '  one();', '  two();', '  three();', '  four();', '}'];
		const head = tree({
			'app.ts': [...numbered('keep', 4), 'function a() {', '  alpha();', '}', '', ...c]
		});
		const head2 = tree({
			'app.ts': [...numbered('keep', 4), 'function b() {', '  beta();', '}', '', ...c]
		});
		const r = update({ base, head, head2 });
		// b() and the three lines below its new lines are read again; the rest of c() keeps its marks.
		const kept = markedText(r, 'app.ts', 'new');
		expect(kept).toEqual(['  one();', '  two();', '  three();', '  four();', '}']);
		// The brace that closes b() (line 7) is not reviewed.
		expect(lines(r.marks, 'app.ts', 'new')).not.toContain(7);
	});

	it('takes the marks off only the lines near a one-line fix in a long reviewed file', () => {
		const base = tree({ 'app.ts': [] });
		const head = tree({ 'app.ts': numbered('line', 40) });
		const fixed = [...numbered('line', 40)];
		fixed[19] = 'line 20, fixed';
		const r = update({ base, head, head2: tree({ 'app.ts': fixed }) });
		expect(lines(r.fresh, 'app.ts', 'new')).toEqual([20]);
		const kept = lines(r.marks, 'app.ts', 'new');
		expect(kept).toHaveLength(40 - 7);
		expect(kept.filter((n) => n >= 17 && n <= 23)).toEqual([]);
	});

	it('takes marks off around each of two edits far apart, and keeps those between', () => {
		const base = tree({ 'app.ts': [] });
		const head = tree({ 'app.ts': numbered('line', 30) });
		const edited = [...numbered('line', 30)];
		edited[4] = 'line 5, edited';
		edited[24] = 'line 25, edited';
		const r = update({ base, head, head2: tree({ 'app.ts': edited }) });
		const kept = lines(r.marks, 'app.ts', 'new');
		expect(kept.filter((n) => (n >= 2 && n <= 8) || (n >= 22 && n <= 28))).toEqual([]);
		expect(kept).toEqual([1, ...Array.from({ length: 13 }, (_, i) => i + 9), 29, 30]);
	});

	it('takes marks off the lines just inside a hunk when an edit falls at its edge', () => {
		const keep = numbered('keep', 30);
		const base = tree({ 'app.ts': keep });
		const block = numbered('block', 10);
		const head = tree({ 'app.ts': [...keep.slice(0, 10), ...block, ...keep.slice(10)] });
		// A line added right after the block, next to the context below it.
		const head2 = tree({
			'app.ts': [...keep.slice(0, 10), ...block, 'just after', ...keep.slice(10)]
		});
		const r = update({ base, head, head2 });
		expect(markedText(r, 'app.ts', 'new')).toEqual(numbered('block', 7));
	});

	it('measures a file renamed between the versions as it is now, near its edit only', () => {
		const base = tree({ 'old.ts': numbered('line', 30) });
		const head = tree({ 'old.ts': [...numbered('line', 30), ...numbered('added', 12)] });
		const later = [...numbered('line', 30), ...numbered('added', 12)];
		later[30 + 9] = 'added 10, edited';
		const r = update({
			base,
			head,
			head2: tree({ 'new.ts': later }),
			second: { renames: { 'old.ts': 'new.ts' } },
			heads: { renames: { 'old.ts': 'new.ts' } }
		});
		expect(markedText(r, 'new.ts', 'new')).toEqual(numbered('added', 6));
	});

	it('takes marks off the lines beside one that was removed, though nothing was added', () => {
		const base = tree({ 'app.ts': numbered('keep', 10) });
		const added = numbered('added', 12);
		const head = tree({ 'app.ts': [...numbered('keep', 10), ...added] });
		const head2 = tree({
			'app.ts': [...numbered('keep', 10), ...added.slice(0, 6), ...added.slice(7)]
		});
		const r = update({ base, head, head2 });
		expect(lines(r.fresh, 'app.ts', 'new')).toEqual([]);
		expect(r.summary.gone).toBe(1);
		expect(markedText(r, 'app.ts', 'new')).toEqual([
			'added 1',
			'added 2',
			'added 3',
			'added 11',
			'added 12'
		]);
	});

	it('takes marks off deleted lines beside one that is no longer deleted', () => {
		const base = tree({ 'app.ts': [...numbered('keep', 5), ...numbered('old', 10)] });
		const head = tree({ 'app.ts': numbered('keep', 5) });
		// "old 5" is back in the head: it is no longer a deleted line, nothing is added.
		const head2 = tree({ 'app.ts': [...numbered('keep', 5), 'old 5'] });
		const r = update({ base, head, head2 });
		expect(r.summary.gone).toBe(1);
		expect(markedText(r, 'app.ts', 'old')).toEqual(['old 1', 'old 9', 'old 10']);
	});

	it('keeps sections and roles by the same-line rule alone, wherever the marks went', () => {
		const base = tree({ 'app.ts': [] });
		const head = tree({ 'app.ts': numbered('line', 10) });
		const edited = [...numbered('line', 10)];
		edited[4] = 'line 5, edited';
		const r = update({
			base,
			head,
			head2: tree({ 'app.ts': edited }),
			requests: [{ file: 'app.ts', section: 'alpha', role: 'test' }]
		});
		const file = r.after.byPath.get(path('app.ts'));
		if (file === undefined) throw new Error('app.ts');
		const at = (n: number) => sideMap(fileAssignment(r.state, file), 'new').get(n);
		expect(lines(r.marks, 'app.ts', 'new')).not.toContain(4);
		expect(at(4)).toEqual({ bucket: { kind: 'section', section: 'alpha' }, role: 'test' });
		expect(at(5)?.bucket.kind).toBe('uncategorised');
	});
});
