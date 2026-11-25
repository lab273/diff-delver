/**
 * The report service at the size the design promises: a report of 2,000 files
 * and 200,000 changed lines is created, loaded, assigned to and ticked, from a
 * real repository through the real store and a real database, then updated to
 * a commit that moves every line of every file. Each step's time
 * is recorded against guidance, which `pnpm verify` reports when exceeded; the
 * database's size is checked against a bound, since a row per line instead of
 * per run would show there at once.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { measurementName } from '#lib/core/measurement-name.tiny.ts';
import { millisecondsOf } from '#lib/core/milliseconds.tiny.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { tempDirectory, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { FILES, largeChange } from '../../../../tests/support/large-change.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { recordTime, type MeasuredTask } from '../../../../tests/support/measured-time.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { now } from '../../../../tests/support/stopwatch.ts';
import { DATABASE_FILE } from '../db/index.ts';
import { ReportService } from './index.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';

/** The first version of a diff, which changes are made on until it is updated. */
const FIRST = value(parseRevisionNumber(1));

async function measure<T>(
	task: MeasuredTask,
	what: string,
	guidance: number,
	work: () => Promise<T>
): Promise<T> {
	const started = now();
	const result = await work();
	recordTime(
		task,
		measurementName(what),
		millisecondsOf(now() - started),
		millisecondsOf(guidance)
	);
	return result;
}

describe('the report service at full scale', () => {
	it('creates, loads, assigns to, ticks and updates a report of 2,000 files and 200,000 changed lines', async ({
		task
	}) => {
		const repo = await useFixture(largeChange);
		const who = await reviewer();
		const data = await tempDirectory();
		const clock = settableClock(at(0));
		const open = async (prefix: string) =>
			value(
				await ReportService.open({
					dataDirectory: data,
					clock,
					ids: sequentialIds(prefix),
					repository: { gitEnv: who.gitEnv }
				})
			);
		const service = await open('');

		const opened = await measure(task, 'creating a report of 2,000 files', 2_000, async () =>
			value(await service.open(repo.dir, value(parseGitSourceSpec('base...HEAD'))))
		);
		if (opened.kind !== 'created') throw new Error(opened.kind);
		const id = opened.report.id;
		expect(opened.report.size).toEqual({
			files: FILES,
			addedLines: 100_000,
			deletedLines: 100_000,
			testLines: { added: 0, removed: 0 }
		});
		service.close();

		// A fresh service, so the diff is read from the store and not from memory.
		const later = await open('b');
		const page = await measure(task, 'loading a report of 2,000 files', 1_000, async () =>
			value(await later.load(id))
		);
		expect(page.diff.unitCount).toBe(200_000);

		value(
			await later.upsertSections(id, FIRST, [
				{ id: 'first', title: 'First half' },
				{ id: 'second', title: 'Second half' }
			])
		);
		const assigned = await measure(task, 'one assign call over 1,000 files', 500, async () =>
			value(
				await later.assign(id, FIRST, [
					...Array.from({ length: 10 }, (_, i) => ({
						glob: `src/module-${String(i).padStart(2, '0')}/**`,
						section: 'first'
					})),
					{ file: 'src/module-19/file-1999.ts', lines: '+10..+20,-30..-40', section: 'second' }
				])
			)
		);
		expect(assigned.rejected).toEqual([]);
		expect(assigned.uncategorised).toBe(100_000 - 22);

		const first = value(parseSectionId('first'));
		const { sorting } = value(await later.load(id));
		const ticked = await measure(task, 'one tick', 250, async () =>
			value(
				await later.markReviewed(
					id,
					FIRST,
					{
						kind: 'slice',
						group: { kind: 'section', section: first },
						path: value(parseRepoPath('src/module-00/file-0000.ts'))
					},
					true,
					'sections',
					sorting
				)
			)
		);
		expect(ticked.units).toBe(100);

		// The branch moves on to a commit that adds a line at the top of every file.
		await repo.git('reset', '--quiet', '--soft', 'next');
		const updated = await measure(task, 'updating a report of 2,000 files', 3_000, async () =>
			value(await later.update(id))
		);
		if (updated.kind !== 'updated') throw new Error(updated.kind);
		expect(updated.summary).toMatchObject({
			filesChanged: FILES,
			newToReview: FILES,
			gone: 0,
			reviewedBefore: 100,
			// The ticked file's lines within three of the new top line need another look.
			reviewedKept: 94
		});
		later.close();

		const file = join(data, DATABASE_FILE);
		const bytes =
			(await stat(file)).size + (await stat(`${file}-wal`).catch(() => ({ size: 0 }))).size;
		// A row per run of lines: a few per file. A row per line would be tens of megabytes.
		expect(bytes).toBeLessThan(4 * 1024 * 1024);
	});
});
