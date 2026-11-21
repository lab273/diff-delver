import { describe, expect, it } from 'vitest';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { parseAbsolutePath } from '../absolute-path.tiny.ts';
import { describeClosedReason, diffSizeOf, repositoryLabel } from './describe-report.ts';
import {
	applySectionChange,
	applySectionRequests,
	describeSectionProblem,
	MAX_REFERENCES
} from './section-requests.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import { formatLineRanges, lineRangesOf } from '../line-range.ts';
import type { Section } from './report.ts';
import { nothingLeft } from './nothing-left.ts';
import { parseCommitId } from '../commit-id.tiny.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '../sources/git-source-spec.ts';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

function sections(result: ReturnType<typeof applySectionRequests>): readonly Section[] {
	if (!result.ok) throw new Error(result.error.map(describeSectionProblem).join(' '));
	return result.value;
}

describe('section requests', () => {
	const first = sections(
		applySectionRequests(
			[],
			[
				{ id: 'auth', title: 'Sign-in', summary: 'How *sign-in* works' },
				{ id: 'ui', title: 'The page' }
			]
		)
	);

	it('add new sections at the end, in the order given', () => {
		expect(first.map((s) => [s.id, s.title, s.summary])).toEqual([
			['auth', 'Sign-in', 'How *sign-in* works'],
			['ui', 'The page', undefined]
		]);
	});

	it('retitle or summarise a section and keep what an item leaves out', () => {
		const next = sections(applySectionRequests(first, [{ id: 'auth', title: 'Signing in' }]));
		expect(next[0]).toEqual({ id: 'auth', title: 'Signing in', summary: 'How *sign-in* works' });
	});

	it('reorder every section when an order is given', () => {
		const next = sections(
			applySectionRequests(first, [{ id: 'db', title: 'Storage' }], ['db', 'ui', 'auth'])
		);
		expect(next.map((s) => s.id)).toEqual(['db', 'ui', 'auth']);
	});

	it('refuse everything, saying why, when anything is wrong', () => {
		const refused = applySectionRequests(
			first,
			[
				{ id: 'Not An Id', title: 'x' },
				{ id: 'new', summary: 'no title' },
				{ id: 'ui', title: 'a\nb' },
				{ id: 'ui', title: 'again' },
				{ id: 'auth', summary: ' ' }
			],
			['auth', 'auth', 'nope']
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.error.map((p) => p.kind)).toEqual([
			'InvalidSectionId',
			'MissingTitle',
			'InvalidTitle',
			'RepeatedSection',
			'InvalidSummary',
			'IncompleteOrder'
		]);
		const text = refused.error.map(describeSectionProblem).join('\n');
		expect(text).toMatch(/new is a new section, so it needs a title/);
		expect(text).toMatch(/it leaves out ui and "auth", "nope" are not a section or appear twice/);
	});
});

describe('reports in plain words', () => {
	it.each([
		['/work/diff-delver', 'diff-delver'],
		['/work/diff-delver/.git', 'diff-delver'],
		['/srv/project.git', 'project.git'],
		['/', '/']
	])('names the repository at %s %s', (at, label) => {
		const parsed = parseAbsolutePath(at);
		if (!parsed.ok) throw new Error(at);
		expect(repositoryLabel(parsed.value)).toBe(label);
	});

	it('says why a report closed', () => {
		expect(describeClosedReason('source-empty')).toMatch(/committed, merged or discarded/);
	});

	it('counts files and lines added and deleted', () => {
		const d = syntheticDiff([
			{ path: 'a.png', change: 'binary' },
			{ path: 'b.ts', change: 'modified', hunks: [{ gap: 0, lines: ['-', '-', '+', ' '] }] }
		]);
		expect(diffSizeOf(d)).toEqual({ files: 2, addedLines: 1, deletedLines: 2 });
	});
});

describe('nothing left to review', () => {
	const spec = (text: string): GitSourceSpec => {
		const parsed = parseGitSourceSpec(text);
		if (!parsed.ok) throw new Error(text);
		return parsed.value;
	};

	it('says a commit or a range has nothing left, and offers nothing instead', () => {
		expect(nothingLeft(spec('feature-x'), { kind: 'unknown' })).toEqual({
			reason:
				'Nothing is left to review here: feature-x now names a commit that changes no files. What you were reading is still shown.',
			next: undefined
		});
		expect(nothingLeft(spec('main...refs/heads/feature-X'), { kind: 'unknown' }).reason).toMatch(
			/feature-X has no changes compared with main any more, most likely because it was merged/
		);
	});

	it('names the commit without a subject when git gave none', () => {
		const commit = parseCommitId('1a2b3c4d'.repeat(5));
		if (!commit.ok) throw new Error('commit');
		const left = nothingLeft(spec('staged'), {
			kind: 'one',
			commit: commit.value,
			subject: undefined
		});
		expect(left.next?.offer).toBe('Review commit 1a2b3c4');
		expect(left.reason).toMatch(
			/staged changes have most likely been committed, in commit 1a2b3c4\./
		);
	});
});

describe('a whole section change', () => {
	const diff = syntheticDiff([
		{ path: 'a.png', change: 'binary' },
		{ path: 'src/b.ts', change: 'modified', hunks: [{ gap: 2, lines: ['-', '+', '+', ' '] }] }
	]);
	const start = sections(
		applySectionRequests(
			[],
			[
				{ id: 'auth', title: 'Sign-in' },
				{ id: 'ui', title: 'The page' },
				{ id: 'empty', title: 'Nothing yet' }
			]
		)
	);
	const held = new Map([
		['auth', 3],
		['ui', 1]
	]);
	const context = {
		diff,
		unitsIn: (id: string) => unitCountOf(held.get(id) ?? 0)
	};
	const existing = { sections: start, references: new Map() };

	it('keeps only the changed lines a cross-reference names, merged per file', () => {
		const after = applySectionChange(
			existing,
			{
				sections: [
					{
						id: 'ui',
						references: [
							{ file: 'src/b.ts', lines: '+1..+10' },
							{ file: 'src/b.ts', lines: '-3' },
							{ file: 'a.png', lines: 'file' }
						]
					}
				]
			},
			context
		);
		if (!after.ok) throw new Error(after.error.map(describeSectionProblem).join(' '));
		const ui = after.value.references.get(value(parseSectionId('ui')));
		expect(
			[...(ui?.files ?? [])].map(([p, f]) => [
				p,
				formatLineRanges(lineRangesOf('old', f.old)),
				formatLineRanges(lineRangesOf('new', f.new)),
				f.file
			])
		).toEqual([
			['src/b.ts', '-3', '+3..+4', false],
			['a.png', '', '', true]
		]);
		// Left out, references stay; an empty list clears them.
		const kept = applySectionChange(
			after.value,
			{ sections: [{ id: 'ui', title: 'Page' }] },
			context
		);
		expect(kept.ok && kept.value.references.size).toBe(1);
		const cleared = applySectionChange(
			after.value,
			{ sections: [{ id: 'ui', references: [] }] },
			context
		);
		expect(cleared.ok && cleared.value.references.size).toBe(0);
	});

	it('removes a section that holds nothing, with its cross-references, and refuses one that holds lines', () => {
		const removed = applySectionChange(existing, { sections: [], remove: ['empty'] }, context);
		expect(removed.ok && removed.value.sections.map((s) => s.id)).toEqual(['auth', 'ui']);
		// Removing it again, as a call sent twice does, changes nothing and is no refusal.
		if (!removed.ok) return;
		const again = applySectionChange(removed.value, { sections: [], remove: ['empty'] }, context);
		expect(again).toEqual(removed);
		const refused = applySectionChange(
			existing,
			{
				sections: [
					{ id: 'ui', references: [{ file: 'src/b.ts', lines: '+40' }] },
					{ id: 'empty', title: 'x' }
				],
				remove: ['auth', 'Not An Id', 'empty']
			},
			context
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.error.map(describeSectionProblem)).toEqual([
			"Item 0, reference 0: src/b.ts: +40 holds no changed line, so nothing was assigned for this item. A range takes the changed lines inside it and may span unchanged ones, but an item's ranges must hold at least one between them. Nearby: +3..+4. Use the +/- labels from get_diff.",
			'auth cannot be removed: it still holds 3 changed lines. Move them to another section with assign first, naming them with "lines", then remove it.',
			'"Not An Id" cannot be removed: it is not a section id, so it never named a section. The sections are auth, ui, empty.',
			'empty is both changed and removed in the same call. Do one or the other.'
		]);
	});

	it('checks the order against the sections left after removing', () => {
		const ordered = applySectionChange(
			existing,
			{ sections: [], remove: ['empty'], order: ['ui', 'auth'] },
			context
		);
		expect(ordered.ok && ordered.value.sections.map((s) => s.id)).toEqual(['ui', 'auth']);
		const stale = applySectionChange(
			existing,
			{ sections: [], remove: ['empty'], order: ['ui', 'auth', 'empty'] },
			context
		);
		expect(stale.ok ? [] : stale.error.map((p) => p.kind)).toEqual(['IncompleteOrder']);
	});

	it('refuses too many cross-references for one section', () => {
		const many = Array.from({ length: MAX_REFERENCES + 1 }, () => ({
			file: 'src/b.ts',
			lines: '+3'
		}));
		const refused = applySectionChange(
			existing,
			{ sections: [{ id: 'ui', references: many }] },
			context
		);
		expect(refused.ok ? [] : refused.error.map((p) => p.kind)).toEqual(['TooManyReferences']);
	});
});
