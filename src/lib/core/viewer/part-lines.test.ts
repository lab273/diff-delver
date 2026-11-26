import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffOf, tree } from '../../../../tests/support/tree-diffs.ts';
import { assign } from '../diff/assign.ts';
import type { DiffFile } from '../diff/diff.ts';
import { groupKeyId, type GroupKey } from '../diff/slices.ts';
import { initialState, type AssignmentState } from '../diff/state.ts';
import { EMPTY_UNIT_SET, fileUnitsOf, type UnitSet } from '../diff/unit-set.ts';
import { lineCountOf } from '../line-count.tiny.ts';
import { RangeSet } from '../range-set.ts';
import { parseRepoPath } from '../repo-path.tiny.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { partBlocks, type PartBlock } from './part-lines.ts';

const UNSORTED: GroupKey = { kind: 'uncategorised' };

function alpha(): GroupKey {
	const id = parseSectionId('alpha');
	if (!id.ok) throw new Error('alpha');
	return { kind: 'section', section: id.value };
}

function numbered(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}`);
}

function only(from: readonly string[], to: readonly string[]): DiffFile {
	const diff = diffOf(tree({ 'app.ts': from }), tree({ 'app.ts': to }));
	const file = diff.files[0];
	if (file === undefined) throw new Error('no file');
	return file;
}

/** Each block in brief: hidden spans, or the hunk's lines as their kinds and where they belong. */
function brief(blocks: readonly PartBlock[]): readonly string[] {
	return blocks.map((b) => {
		switch (b.kind) {
			case 'hidden':
				return `hidden -${b.old.first}..${b.old.last} +${b.new.first}..${b.new.last}`;
			case 'hunk':
			case 'elsewhere':
				return `${b.kind} ${b.lines
					.map((l) => {
						if (l.kind === 'context') return ' ';
						const sign = l.kind === 'added' ? '+' : '-';
						if (l.home.kind === 'elsewhere') return `${sign}(${groupKeyId(l.home.group)})`;
						return l.home.fresh ? `${sign}new` : sign;
					})
					.join('')}`;
		}
	});
}

describe('a part’s lines', () => {
	it('hides the unchanged lines above, between and below its hunks, numbered on both sides', () => {
		const from = numbered('line', 30);
		const to = [...from];
		to[4] = 'changed 5';
		to.splice(20, 1);
		const file = only(from, to);
		const blocks = partBlocks(
			file,
			{ group: UNSORTED, step: undefined },
			initialState({
				files: [file],
				byPath: new Map([[file.file.path, file]]),
				unitCount: file.unitCount
			}),
			'sections',
			EMPTY_UNIT_SET,
			lineCountOf(to.length)
		);
		expect(brief(blocks)).toEqual([
			'hidden -1..1 +1..1',
			'hunk    -+   ',
			'hidden -9..17 +9..17',
			'hunk    -   ',
			'hidden -25..30 +24..29'
		]);
	});

	it('shows a hunk of another group as one block that says where, and marks what is new', () => {
		const from = numbered('line', 30);
		const to = [...from];
		to[4] = 'changed 5';
		to[24] = 'changed 25';
		const file = only(from, to);
		const diff = {
			files: [file],
			byPath: new Map([[file.file.path, file]]),
			unitCount: file.unitCount
		};
		const state: AssignmentState = assign(diff, initialState(diff), [
			{ file: 'app.ts', lines: '-5,+5', section: 'alpha' }
		]).state;
		const path = parseRepoPath('app.ts');
		if (!path.ok) throw new Error('path');
		const fresh: UnitSet = {
			files: new Map([
				[
					path.value,
					fileUnitsOf(RangeSet.empty, RangeSet.fromNumbers([5])) ?? {
						old: RangeSet.empty,
						new: RangeSet.empty,
						file: false
					}
				]
			])
		};
		const ours = partBlocks(
			file,
			{ group: alpha(), step: undefined },
			state,
			'sections',
			fresh,
			lineCountOf(30)
		);
		expect(brief(ours)).toEqual([
			'hidden -1..1 +1..1',
			'hunk    -+new   ',
			'hidden -9..21 +9..21',
			'elsewhere    -(uncategorised)+(uncategorised)   ',
			'hidden -29..30 +29..30'
		]);
		const theirs = partBlocks(
			file,
			{ group: UNSORTED, step: undefined },
			state,
			'sections',
			fresh,
			lineCountOf(30)
		);
		expect(brief(theirs)[1]).toBe('elsewhere    -(section:alpha)+(section:alpha)   ');
		const elsewhere = ours[3];
		expect(
			elsewhere?.kind === 'elsewhere' ? elsewhere.places.map((p) => groupKeyId(p.group)) : []
		).toEqual(['uncategorised']);
	});

	it('hides nothing of a file added or deleted whole, and all of a file only renamed', () => {
		const added = diffOf(tree({}), tree({ 'new.ts': ['a', 'b'] })).files[0];
		const renamed = diffOf(
			tree({ 'old.ts': ['a', 'b', 'c'] }),
			tree({ 'new.ts': ['a', 'b', 'c'] }),
			{
				renames: { 'old.ts': 'new.ts' }
			}
		).files[0];
		if (added === undefined || renamed === undefined) throw new Error('files');
		const state = (file: DiffFile) =>
			initialState({
				files: [file],
				byPath: new Map([[file.file.path, file]]),
				unitCount: file.unitCount
			});
		expect(
			brief(
				partBlocks(
					added,
					{ group: UNSORTED, step: undefined },
					state(added),
					'sections',
					EMPTY_UNIT_SET,
					lineCountOf(2)
				)
			)
		).toEqual(['hunk ++']);
		expect(
			brief(
				partBlocks(
					renamed,
					{ group: UNSORTED, step: undefined },
					state(renamed),
					'sections',
					EMPTY_UNIT_SET,
					lineCountOf(3)
				)
			)
		).toEqual(['hidden -1..3 +1..3']);
	});

	it('accounts for every line of both sides once, in order, with hidden lines the same on each', () => {
		const line = fc.constantFrom('a', 'b', 'c', '}', '');
		fc.assert(
			fc.property(
				fc.array(line, { maxLength: 40 }),
				fc.array(line, { maxLength: 40 }),
				(from, to) => {
					fc.pre(from.join('\n') !== to.join('\n') && from.length > 0 && to.length > 0);
					const file = only(from, to);
					const diff = {
						files: [file],
						byPath: new Map([[file.file.path, file]]),
						unitCount: file.unitCount
					};
					const blocks = partBlocks(
						file,
						{ group: UNSORTED, step: undefined },
						initialState(diff),
						'sections',
						EMPTY_UNIT_SET,
						lineCountOf(to.length)
					);
					const olds: number[] = [];
					const news: number[] = [];
					for (const b of blocks) {
						if (b.kind === 'hidden') {
							for (let n: number = b.new.first; n <= b.new.last; n += 1) news.push(n);
							for (let n: number = b.old.first; n <= b.old.last; n += 1) olds.push(n);
							expect(b.new.last - b.new.first).toBe(b.old.last - b.old.first);
							for (let i = 0; i <= b.new.last - b.new.first; i += 1) {
								expect(to[b.new.first - 1 + i]).toBe(from[b.old.first - 1 + i]);
							}
							continue;
						}
						for (const l of b.lines) {
							if (l.kind !== 'added') olds.push(l.kind === 'context' ? l.line.old : l.line.old);
							if (l.kind !== 'deleted') news.push(l.line.new);
						}
					}
					expect(olds).toEqual(from.map((_, i) => i + 1));
					expect(news).toEqual(to.map((_, i) => i + 1));
				}
			),
			{ numRuns: 200 }
		);
	});
});
