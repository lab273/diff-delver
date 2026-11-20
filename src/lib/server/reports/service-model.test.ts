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
import { tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { arbitraryAssignRequest } from '../../../../tests/support/synthetic-diff.ts';
import { Database } from '../db/index.ts';
import { assignmentRowsFor } from '../db/tables/assignments.ts';
import { reviewedRowsFor } from '../db/tables/reviewed-marks.ts';
import { ReportService } from './index.ts';

type Call =
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
function arbitraryCalls(diff: Diff): fc.Arbitrary<Call[]> {
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
	const call: fc.Arbitrary<Call> = fc.oneof(
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
});
