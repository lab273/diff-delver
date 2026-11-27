/**
 * What each Delve takes on disk (DESIGN 9.1), measured from a real store: two
 * Delves of one repository share what both reach, a Delve's own figure grows
 * when an update adds what only it has, deleting one makes what it shared the
 * other's own, the Storage page's figures are the store's and the
 * database's sizes as measured, and measuring waits a minute after a change
 * and stops when asked.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import type { DelveDiskUsage } from '#lib/core/disk-usage/delve-sizes.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { GRACE_PERIOD } from '#lib/server/store/index.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { MEASURE_AFTER_MS } from './disk-usage.ts';
import { ReportService, type OpenOutcome } from './index.ts';

const KB = 1024;

/** Text that does not compress, so its size on disk is about its length: `kb` kilobytes of it. */
function incompressible(seed: string, kb: number): string {
	let text = '';
	for (let i = 0; text.length < kb * KB; i += 1) {
		text += createHash('sha256')
			.update(`${seed} ${String(i)}`)
			.digest('base64');
	}
	return text.slice(0, kb * KB);
}

function created(outcome: OpenOutcome): ReportId {
	if (outcome.kind !== 'created') throw new Error(`expected a new report, got ${outcome.kind}`);
	return outcome.report.id;
}

/** The Delve's figures as the list gives them, or undefined while it has none. */
function listed(service: ReportService, id: ReportId): DelveDiskUsage | undefined {
	const found = value(service.list()).find((r) => r.kind === 'report' && r.id === id);
	return found?.kind === 'report' ? found.disk : undefined;
}

/** That `size` is `kb` kilobytes, give or take what git's trees and headers add. */
function about(size: number, kb: number): void {
	expect(size).toBeGreaterThanOrEqual(kb * KB * 0.7);
	expect(size).toBeLessThanOrEqual(kb * KB + 2 * KB);
}

describe('what each Delve takes on disk', () => {
	it('counts what two Delves share once each, and what only one reaches as its own', async () => {
		// a.txt in the first commit, c.txt in the second, b.txt not committed.
		const repo = await emptyRepo();
		await repo.write('a.txt', incompressible('a', 40));
		await repo.commit('first');
		await repo.write('c.txt', incompressible('c', 30));
		await repo.commit('second');
		await repo.write('b.txt', incompressible('b', 50));
		const data = await tempDirectory();
		const clock = settableClock(at(1_700_000_000_000));
		const service = value(
			await ReportService.open({
				dataDirectory: data,
				clock,
				ids: sequentialIds(),
				repository: { gitEnv: (await reviewer()).gitEnv }
			})
		);
		const uncommitted = created(
			value(await service.open(repo.dir, value(parseGitSourceSpec('working-tree'))))
		);
		const last = created(value(await service.open(repo.dir, value(parseGitSourceSpec('HEAD')))));

		// Nothing is said of a Delve's size until it has been measured.
		expect(listed(service, uncommitted)).toBeUndefined();
		expect(await service.measureDiskUsage()).toHaveLength(1);

		// The uncommitted changes reach a, b and c; the last commit a and c.
		const both = listed(service, uncommitted);
		const commit = listed(service, last);
		about(both?.own ?? 0, 50);
		about(both?.shared ?? 0, 70);
		expect(commit?.own ?? Infinity).toBeLessThan(KB);
		about(commit?.shared ?? 0, 70);
		expect(value(service.summary(uncommitted)).disk).toEqual(both);

		// Measured again only once something changed.
		expect(await service.measureDiskUsage()).toEqual([]);

		// An update adds a version that alone reaches d.txt.
		await repo.write('d.txt', incompressible('d', 20));
		value(await service.update(uncommitted));
		// Measured once the store has not changed for a while, and not before.
		expect(await service.measureDiskUsage()).toEqual([]);
		clock.advance(MEASURE_AFTER_MS);
		expect(await service.measureDiskUsage()).toHaveLength(1);
		about(listed(service, uncommitted)?.own ?? 0, 70);
		about(listed(service, uncommitted)?.shared ?? 0, 70);

		// Deleting the last commit's Delve leaves the other alone with a and c.
		value(await service.deleteReport(last));
		// What the collection at deleting kept is collected again once the grace period has passed.
		expect(value(await service.collectFreedStores())).toEqual([]);
		clock.advance(GRACE_PERIOD + 60_000);
		expect(value(await service.collectFreedStores())).toHaveLength(1);
		expect(value(await service.collectFreedStores())).toEqual([]);
		clock.advance(MEASURE_AFTER_MS);
		await service.measureDiskUsage();
		about(listed(service, uncommitted)?.own ?? 0, 140);
		expect(listed(service, uncommitted)?.shared).toBe(0);

		// The Storage page: the store's size and the database's as measured, with the Delve in it.
		const storage = value(service.storage());
		expect(storage.stores).toHaveLength(1);
		about(storage.stores[0]?.size?.onDisk ?? 0, 140);
		expect(storage.stores[0]?.size?.measuredAt).toBe(clock.now());
		expect(storage.stores[0]?.delves.map((d) => d.summary.id)).toEqual([uncommitted]);
		expect(storage.database?.onDisk ?? 0).toBeGreaterThan(0);

		// A daemon stopping stops measuring, and what it did not measure is measured next time.
		await repo.write('e.txt', incompressible('e', 5));
		value(await service.update(uncommitted));
		clock.advance(MEASURE_AFTER_MS);
		expect(await service.measureDiskUsage(AbortSignal.abort())).toEqual([]);
		expect(await service.measureDiskUsage()).toHaveLength(1);
		about(listed(service, uncommitted)?.own ?? 0, 145);
		service.close();
	});

	it('measures, when it first runs, every store with a Delve not measured yet', async () => {
		const repo = await emptyRepo();
		await repo.write('a.txt', incompressible('a', 10));
		await repo.commit('first');
		await repo.write('a.txt', incompressible('changed', 10));
		const data = await tempDirectory();
		const options = {
			dataDirectory: data,
			clock: settableClock(at(1_700_000_000_000)),
			ids: sequentialIds(),
			repository: { gitEnv: (await reviewer()).gitEnv }
		};
		const before = value(await ReportService.open(options));
		const id = created(
			value(await before.open(repo.dir, value(parseGitSourceSpec('working-tree'))))
		);
		before.close();

		// A daemon that starts later has no note of the change, only that the Delve has no figure.
		const after = value(await ReportService.open(options));
		expect(listed(after, id)).toBeUndefined();
		expect(await after.measureDiskUsage()).toHaveLength(1);
		about(listed(after, id)?.own ?? 0, 20);
		expect(await after.measureDiskUsage()).toEqual([]);
		after.close();
	});
});
