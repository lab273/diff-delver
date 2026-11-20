/**
 * The report service against the pure model: any sequence of the agent's and
 * the reviewer's calls leaves in the database exactly the state, the marks and
 * the list's progress that core computes from the same calls. The service
 * rewrites only the rows of the files a call changed, so this is what shows
 * that a partial rewrite never loses or keeps a row it should not.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { assign, type AssignRequest } from '#lib/core/diff/assign.ts';
import type { Diff } from '#lib/core/diff/diff.ts';
import type { GroupKey, ViewKind } from '#lib/core/diff/slices.ts';
import type { AssignmentState } from '#lib/core/diff/state.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { markReviewed, type ReviewTarget } from '#lib/core/review/mark-reviewed.ts';
import { reviewProgress, unitProgressOf } from '#lib/core/review/progress.ts';
import {
	NO_MARKS,
	sameReviewedMarks,
	type ReviewedMarks
} from '#lib/core/review/reviewed-marks.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { parseSectionId, type SectionId } from '#lib/core/section-id.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import {
	assignmentStateFromRows,
	reviewedMarksFromRows,
	sameAssignmentState
} from '#lib/core/storage/stored-units.ts';
import { andThen, ok } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { awkwardChanges } from '../../../../tests/support/diff-fixtures.ts';
import { emptyRepo, tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import type { GitRepo } from '../../../../tests/support/git-repo.ts';
import { carryOver } from '#lib/core/update/carry-over.ts';
import { sameUnitSet } from '#lib/core/diff/unit-set.ts';
import { generatedPaths, readTreeDiff } from '../store/index.ts';
import type { LoadedReport } from './index.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { arbitraryAssignRequest } from '../../../../tests/support/synthetic-diff.ts';
import { Database } from '../db/index.ts';
import { assignmentRowsFor } from '../db/tables/assignments.ts';
import { reviewedRowsFor } from '../db/tables/reviewed-marks.ts';
import { ReportService } from './index.ts';

/** A change a person makes to the working tree before asking for an update. */
type Edit =
	| 'insert-top'
	| 'append'
	| 'change'
	| 'remove-file'
	| 'add-file'
	| 'lockfile'
	| 'touch'
	/** a.ts made executable, or no longer: its mode. */
	| 'chmod'
	/** b.ts moved to moved/b.ts, or back: its name. */
	| 'rename'
	/** c.ts replaced by a link, or by a file again: its kind. */
	| 'link';

type Call =
	| { readonly kind: 'update'; readonly edit: Edit }
	| { readonly kind: 'sections'; readonly ids: readonly string[] }
	| { readonly kind: 'assign'; readonly requests: readonly AssignRequest[] }
	| {
			readonly kind: 'mark';
			readonly target: ReviewTarget;
			readonly reviewed: boolean;
			readonly view: ViewKind;
	  };

function section(id: string): SectionId {
	return value(parseSectionId(id));
}

/** Calls of every kind against the diff, valid or not. `gamma` is never created. */
function arbitraryCalls(diff: Diff, updates = false): fc.Arbitrary<Call[]> {
	const paths: RepoPath[] = [
		...diff.files.map((f) => f.file.path),
		value(parseRepoPath('not/in/the-diff.txt'))
	];
	const groups: GroupKey[] = [
		{ kind: 'section', section: section('alpha') },
		{ kind: 'section', section: section('beta') },
		{ kind: 'section', section: section('gamma') },
		{ kind: 'tests', section: section('alpha') },
		{ kind: 'ignored' },
		{ kind: 'uncategorised' }
	];
	const target: fc.Arbitrary<ReviewTarget> = fc.oneof(
		fc.constantFrom(...paths).map((path): ReviewTarget => ({ kind: 'file', path })),
		fc.constantFrom(...groups).map((group): ReviewTarget => ({ kind: 'group', group })),
		fc
			.tuple(fc.constantFrom(...groups), fc.constantFrom(...paths))
			.map(([group, path]): ReviewTarget => ({ kind: 'slice', group, path }))
	);
	const update: fc.Arbitrary<Call> = fc
		.constantFrom<Edit>(
			'insert-top',
			'append',
			'change',
			'remove-file',
			'add-file',
			'lockfile',
			'touch',
			'chmod',
			'rename',
			'link'
		)
		.map((edit): Call => ({ kind: 'update', edit }));
	const call: fc.Arbitrary<Call> = fc.oneof(
		{ weight: updates ? 2 : 0, arbitrary: update },
		fc
			.subarray(['alpha', 'beta'], { minLength: 1 })
			.map((ids): Call => ({ kind: 'sections', ids })),
		{
			weight: 3,
			arbitrary: fc
				.array(arbitraryAssignRequest(diff), { minLength: 1, maxLength: 4 })
				.map((requests): Call => ({ kind: 'assign', requests }))
		},
		{
			weight: 3,
			arbitrary: fc
				.tuple(target, fc.boolean(), fc.constantFrom<ViewKind>('sections', 'tests-separate'))
				.map(([t, reviewed, view]): Call => ({ kind: 'mark', target: t, reviewed, view }))
		}
	);
	return fc.array(call, { minLength: 1, maxLength: 8 });
}

interface Model {
	state: AssignmentState;
	marks: ReviewedMarks;
	readonly sections: Set<SectionId>;
}

/** What is stored for the revision, read straight from the database, against the model. */
function checkStored(
	db: Database,
	service: ReportService,
	report: ReportId,
	revision: RevisionId,
	diff: Diff,
	model: Model
): void {
	const stored = value(
		db.read((q) =>
			andThen(assignmentRowsFor(q, revision), (rows) =>
				andThen(assignmentStateFromRows(diff, rows), (state) =>
					andThen(reviewedRowsFor(q, revision), (marked) =>
						andThen(reviewedMarksFromRows(diff, marked), (marks) => ok({ state, marks }))
					)
				)
			)
		)
	);
	expect(sameAssignmentState(diff, model.state, stored.state)).toBe(true);
	expect(sameReviewedMarks(model.marks, stored.marks)).toBe(true);
	const listed = value(service.list()).find((r) => r.id === report);
	expect(listed?.kind === 'report' ? listed.progress : undefined).toEqual(
		unitProgressOf(reviewProgress(diff, model.state, model.marks, 'sections'))
	);
}

/** What `load` gives the page, against the model. */
async function checkLoaded(
	service: ReportService,
	report: ReportId,
	diff: Diff,
	model: Model
): Promise<void> {
	const page = value(await service.load(report));
	expect(sameAssignmentState(diff, model.state, page.state)).toBe(true);
	expect(sameReviewedMarks(model.marks, page.reviewed)).toBe(true);
}

describe('the report service against the pure model', () => {
	it('stores what core computes after any sequence of sections, assign items and ticks', async () => {
		const repo = await useFixture(awkwardChanges);
		const data = await tempDirectory();
		const who = await reviewer();
		const service = value(
			await ReportService.open({
				dataDirectory: data,
				clock: settableClock(at(0)),
				ids: sequentialIds(),
				repository: { gitEnv: who.gitEnv }
			})
		);
		const source = value(parseGitSourceSpec('head'));
		const first = value(await service.open(repo.dir, source));
		if (first.kind !== 'created') throw new Error(first.kind);
		const diff = value(await service.load(first.report.id)).diff;
		value(service.closeReport(first.report.id));
		// A second connection, to read what the service stored without going through it.
		const db = value(await Database.open(data, settableClock(at(0))));

		await fc.assert(
			fc.asyncProperty(arbitraryCalls(diff), async (calls) => {
				// A fresh report for each run, on the same diff.
				const opened = value(await service.open(repo.dir, source));
				if (opened.kind !== 'created') throw new Error(opened.kind);
				const id = opened.report.id;
				try {
					const start = value(await service.load(id));
					const model: Model = { state: start.state, marks: NO_MARKS, sections: new Set() };
					for (const call of calls) {
						switch (call.kind) {
							case 'update':
								throw new Error('This property makes no updates.');
							case 'sections':
								value(
									service.upsertSections(
										id,
										call.ids.map((s) => ({ id: s, title: `Section ${s}` }))
									)
								);
								for (const s of call.ids) model.sections.add(section(s));
								break;
							case 'assign': {
								const expected = assign(diff, model.state, call.requests, {
									knownSections: model.sections
								});
								const outcome = value(await service.assign(id, call.requests));
								expect(outcome.accepted).toEqual(expected.accepted);
								expect(outcome.rejected).toEqual(expected.rejected);
								model.state = expected.state;
								break;
							}
							case 'mark': {
								const expected = markReviewed(
									diff,
									model.state,
									model.marks,
									call.target,
									call.reviewed,
									call.view
								);
								const outcome = await service.markReviewed(
									id,
									call.target,
									call.reviewed,
									call.view
								);
								if (expected.ok) {
									expect(value(outcome).units).toBe(expected.value.units);
									model.marks = expected.value.marks;
								} else {
									expect(outcome.ok ? undefined : outcome.error.kind).toBe(expected.error.kind);
								}
								break;
							}
						}
						checkStored(db, service, id, start.revision.id, diff, model);
					}
					await checkLoaded(service, id, diff, model);
				} finally {
					// Closed even when a run fails, so the runs that shrink it start afresh.
					value(service.closeReport(id));
				}
			}),
			{ numRuns: 25 }
		);
		db.close();
		service.close();
	});

	it('stores what core computes when updates come between the other calls', async () => {
		const repo = await emptyRepo();
		const committed = {
			'a.ts': lines('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'),
			'b.ts': lines('one', 'two', 'three'),
			'c.ts': lines('gone soon')
		};
		for (const [file, text] of Object.entries(committed)) await repo.write(file, text);
		await repo.commit('first');
		/** The working tree, as the test knows it. */
		const tree: WorkingTree = { files: new Map(), executable: new Set(), links: new Set() };
		/** The working tree each run starts from. */
		const startingPoint = async (): Promise<void> => {
			tree.files.clear();
			tree.executable.clear();
			tree.links.clear();
			for (const file of ['d.ts', 'pnpm-lock.yaml', 'moved', 'c.ts']) await repo.remove(file);
			const start = {
				...committed,
				'a.ts': lines('alpha', 'BETA', 'gamma', 'delta', 'added', 'epsilon', 'zeta'),
				'b.ts': lines('one', 'two', 'three', 'four')
			};
			for (const [file, text] of Object.entries(start)) {
				tree.files.set(file, text);
				await repo.write(file, text);
			}
		};
		await startingPoint();
		const data = await tempDirectory();
		const who = await reviewer();
		const service = value(
			await ReportService.open({
				dataDirectory: data,
				clock: settableClock(at(0)),
				ids: sequentialIds(),
				repository: { gitEnv: who.gitEnv }
			})
		);
		const source = value(parseGitSourceSpec('working-tree'));
		const first = value(await service.open(repo.dir, source));
		if (first.kind !== 'created') throw new Error(first.kind);
		const diff = value(await service.load(first.report.id)).diff;
		value(service.closeReport(first.report.id));
		const db = value(await Database.open(data, settableClock(at(0))));

		await fc.assert(
			fc.asyncProperty(arbitraryCalls(diff, true), async (calls) => {
				await startingPoint();
				const opened = value(await service.open(repo.dir, source));
				if (opened.kind !== 'created') throw new Error(opened.kind);
				const id = opened.report.id;
				try {
					let page = value(await service.load(id));
					const model: Model = { state: page.state, marks: NO_MARKS, sections: new Set() };
					for (const call of calls) {
						switch (call.kind) {
							case 'update': {
								await edit(repo, tree, call.edit);
								const before = page;
								const outcome = value(await service.update(id));
								page = value(await service.load(id));
								if (outcome.kind !== 'updated') {
									expect(outcome.kind).toBe('unchanged');
									expect(page.revision.id).toBe(before.revision.id);
									break;
								}
								const expected = await expectedUpdate(before, page, model);
								expect(sameAssignmentState(page.diff, expected.state, page.state)).toBe(true);
								expect(sameReviewedMarks(expected.marks, page.reviewed)).toBe(true);
								expect(sameUnitSet(expected.fresh, page.fresh)).toBe(true);
								expect(page.update?.summary).toEqual(expected.summary);
								// Every section is kept, in its place, whether or not anything is left in it.
								expect(page.sections.map((x) => x.id)).toEqual([...model.sections]);
								model.state = expected.state;
								model.marks = expected.marks;
								break;
							}
							case 'sections':
								value(
									service.upsertSections(
										id,
										call.ids.map((x) => ({ id: x, title: `Section ${x}` }))
									)
								);
								for (const x of call.ids) model.sections.add(section(x));
								break;
							case 'assign': {
								const expected = assign(page.diff, model.state, call.requests, {
									knownSections: model.sections
								});
								const outcome = value(await service.assign(id, call.requests));
								expect(outcome.rejected).toEqual(expected.rejected);
								model.state = expected.state;
								break;
							}
							case 'mark': {
								const expected = markReviewed(
									page.diff,
									model.state,
									model.marks,
									call.target,
									call.reviewed,
									call.view
								);
								const outcome = await service.markReviewed(
									id,
									call.target,
									call.reviewed,
									call.view
								);
								if (expected.ok) model.marks = expected.value.marks;
								else expect(outcome.ok ? undefined : outcome.error.kind).toBe(expected.error.kind);
								break;
							}
						}
						checkStored(db, service, id, page.revision.id, page.diff, model);
					}
					await checkLoaded(service, id, page.diff, model);
				} finally {
					value(service.closeReport(id));
				}
			}),
			{ numRuns: 10 }
		);
		db.close();
		service.close();
	});
});

const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;

/** The working tree, as the test knows it: text files, which are executable, which are links. */
interface WorkingTree {
	readonly files: Map<string, string>;
	readonly executable: Set<string>;
	/** Links, each to a.ts; not in `files`. */
	readonly links: Set<string>;
}

/**
 * Makes one change to the working tree, keeping `tree`, what the test knows of
 * it, up to date. Each change is new text, a new mode, name or kind, so it
 * always changes something, except `touch`, which writes a file again as it
 * was: a false alarm.
 */
async function edit(repo: GitRepo, tree: WorkingTree, what: Edit): Promise<void> {
	const write = async (file: string, text: string | undefined): Promise<void> => {
		tree.links.delete(file);
		if (text === undefined) {
			tree.files.delete(file);
			await repo.remove(file);
		} else {
			tree.files.set(file, text);
			await repo.write(file, text);
			if (tree.executable.has(file)) await repo.setExecutable(file, true);
		}
	};
	const count = String(tree.files.size + (tree.files.get('a.ts') ?? '').length);
	// b.ts, wherever it is now.
	const b = tree.files.has('moved/b.ts') ? 'moved/b.ts' : 'b.ts';
	switch (what) {
		case 'insert-top':
			return write('a.ts', `top ${count}\n${tree.files.get('a.ts') ?? ''}`);
		case 'append':
			return write(b, `${tree.files.get(b) ?? ''}more ${count}\n`);
		case 'change':
			return write('a.ts', (tree.files.get('a.ts') ?? '').replace(/^gamma.*$/m, `gamma ${count}`));
		case 'remove-file':
			return write('c.ts', undefined);
		case 'add-file':
			return write('d.ts', `${tree.files.get('d.ts') ?? ''}new ${count}\n`);
		case 'lockfile':
			return write('pnpm-lock.yaml', `${tree.files.get('pnpm-lock.yaml') ?? ''}lock: ${count}\n`);
		case 'touch':
			return write(b, tree.files.get(b) ?? '');
		case 'chmod': {
			const executable = !tree.executable.has('a.ts');
			if (executable) tree.executable.add('a.ts');
			else tree.executable.delete('a.ts');
			return repo.setExecutable('a.ts', executable);
		}
		case 'rename': {
			const to = b === 'b.ts' ? 'moved/b.ts' : 'b.ts';
			tree.files.set(to, tree.files.get(b) ?? '');
			tree.files.delete(b);
			await repo.move(b, to);
			if (b === 'moved/b.ts') await repo.remove('moved');
			return;
		}
		case 'link':
			if (tree.links.has('c.ts')) return write('c.ts', lines('gone soon', `back ${count}`));
			tree.files.delete('c.ts');
			tree.links.add('c.ts');
			return repo.symlink('c.ts', 'a.ts');
	}
}

/** What core computes for the update from `before` to `after`, from the store alone. */
async function expectedUpdate(before: LoadedReport, after: LoadedReport, model: Model) {
	const store = after.snapshot.store;
	const heads = value(await readTreeDiff(store, before.revision.headTree, after.revision.headTree));
	const bases = value(await readTreeDiff(store, before.revision.baseTree, after.revision.baseTree));
	const generated = value(
		await generatedPaths(
			after.snapshot,
			after.diff.files.map((f) => f.file.path)
		)
	);
	return carryOver({
		previous: { diff: before.diff, state: model.state, marks: model.marks },
		diff: after.diff,
		heads: { kind: 'diff', files: heads },
		bases: { kind: 'diff', files: bases },
		autoIgnore: { markedGenerated: generated }
	});
}
