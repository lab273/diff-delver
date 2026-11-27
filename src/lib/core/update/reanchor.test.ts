import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffOf, editScript, tree, treeDiff } from '../../../../tests/support/tree-diffs.ts';
import { lineNumberOf } from '../line-number.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import type { CommentAnchor } from '../review/draft-comment.ts';
import type { Side } from '../side.tiny.ts';
import type { TreeChanges } from './line-map.ts';
import { NO_TREE_CHANGES } from './line-map.ts';
import { followThread, reanchor } from './reanchor.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

function on(file: string, first: number, last: number, side: Side = 'new'): CommentAnchor {
	return { path: path(file), side, first: lineNumberOf(first), last: lineNumberOf(last) };
}

function changes(
	before: Record<string, readonly string[]>,
	after: Record<string, readonly string[]>,
	options: Parameters<typeof treeDiff>[2] = {}
): TreeChanges {
	return { kind: 'diff', files: treeDiff(tree(before), tree(after), options) };
}

const numbered = (count: number): readonly string[] =>
	Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`);

describe("where a thread's lines are in a later tree", () => {
	it('keeps the lines of a file git does not list', () => {
		expect(reanchor(on('a.ts', 3, 5), NO_TREE_CHANGES)).toEqual({
			kind: 'lines',
			anchor: on('a.ts', 3, 5),
			edited: false
		});
	});

	it('follows lines moved by edits elsewhere, unchanged', () => {
		const before = numbered(20);
		const after = ['new top', 'another', ...before.slice(0, 15), 'changed', ...before.slice(16)];
		const moved = reanchor(on('a.ts', 4, 6), changes({ 'a.ts': before }, { 'a.ts': after }));
		expect(moved).toEqual({ kind: 'lines', anchor: on('a.ts', 6, 8), edited: false });
	});

	it('takes a rewritten line to what replaced it, as changed', () => {
		const before = numbered(10);
		const after = [...before.slice(0, 4), 'line 5, rewritten', ...before.slice(5)];
		expect(reanchor(on('a.ts', 5, 5), changes({ 'a.ts': before }, { 'a.ts': after }))).toEqual({
			kind: 'lines',
			anchor: on('a.ts', 5, 5),
			edited: true
		});
	});

	it('takes in lines put between its own, and not those put just outside it', () => {
		const before = numbered(10);
		const inside = [...before.slice(0, 4), 'inserted', ...before.slice(4)];
		expect(reanchor(on('a.ts', 4, 5), changes({ 'a.ts': before }, { 'a.ts': inside }))).toEqual({
			kind: 'lines',
			anchor: on('a.ts', 4, 6),
			edited: true
		});
		expect(reanchor(on('a.ts', 5, 6), changes({ 'a.ts': before }, { 'a.ts': inside }))).toEqual({
			kind: 'lines',
			anchor: on('a.ts', 6, 7),
			edited: false
		});
		expect(reanchor(on('a.ts', 2, 4), changes({ 'a.ts': before }, { 'a.ts': inside }))).toEqual({
			kind: 'lines',
			anchor: on('a.ts', 2, 4),
			edited: false
		});
	});

	it('says the lines are gone when they were removed and nothing replaced them', () => {
		const before = numbered(10);
		const after = [...before.slice(0, 3), ...before.slice(6)];
		expect(reanchor(on('a.ts', 4, 6), changes({ 'a.ts': before }, { 'a.ts': after }))).toEqual({
			kind: 'gone'
		});
		// One of its lines is left, so it stays, on that line.
		expect(reanchor(on('a.ts', 4, 7), changes({ 'a.ts': before }, { 'a.ts': after }))).toEqual({
			kind: 'lines',
			anchor: on('a.ts', 4, 4),
			edited: true
		});
	});

	it('follows a rename, and has nothing in a deleted file or across unrelated trees', () => {
		const lines = numbered(6);
		expect(
			reanchor(
				on('a.ts', 2, 3),
				changes({ 'a.ts': lines }, { 'b.ts': lines }, { renames: { 'a.ts': 'b.ts' } })
			)
		).toEqual({ kind: 'lines', anchor: on('b.ts', 2, 3), edited: false });
		expect(reanchor(on('a.ts', 2, 3), changes({ 'a.ts': lines }, {}))).toEqual({ kind: 'gone' });
		expect(reanchor(on('a.ts', 2, 3), { kind: 'unrelated' })).toEqual({ kind: 'gone' });
	});

	it('keeps an old-side thread on a file that was copied, since the copy is another file', () => {
		const lines = numbered(6);
		expect(
			reanchor(
				on('a.ts', 2, 3, 'old'),
				changes({ 'a.ts': lines }, { 'a.ts': lines, 'c.ts': lines }, { copies: { 'a.ts': 'c.ts' } })
			)
		).toEqual({ kind: 'lines', anchor: on('a.ts', 2, 3, 'old'), edited: false });
	});
});

describe('an old-side thread', () => {
	const base = { 'a.ts': numbered(6) };
	const removing = { 'a.ts': [...numbered(6).slice(0, 2), ...numbered(6).slice(3)] };

	it('is unchanged while the change still removes its lines', () => {
		expect(
			followThread(on('a.ts', 3, 3, 'old'), {
				heads: changes(removing, removing),
				bases: changes(base, base),
				before: diffOf(tree(base), tree(removing)),
				after: diffOf(tree(base), tree(removing))
			})
		).toEqual({ kind: 'lines', anchor: on('a.ts', 3, 3, 'old'), edited: false });
	});

	it('is unchanged over unchanged lines and removed ones while the change still removes those', () => {
		expect(
			followThread(on('a.ts', 2, 4, 'old'), {
				heads: changes(removing, removing),
				bases: changes(base, base),
				before: diffOf(tree(base), tree(removing)),
				after: diffOf(tree(base), tree(removing))
			})
		).toEqual({ kind: 'lines', anchor: on('a.ts', 2, 4, 'old'), edited: false });
	});

	it('has its code changed once the change no longer removes them', () => {
		// The agent put line 3 back: the base is the same, the line is no longer removed.
		expect(
			followThread(on('a.ts', 3, 3, 'old'), {
				heads: changes(removing, base),
				bases: changes(base, base),
				before: diffOf(tree(base), tree(removing)),
				after: diffOf(tree(base), tree(base))
			})
		).toEqual({ kind: 'lines', anchor: on('a.ts', 3, 3, 'old'), edited: true });
	});
});

const TEXTS = ['a', 'b', 'c', '}', '', 'x'];

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

/** Where git's line-up of the two files takes each earlier line: its later number, or undefined when it was removed. */
function keptLines(before: readonly string[], after: readonly string[]): (number | undefined)[] {
	const kept: (number | undefined)[] = [];
	let later = 0;
	for (const op of editScript(before, after)) {
		switch (op) {
			case '=':
				later += 1;
				kept.push(later);
				break;
			case '-':
				kept.push(undefined);
				break;
			case '+':
				later += 1;
				break;
		}
	}
	return kept;
}

describe('re-anchoring over random edits', () => {
	const history = fc
		.array(fc.constantFrom(...TEXTS), { minLength: 1, maxLength: 16 })
		.chain((before) =>
			fc.record({
				before: fc.constant(before),
				edits: fc.array(edit, { maxLength: 4 }),
				first: fc.integer({ min: 1, max: before.length }),
				length: fc.nat(4)
			})
		)
		.map(({ before, edits, first, length }) => ({
			before,
			after: applyEdits(before, edits),
			first,
			last: Math.min(before.length, first + length)
		}));

	it('stays in the file, and is unchanged exactly when its lines were kept together', () => {
		fc.assert(
			fc.property(history, ({ before, after, first, last }) => {
				const found = reanchor(
					on('a.ts', first, last),
					changes({ 'a.ts': before }, { 'a.ts': after })
				);
				const kept = keptLines(before, after).slice(first - 1, last);
				const survivors = kept.filter((n) => n !== undefined);
				const together =
					survivors.length === kept.length &&
					survivors.every((n, i) => i === 0 || n === (survivors[i - 1] ?? 0) + 1);
				if (found.kind === 'gone') {
					// Gone only when nothing of it was kept.
					expect(survivors).toEqual([]);
					return;
				}
				const { anchor, edited } = found;
				expect(anchor.first).toBeGreaterThanOrEqual(1);
				expect(anchor.last).toBeLessThanOrEqual(after.length);
				expect(anchor.first).toBeLessThanOrEqual(anchor.last);
				// Every line kept is among its lines.
				for (const n of survivors) {
					expect(n).toBeGreaterThanOrEqual(anchor.first);
					expect(n).toBeLessThanOrEqual(anchor.last);
				}
				expect(edited).toBe(!together);
				if (!edited) {
					expect(after.slice(anchor.first - 1, anchor.last)).toEqual(before.slice(first - 1, last));
				}
			}),
			{ numRuns: 300 }
		);
	});
});
