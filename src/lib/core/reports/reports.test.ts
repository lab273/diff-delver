import { describe, expect, it } from 'vitest';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { parseAbsolutePath } from '../absolute-path.tiny.ts';
import { describeClosedReason, diffSizeOf, repositoryLabel } from './describe-report.ts';
import { applySectionRequests, describeSectionProblem } from './section-requests.ts';
import type { Section } from './report.ts';
import { nothingLeft } from './nothing-left.ts';
import { parseCommitId } from '../commit-id.tiny.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '../sources/git-source-spec.ts';

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
		expect(text).toMatch(/it leaves out ui and auth, nope are not a section or appear twice/);
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
