import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock, type SettableClock } from '#lib/core/clock.ts';
import { assignedUnits } from '#lib/core/diff/state.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseGitSourceSpec, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { listSnapshots, listStores } from '#lib/server/store/index.ts';
import { snapshotGitSource } from '#lib/server/sources/git/index.ts';
import { oddPathBytes } from '../../../../tests/support/diff-fixtures.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import type { GitRepo } from '../../../../tests/support/git-repo.ts';
import { located, value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer, type Reviewer } from '../../../../tests/support/reviewer-git.ts';
import { Database } from '../db/index.ts';
import { GRACE_PERIOD } from '../store/index.ts';
import {
	describeReportError,
	ReportService,
	type LoadedReport,
	type OpenOutcome,
	type ReportError
} from './index.ts';

interface Setup {
	readonly repo: GitRepo;
	readonly who: Reviewer;
	readonly data: AbsolutePath;
	readonly clock: SettableClock;
	readonly service: ReportService;
}

/** A service on a fresh data directory, and a repository with one commit and uncommitted changes. */
async function setUp(): Promise<Setup> {
	const repo = await emptyRepo();
	await repo.write('src/app.ts', 'one\ntwo\nthree\n');
	await repo.write('README.md', '# App\n');
	await repo.commit('first');
	await repo.write('src/app.ts', 'one\n2\nthree\nfour\n');
	await repo.write('src/app.test.ts', 'test\n');
	await repo.write('package-lock.json', '{}\n');
	const who = await reviewer();
	const data = await tempDirectory();
	const clock = settableClock(at(1_700_000_000_000));
	const service = await serviceOn(data, clock, who);
	return { repo, who, data, clock, service };
}

async function serviceOn(
	data: AbsolutePath,
	clock: SettableClock,
	who: Reviewer,
	prefix = ''
): Promise<ReportService> {
	return value(
		await ReportService.open({
			dataDirectory: data,
			clock,
			ids: sequentialIds(prefix),
			repository: { gitEnv: who.gitEnv }
		})
	);
}

function spec(text: string): GitSourceSpec {
	return value(parseGitSourceSpec(text));
}

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

function failure<T>(result: Result<T, ReportError>): ReportError {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

function created(outcome: OpenOutcome): ReportId {
	if (outcome.kind !== 'created') throw new Error(`expected a new report, got ${outcome.kind}`);
	return outcome.report.id;
}

async function snapshotCount(data: AbsolutePath): Promise<number> {
	let count = 0;
	for (const store of value(await listStores(data)))
		count += value(await listSnapshots(store)).length;
	return count;
}

/** Each file's runs as "path: side first..last bucket role", for comparing loads. */
function describeState(page: LoadedReport): readonly string[] {
	return page.diff.files.flatMap((file) =>
		assignedUnits(page.state, file).map((u) => {
			const where =
				u.kind === 'lines'
					? `${u.range.side} ${String(u.range.first)}..${String(u.range.last)}`
					: 'file';
			const bucket = u.assignment.bucket;
			const name = bucket.kind === 'section' ? bucket.section : bucket.kind;
			return `${escapedRepoPath(file.file.path)}: ${where} ${name} ${u.assignment.role}`;
		})
	);
}

describe('the report service', () => {
	it('opens uncommitted changes as a new report, sorting out the lockfile, and resumes it the next time', async () => {
		const { repo, service } = await setUp();
		const opened = value(await service.open(repo.dir, spec('working-tree')));
		expect(opened).toMatchObject({
			kind: 'created',
			report: {
				id: 'r_1',
				title: 'Uncommitted changes',
				state: { kind: 'open' },
				revision: 1,
				size: { files: 3, addedLines: 4, deletedLines: 1 },
				progress: { counted: 4, reviewed: 0, ignored: 1, uncategorised: 4 },
				leftOut: 0,
				createdAt: 1_700_000_000_000
			},
			autoIgnored: [{ path: 'package-lock.json', by: { kind: 'rule', rule: 'lockfile' }, units: 1 }]
		});
		const again = value(await service.open(repo.dir, spec('uncommitted')));
		expect(again).toMatchObject({ kind: 'resumed', changed: false, report: { id: 'r_1' } });
		const list = value(service.list());
		expect(list.map((r) => r.id)).toEqual(['r_1']);
		service.close();
	});

	it('says there is nothing to review, and keeps no report or snapshot, when a source has no changes', async () => {
		const { repo, data, service } = await setUp();
		await repo.commit('everything');
		const outcome = value(await service.open(repo.dir, spec('working-tree')));
		expect(outcome).toMatchObject({
			kind: 'nothing-to-review',
			source: 'Uncommitted changes',
			closed: undefined
		});
		if (outcome.kind === 'nothing-to-review')
			expect(outcome.reason).toMatch(/no uncommitted changes/);
		expect(value(service.list())).toEqual([]);
		expect(await snapshotCount(data)).toBe(0);
		service.close();
	});

	it('loads a report from the database and the store alone, even once the repository is gone', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		value(service.upsertSections(id, [{ id: 'app', title: 'The app', summary: 'What it *does*' }]));
		value(await service.assign(id, [{ file: 'src/app.ts', lines: '+2', section: 'app' }]));
		value(await service.markReviewed(id, { kind: 'file', path: path('src/app.ts') }, true));
		service.close();
		await rm(repo.dir, { recursive: true, force: true });

		const later = await serviceOn(data, clock, who, 'b');
		const page = value(await later.load(id));
		later.close();
		expect(page.diff.files.map((f) => f.file.path)).toEqual([
			'package-lock.json',
			'src/app.test.ts',
			'src/app.ts'
		]);
		expect(page.sections).toEqual([{ id: 'app', title: 'The app', summary: 'What it *does*' }]);
		expect(describeState(page)).toEqual([
			'package-lock.json: new 1..1 ignored code',
			'src/app.test.ts: new 1..1 uncategorised test',
			'src/app.ts: old 2..2 uncategorised code',
			'src/app.ts: new 2..2 app code',
			'src/app.ts: new 4..4 uncategorised code'
		]);
		expect(page.progress.overall).toEqual({
			units: 4,
			reviewedUnits: 3,
			slices: 3,
			reviewedSlices: 2
		});
		expect(page.summary.progress).toEqual({
			counted: 4,
			reviewed: 3,
			ignored: 1,
			uncategorised: 3
		});
		expect(page.revision.number).toBe(1);
		expect(page.revision.baseCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(page.revision.headCommit).toBeUndefined();
	});

	it('applies sections, assign items and ticks, each saved as it happens', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		clock.advance(1_000);
		const sections = value(
			service.upsertSections(
				id,
				[
					{ id: 'tests', title: 'Tests' },
					{ id: 'app', title: 'The app' }
				],
				['app', 'tests']
			)
		);
		expect(sections.map((s) => s.id)).toEqual(['app', 'tests']);

		const outcome = value(
			await service.assign(id, [
				{ file: 'src/app.ts', section: 'app' },
				{ glob: '**/*.test.ts', section: 'tests' },
				{ file: 'src/app.ts', section: 'nowhere' }
			])
		);
		expect(outcome.accepted.map((a) => a.units)).toEqual([3, 1]);
		expect(outcome.rejected.map((r) => r.rejection.kind)).toEqual(['UnknownSection']);
		expect(outcome.uncategorised).toBe(0);

		const app = value(parseSectionId('app'));
		const ticked = value(
			await service.markReviewed(
				id,
				{ kind: 'slice', group: { kind: 'section', section: app }, path: path('src/app.ts') },
				true
			)
		);
		expect(ticked.units).toBe(3);
		expect(ticked.progress.overall).toEqual({
			units: 4,
			reviewedUnits: 3,
			slices: 2,
			reviewedSlices: 1
		});
		service.close();

		const later = await serviceOn(data, clock, who, 'b');
		const [summary] = value(later.list());
		const page = value(await later.load(id));
		later.close();
		expect(summary).toMatchObject({
			lastActivityAt: 1_700_000_001_000,
			progress: { counted: 4, reviewed: 3, ignored: 1, uncategorised: 0 }
		});
		expect(page.state.files.get(path('src/app.ts'))).toMatchObject({ kind: 'lines' });
		expect(describeState(page)).toContain('src/app.ts: new 4..4 app code');
		expect(
			[...page.progress.groups.values()].map((g) => [g.key.kind, g.tally.reviewedSlices])
		).toEqual([
			['section', 1],
			['section', 0],
			['ignored', 0]
		]);
		expect([...page.progress.groups.values()].map((g) => g.key)).toEqual([
			{ kind: 'section', section: 'app' },
			{ kind: 'section', section: 'tests' },
			{ kind: 'ignored' }
		]);
		expect([...ticked.progress.groups.values()].map((g) => g.key.kind)).toEqual([
			'section',
			'section',
			'ignored'
		]);
	});

	it('changes nothing when a change is refused', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const before = value(await service.load(id));

		const sections = failure(service.upsertSections(id, [{ id: 'app' }]));
		expect(sections.kind).toBe('SectionsRefused');
		expect(describeReportError(sections)).toMatch(/app is a new section, so it needs a title/);
		const empty = failure(
			await service.markReviewed(id, { kind: 'file', path: path('README.md') }, true)
		);
		expect(empty.kind).toBe('FileNotInDiff');
		const rejected = value(await service.assign(id, [{ file: 'src/app.ts', section: 'nowhere' }]));
		expect(rejected.accepted).toEqual([]);

		value(service.closeReport(id));
		expect(
			failure(await service.assign(id, [{ file: 'src/app.ts', section: 'ignored', reason: 'x' }]))
				.kind
		).toBe('ReportClosed');
		expect(
			failure(await service.markReviewed(id, { kind: 'file', path: path('src/app.ts') }, true)).kind
		).toBe('ReportClosed');
		const after = value(await service.load(id));
		service.close();
		expect(describeState(after)).toEqual(describeState(before));
		expect(after.sections).toEqual([]);
		expect(after.reviewed.files.size).toBe(0);
		expect(after.summary.state).toEqual({ kind: 'closed', reason: 'reviewer' });
	});

	it('refuses to load a report whose stored rows no longer fit its diff', async () => {
		const { repo, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		const db = value(await Database.open(data, clock));
		value(
			db.write((q) => {
				q.run("INSERT INTO reviewed_marks VALUES ('v_1', CAST('gone.ts' AS BLOB), 'file', 0, 0)");
				return ok(undefined);
			})
		);
		db.close();
		const error = failure(await service.load(id));
		expect(error).toMatchObject({
			kind: 'StoredStateMismatch',
			what: 'reviewed marks',
			path: 'gone.ts'
		});
		expect(describeReportError(error)).toMatch(/Delete the report and open the source again/);
		const ticked = failure(
			await service.markReviewed(id, { kind: 'file', path: path('src/app.ts') }, true)
		);
		expect(ticked.kind).toBe('StoredStateMismatch');
		service.close();
	});

	it('notices a change, ignores a false alarm, and closes the report once there is nothing left', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });

		// Staging moves the changes into the index; the working tree, and so the snapshot, is the same.
		await repo.git('add', '--all');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'unchanged' });

		await repo.write('src/app.ts', 'changed again\n');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'changed' });
		expect(value(await service.open(repo.dir, spec('working-tree')))).toMatchObject({
			kind: 'resumed',
			changed: true
		});

		await repo.commit('done');
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'source-empty' });
		expect(value(service.list())[0]?.state).toEqual({ kind: 'closed', reason: 'source-empty' });
		expect(value(await service.checkForChanges(id))).toEqual({ kind: 'report-closed' });

		// The next day's work in the same worktree is a new report; the old one stays readable.
		await repo.write('README.md', '# App, again\n');
		const next = value(await service.open(repo.dir, spec('working-tree')));
		expect(next).toMatchObject({ kind: 'created', report: { id: 'r_2' } });
		expect(value(await service.load(id)).summary.state.kind).toBe('closed');
		service.close();
	});

	it('closes a resumed report whose source has become empty, and says so', async () => {
		const { repo, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		await repo.commit('done');
		const outcome = value(await service.open(repo.dir, spec('working-tree')));
		expect(outcome).toMatchObject({ kind: 'nothing-to-review', closed: id });
		service.close();
	});

	it('closes, reopens and deletes reports, freeing their snapshots', async () => {
		const { repo, data, service } = await setUp();
		const first = created(value(await service.open(repo.dir, spec('working-tree'))));
		value(service.closeReport(first));
		const second = created(value(await service.open(repo.dir, spec('working-tree'))));
		const refused = failure(service.reopenReport(first));
		expect(refused).toEqual({ kind: 'AnotherReportOpen', report: first, open: second });
		expect(describeReportError(refused)).toMatch(/cannot be reopened while another report/);

		value(service.closeReport(second));
		expect(value(service.reopenReport(first)).state).toEqual({ kind: 'open' });
		expect(await snapshotCount(data)).toBe(2);

		const deleted = value(await service.deleteReport(second));
		expect(deleted).toEqual({ snapshots: 1, storeProblem: undefined });
		expect(value(service.list()).map((r) => r.id)).toEqual([first]);
		expect(await snapshotCount(data)).toBe(1);
		expect(failure(await service.load(second)).kind).toBe('ReportNotFound');
		expect(failure(await service.deleteReport(second)).kind).toBe('ReportNotFound');
		service.close();
	});

	it('removes a snapshot nothing refers to once the grace period has passed', async () => {
		const { repo, who, data, clock, service } = await setUp();
		const id = created(value(await service.open(repo.dir, spec('working-tree'))));
		// A snapshot taken by a run that crashed before recording its revision.
		value(await snapshotGitSource(data, await located(repo.dir, who), spec('HEAD')));
		expect(await snapshotCount(data)).toBe(2);

		expect(value(await service.removeUnusedSnapshots())).toEqual([]);
		clock.advance(GRACE_PERIOD);
		expect(value(await service.removeUnusedSnapshots())).toEqual([]);
		clock.advance(1);
		expect(value(await service.removeUnusedSnapshots())).toHaveLength(1);
		expect(await snapshotCount(data)).toBe(1);
		expect(value(await service.load(id)).summary.id).toBe(id);
		service.close();
	});

	it('stores paths that are not UTF-8 exactly, and takes them in their escaped form', async () => {
		const repo = await useFixture(oddPathBytes);
		const who = await reviewer();
		const service = await serviceOn(await tempDirectory(), settableClock(at(0)), who);
		const id = created(value(await service.open(repo.dir, spec('HEAD'))));
		value(service.upsertSections(id, [{ id: 'odd', title: 'Odd names' }]));
		const outcome = value(await service.assign(id, [{ file: 'caf\\xE9.txt', section: 'odd' }]));
		expect(outcome.accepted.map((a) => a.units)).toEqual([1]);
		const page = value(await service.load(id));
		service.close();
		expect(page.diff.files.map((f) => escapedRepoPath(f.file.path)).sort()).toEqual([
			'caf\\\\xE9.txt',
			'caf\\xE8.txt',
			'caf\\xE9.txt',
			'dir\\xFF/inner.txt'
		]);
		expect(describeState(page).filter((line) => line.includes(' odd '))).toEqual([
			'caf\\xE9.txt: new 2..2 odd code'
		]);
	});

	it('writes nothing to the reviewed repository, whatever it is asked to do', async () => {
		const { repo, clock, service } = await setUp();
		const { before, after } = await listingsAround([repo.dir], async () => {
			const id = created(value(await service.open(repo.dir, spec('working-tree'))));
			value(await service.open(repo.dir, spec('main...HEAD')));
			value(await service.load(id));
			value(service.list());
			value(service.upsertSections(id, [{ id: 'app', title: 'App' }]));
			value(await service.assign(id, [{ file: 'src/app.ts', section: 'app' }]));
			value(await service.markReviewed(id, { kind: 'file', path: path('src/app.ts') }, true));
			value(await service.checkForChanges(id));
			value(service.closeReport(id));
			value(service.reopenReport(id));
			value(await service.deleteReport(id));
			clock.advance(GRACE_PERIOD + 1);
			value(await service.removeUnusedSnapshots());
		});
		service.close();
		expect(after).toEqual(before);
	});

	it('starts with no arguments on the uncommitted changes, or says why there is nothing', async () => {
		const { repo, service } = await setUp();
		const started = value(await service.start(repo.dir));
		expect(started).toMatchObject({
			kind: 'opened',
			opened: { kind: 'created', report: { title: 'Uncommitted changes' } }
		});
		await repo.commit('done');
		const clean = value(await service.start(repo.dir));
		expect(clean.kind).not.toBe('opened');
		service.close();
	});

	it('explains every failure in words the reviewer can act on', async () => {
		const { service } = await setUp();
		const missing = failure(await service.open(await tempDirectory(), spec('working-tree')));
		expect(missing.kind).toBe('NotARepository');
		expect(describeReportError(missing).length).toBeGreaterThan(20);
		const unknown = failure(await service.load(value(parseReportId('r_404'))));
		expect(describeReportError(unknown)).toMatch(/There is no report r_404/);
		service.close();
	});
});
