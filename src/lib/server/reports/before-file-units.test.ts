/**
 * A data folder written by the diff delver from before a file with lines could
 * also have a file-level unit (`fixtures/before-file-units/`, made by
 * `pnpm fixtures:old-database` with that code). It stored a renamed, moved or
 * newly executable file's lines only, and counted progress without the change
 * to its name or mode. Today's code must give such a unit what a first version
 * would, and every place that shows progress the same numbers.
 */
import { cp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import { fileAssignment } from '#lib/core/diff/state.ts';
import { fileUnitInSet } from '#lib/core/diff/unit-set.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import { diffSizeOf, NO_BINARY_FILES } from '#lib/core/reports/diff-size.ts';
import { unitProgressOf } from '#lib/core/review/progress.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { DATABASE_FILE } from '../db/index.ts';
import { ReportService, type LoadedReport, type ReportSummary } from './index.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'before-file-units');

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

/** A copy of the fixture's data folder, for this test alone. */
async function oldData(): Promise<AbsolutePath> {
	const data = await tempDirectory();
	await cp(FIXTURE, data, { recursive: true });
	return data;
}

async function serviceFor(data: AbsolutePath): Promise<ReportService> {
	return value(
		await ReportService.open({
			dataDirectory: data,
			clock: settableClock(at(1_800_000_000_000)),
			ids: sequentialIds('later-')
		})
	);
}

/** The progress each repository's report had as the old code stored it. */
function storedProgress(data: AbsolutePath): Record<string, unknown> {
	const raw = new DatabaseSync(join(data, DATABASE_FILE), { readOnly: true });
	const rows = raw
		.prepare(
			'SELECT r.repository_path AS name, v.counted_units AS counted, v.reviewed_units AS reviewed, v.ignored_units AS ignored, v.uncategorised_units AS uncategorised FROM revisions AS v JOIN reports AS r ON r.id = v.report_id'
		)
		.all();
	raw.close();
	return Object.fromEntries(
		rows.map(({ name, ...progress }) => [basename(String(name)), { ...progress }] as const)
	);
}

/** Every listed report with its page, checking that the list, the header and the body agree. */
async function everyReport(
	service: ReportService
): Promise<ReadonlyMap<string, { listed: ReportSummary; page: LoadedReport }>> {
	const reports = new Map<string, { listed: ReportSummary; page: LoadedReport }>();
	for (const listed of value(service.list())) {
		if (listed.kind !== 'report') throw new Error(`damaged: ${listed.problem}`);
		const page = value(await service.load(listed.id));
		expect(page.summary.progress).toEqual(listed.progress);
		expect(unitProgressOf(page.progress)).toEqual(listed.progress);
		// Its test lines and binary files, which the old code did not keep, are counted by now.
		expect(listed.size).toEqual(diffSizeOf(page.diff, page.state));
		expect(page.summary.size).toEqual(listed.size);
		expect(listed.binary).toEqual(NO_BINARY_FILES);
		reports.set(listed.repository, { listed, page });
	}
	return reports;
}

function fileUnit(page: LoadedReport, file: string) {
	const found = page.diff.byPath.get(path(file));
	if (found === undefined) throw new Error(file);
	return fileAssignment(page.state, found).file;
}

describe('a data folder written before files with lines had a file-level unit', () => {
	it('was stored by the old code without those units', async () => {
		expect(storedProgress(await oldData())).toEqual({
			'moved-lockfile': { counted: 0, reviewed: 0, ignored: 2, uncategorised: 0 },
			'renamed-and-executable': { counted: 4, reviewed: 0, ignored: 0, uncategorised: 4 },
			'renamed-and-executable-reviewed': { counted: 4, reviewed: 4, ignored: 0, uncategorised: 4 }
		});
	});

	it('gives each such unit what a first version would, and the same progress everywhere', async () => {
		const data = await oldData();
		const service = await serviceFor(data);
		const reports = await everyReport(service);

		// The moved lockfile's unit is ignored by the built-in rule, as its lines are.
		const lockfile = reports.get('moved-lockfile');
		expect(lockfile?.listed.progress).toEqual({
			counted: 0,
			reviewed: 0,
			ignored: 3,
			uncategorised: 0
		});
		expect(lockfile && fileUnit(lockfile.page, 'sub/pnpm-lock.yaml')?.bucket).toMatchObject({
			kind: 'ignored',
			by: { kind: 'rule' }
		});

		// A renamed file and a file made executable, both edited: their units are not sorted yet.
		const plain = reports.get('renamed-and-executable');
		expect(plain?.listed.progress).toEqual({
			counted: 6,
			reviewed: 0,
			ignored: 0,
			uncategorised: 6
		});
		for (const file of ['notes/b.txt', 'run.sh']) {
			expect(plain && fileUnit(plain.page, file)).toEqual({
				bucket: { kind: 'uncategorised' },
				role: 'code'
			});
		}

		// With every line marked reviewed, the two units are still to review: never shown as done.
		const reviewed = reports.get('renamed-and-executable-reviewed');
		expect(reviewed?.listed.progress).toEqual({
			counted: 6,
			reviewed: 4,
			ignored: 0,
			uncategorised: 6
		});
		for (const file of ['notes/b.txt', 'run.sh']) {
			expect(reviewed && fileUnitInSet(reviewed.page.reviewed, path(file))).toBe(false);
		}
		service.close();

		// Once done, it is stored: opening the folder again changes nothing.
		const stored = storedProgress(data);
		const again = await serviceFor(data);
		await everyReport(again);
		again.close();
		expect(storedProgress(data)).toEqual(stored);
	});
});
