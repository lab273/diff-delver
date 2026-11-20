import { describe, expect, it } from 'vitest';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import { autoIgnore } from '../diff/auto-ignore.ts';
import { initialState } from '../diff/state.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { parseSectionTitle } from '../section-title.tiny.ts';
import { listFiles } from './file-list.ts';
import type { Section } from './report.ts';

function section(id: string, title: string): Section {
	const sectionId = parseSectionId(id);
	const sectionTitle = parseSectionTitle(title);
	if (!sectionId.ok || !sectionTitle.ok) throw new Error('bad section');
	return { id: sectionId.value, title: sectionTitle.value, summary: undefined };
}

const diff = syntheticDiff([
	{ path: 'assets/logo.png', change: 'binary' },
	{ path: 'pnpm-lock.yaml', change: 'added', lines: 3 },
	{
		path: 'src/app.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '-', '-', '+', '+', '+', ' '] },
			{ gap: 4, lines: [' ', '+', ' '] }
		]
	}
]);

describe('listFiles', () => {
	it('lists every file under Not sorted yet when nothing is sorted, with the lockfile under Ignored', () => {
		const state = autoIgnore(diff, initialState(diff)).state;
		expect(listFiles(diff, state, [])).toEqual([
			{
				kind: 'ignored',
				files: [
					{
						path: 'pnpm-lock.yaml',
						status: 'added',
						from: undefined,
						content: 'text',
						added: 3,
						removed: 0,
						ignored: [{ kind: 'stated', text: 'Lockfile' }]
					}
				]
			},
			{
				kind: 'uncategorised',
				files: [
					{
						path: 'assets/logo.png',
						status: 'modified',
						from: undefined,
						content: 'binary',
						added: 0,
						removed: 0,
						ignored: []
					},
					{
						path: 'src/app.ts',
						status: 'modified',
						from: undefined,
						content: 'text',
						added: 4,
						removed: 2,
						ignored: []
					}
				]
			}
		]);
	});

	it('lists a file split between groups in each, with that group’s lines', () => {
		const sections = [section('alpha', 'Alpha work'), section('empty', 'Nothing here')];
		const state = assign(diff, initialState(diff), [
			{ file: 'src/app.ts', lines: '-2..-3,+2', section: 'alpha' },
			{ file: 'assets/logo.png', section: 'ignored', reason: 'Re-exported by the build' }
		]).state;
		const groups = listFiles(diff, state, sections);
		expect(
			groups.map((g) => [
				g.kind,
				g.kind === 'section' ? g.title : '',
				g.files.map((f) => [f.path, f.added, f.removed])
			])
		).toEqual([
			['section', 'Alpha work', [['src/app.ts', 1, 2]]],
			['ignored', '', [['assets/logo.png', 0, 0]]],
			[
				'uncategorised',
				'',
				[
					['pnpm-lock.yaml', 3, 0],
					['src/app.ts', 3, 0]
				]
			]
		]);
		expect(groups[1]?.files[0]?.ignored).toEqual([
			{ kind: 'agent', reason: 'Re-exported by the build' }
		]);
	});
});
