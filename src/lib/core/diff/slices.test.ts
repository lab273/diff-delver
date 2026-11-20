import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbitraryDiff, syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { parseSectionId, type SectionId } from '../section-id.tiny.ts';
import { assign, type AssignRequest } from './assign.ts';
import type { Diff } from './diff.ts';
import { groupKeyId, sectionView, testsSeparateView, type Slice, type View } from './slices.ts';
import { initialState, type AssignmentState } from './state.ts';

function section(id: string): SectionId {
	const parsed = parseSectionId(id);
	if (!parsed.ok) throw new Error(`bad section ${id}`);
	return parsed.value;
}

// src/app.ts: h1 is ctx 1, -2, -3, +2, +3, +4, ctx; h2 is ctx, +11, ctx.
// src/app.test.ts: +1..+4 (role test). assets/logo.png: binary.
const diff = syntheticDiff([
	{ path: 'assets/logo.png', change: 'binary' },
	{ path: 'src/app.test.ts', change: 'added', lines: 4 },
	{
		path: 'src/app.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '-', '-', '+', '+', '+', ' '] },
			{ gap: 4, lines: [' ', '+', ' '] }
		]
	}
]);

const after = (requests: readonly AssignRequest[]): AssignmentState =>
	assign(diff, initialState(diff), requests).state;

/** A slice as `path: h1[c o o e e e c]`, with c for context, o for own, e for elsewhere. */
function show(slice: Slice): string {
	if (slice.kind === 'file') return `${slice.file.path}: (file)`;
	const hunks = slice.hunks.map(
		(h) =>
			`${h.hunk.id}[${h.lines.map((l) => (l.kind === 'context' ? 'c' : l.kind === 'own' ? 'o' : 'e')).join('')}]`
	);
	return `${slice.file.path}: ${hunks.join(' ')}`;
}

const outline = (view: View): readonly (readonly [string, readonly string[], number])[] =>
	view.groups.map((g) => [groupKeyId(g.key), g.slices.map(show), g.units] as const);

describe('sectionView', () => {
	it('draws each section with the other sections lines muted', () => {
		const state = after([
			{ file: 'src/app.ts', lines: '-2..-3,+2', section: 'alpha' },
			{ file: 'src/app.ts', lines: '+3..+4,+11', section: 'beta' },
			{ file: 'src/app.test.ts', section: 'alpha' }
		]);
		expect(
			outline(sectionView(diff, state, [section('beta'), section('alpha'), section('empty')]))
		).toEqual([
			['section:beta', ['src/app.ts: h1[ceeeooc] h2[coc]'], 3],
			['section:alpha', ['src/app.test.ts: h1[oooo]', 'src/app.ts: h1[coooeec]'], 7],
			['section:empty', [], 0],
			['ignored', [], 0],
			['uncategorised', ['assets/logo.png: (file)'], 1]
		]);
	});

	it('names the group a muted line belongs to', () => {
		const state = after([
			{ file: 'src/app.ts', hunks: ['h1'], section: 'alpha' },
			{ file: 'src/app.ts', lines: '+3', section: 'beta' }
		]);
		const alpha = sectionView(diff, state).groups.find(
			(g) => groupKeyId(g.key) === 'section:alpha'
		);
		const slice = alpha?.slices[0];
		const muted =
			slice?.kind === 'lines'
				? slice.hunks[0]?.lines.find((l) => l.kind === 'elsewhere')
				: undefined;
		expect(muted?.kind === 'elsewhere' && muted.group).toEqual({
			kind: 'section',
			section: 'beta'
		});
	});

	it('leaves out hunks that hold none of the slice', () => {
		const state = after([{ file: 'src/app.ts', hunks: ['h2'], section: 'alpha' }]);
		const alpha = sectionView(diff, state).groups[0];
		expect(alpha?.slices.map(show)).toEqual(['src/app.ts: h2[coc]']);
	});
});

describe('testsSeparateView', () => {
	it('lifts test lines into a Tests group by section, and changes no assignment', () => {
		const state = after([
			{ file: 'src/app.ts', section: 'alpha' },
			{ file: 'src/app.ts', lines: '+11', section: 'alpha', role: 'test' },
			{ file: 'src/app.test.ts', section: 'alpha' }
		]);
		const before = JSON.stringify(outline(sectionView(diff, state)));
		expect(outline(testsSeparateView(diff, state, [section('alpha')]))).toEqual([
			['section:alpha', ['src/app.ts: h1[coooooc]'], 5],
			['tests:alpha', ['src/app.test.ts: h1[oooo]', 'src/app.ts: h2[coc]'], 5],
			['ignored', [], 0],
			['uncategorised', ['assets/logo.png: (file)'], 1]
		]);
		expect(JSON.stringify(outline(sectionView(diff, state)))).toBe(before);
	});
});

/** Every change unit, as `path old:3`, `path new:4` or `path file`, owned by some slice. */
function ownedUnits(view: View): readonly string[] {
	const owned: string[] = [];
	for (const group of view.groups) {
		for (const slice of group.slices) {
			if (slice.kind === 'file') {
				owned.push(`${slice.file.path} file`);
				continue;
			}
			for (const hunk of slice.hunks) {
				expect(hunk.lines.some((l) => l.kind === 'own')).toBe(true);
				for (const line of hunk.lines) {
					if (line.kind !== 'own') continue;
					owned.push(
						line.line.kind === 'added'
							? `${slice.file.path} new:${String(line.line.new)}`
							: `${slice.file.path} old:${String(line.line.old)}`
					);
				}
			}
		}
	}
	return owned;
}

function allUnits(d: Diff): readonly string[] {
	return d.files.flatMap((f) =>
		f.hasLines
			? [
					...[...f.changed.old.values()].map((n) => `${f.file.path} old:${String(n)}`),
					...[...f.changed.new.values()].map((n) => `${f.file.path} new:${String(n)}`)
				]
			: [`${f.file.path} file`]
	);
}

describe('view properties', () => {
	const request = fc.record(
		{
			glob: fc.constantFrom('*.ts', 'src/**', '*.md', '*.png'),
			section: fc.constantFrom('alpha', 'beta', 'ignored'),
			reason: fc.constant('Reason'),
			role: fc.constantFrom('code', 'test')
		},
		{ requiredKeys: ['glob', 'section'] }
	);

	it('shows every change unit as its own in exactly one slice, in both views', () => {
		fc.assert(
			fc.property(arbitraryDiff, fc.array(request, { maxLength: 4 }), (d, requests) => {
				const state = assign(d, initialState(d), requests).state;
				for (const view of [sectionView(d, state), testsSeparateView(d, state)]) {
					const owned = ownedUnits(view);
					expect([...owned].sort()).toEqual([...allUnits(d)].sort());
					expect(view.groups.reduce((n, g) => n + g.units, 0)).toBe(d.unitCount);
				}
			}),
			{ numRuns: 40 }
		);
	});
});
