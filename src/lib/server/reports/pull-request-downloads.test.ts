/**
 * What following a pull request downloads (DESIGN 3.1): the store keeps each
 * download for its pull request, so an update asks GitHub only for what is
 * new, from a clone that was not fetched again and from a blobless or shallow
 * one, whose history is never borrowed. Counted as the objects in the packs
 * the stand-in sent, which the store keeps as they came.
 */
import { open as openFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { parseSourceSpec } from '#lib/core/sources/source-spec.ts';
import { runGit } from '#lib/server/git/run-git.ts';
import { GRACE_PERIOD } from '#lib/server/store/index.ts';
import { partialClone } from '../../../../tests/support/partial-clone.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import {
	startGitHubStandIn,
	type GitHubStandIn
} from '../../../../tests/support/github-stand-in.ts';
import {
	buildShopUpstream,
	cloneShop,
	DISCOUNT_PULL,
	serveShop,
	SHOP_NAME,
	SHOP_OWNER,
	SHOP_REMOTE
} from '../../../../tests/support/pull-request-fixture.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { ReportService, type OpenOutcome } from './index.ts';

const DISCOUNT = value(parseSourceSpec('https://github.com/acme/shop/pull/7'));

const standIns: GitHubStandIn[] = [];
afterEach(async () => {
	await Promise.all(standIns.splice(0).map((s) => s.close()));
});

function created(outcome: OpenOutcome): ReportId {
	if (outcome.kind !== 'created') throw new Error(`expected a new report, got ${outcome.kind}`);
	return outcome.report.id;
}

/** A service on its own data folder that reaches the stand-in. */
async function serviceFor(github: GitHubStandIn): Promise<{
	service: ReportService;
	data: AbsolutePath;
}> {
	const data = absolutePath(join(await tempDirectory(), 'data'));
	const who = await reviewer();
	const service = value(
		await ReportService.open({
			dataDirectory: data,
			clock: settableClock(at(1_700_000_100_000)),
			ids: sequentialIds(),
			repository: { gitEnv: who.gitEnv },
			github: github.access()
		})
	);
	return { service, data };
}

/** The shop served as acme/shop, with pull request #7 open. */
async function shop(): Promise<{ upstream: GitRepo; github: GitHubStandIn }> {
	const upstream = await GitRepo.init(absolutePath(join(await tempDirectory(), 'upstream')));
	await buildShopUpstream(upstream);
	const github = await startGitHubStandIn();
	standIns.push(github);
	await serveShop(github, upstream);
	return { upstream, github };
}

/** A commit on `branch` of `repo` that writes `count` files under `folder`. */
async function commitFiles(
	repo: GitRepo,
	branch: string,
	folder: string,
	count: number
): Promise<void> {
	await repo.git('checkout', '--quiet', branch);
	for (let i = 0; i < count; i += 1) {
		await repo.write(`${folder}/${String(i)}.txt`, `${folder} ${String(i)}\n`);
	}
	await repo.commit(`Add ${String(count)} files to ${folder}`);
}

/**
 * Every kept download of every store in the data folder: its `.keep` file and
 * how many objects its pack has. A `.keep` file with no pack is left out.
 */
async function downloads(data: AbsolutePath): Promise<Map<string, number>> {
	const found = new Map<string, number>();
	const stores = join(data, 'stores');
	for (const store of await readdir(stores)) {
		const packs = join(stores, store, 'objects', 'pack');
		for (const name of await readdir(packs)) {
			if (!name.endsWith('.keep')) continue;
			const idx = join(packs, `${name.slice(0, -'.keep'.length)}.idx`);
			const file = await openFile(idx, 'r').catch(() => undefined);
			if (file === undefined) continue;
			const count = Buffer.alloc(4);
			await file.read(count, 0, 4, 8 + 255 * 4);
			await file.close();
			found.set(join(packs, name), count.readUInt32BE(0));
		}
	}
	return found;
}

/** How many objects were downloaded while `work` ran. */
async function downloadedBy(data: AbsolutePath, work: () => Promise<unknown>): Promise<number> {
	const before = await downloads(data).catch(() => new Map<string, number>());
	await work();
	let total = 0;
	for (const [file, count] of await downloads(data)) if (!before.has(file)) total += count;
	return total;
}

/** The only store in the data folder. */
async function onlyStore(data: AbsolutePath): Promise<AbsolutePath> {
	const [store, ...others] = await readdir(join(data, 'stores'));
	if (store === undefined || others.length > 0) throw new Error('expected one store');
	return absolutePath(join(data, 'stores', store));
}

/** Whether the store alone, borrowing nothing, has the object. */
async function storeHas(store: AbsolutePath, object: string): Promise<boolean> {
	return (await runGit({ cwd: store, args: ['cat-file', '-e', object] })).ok;
}

async function headOf(repo: GitRepo, ref: string): Promise<string> {
	return (await repo.snapshot(ref)).commit;
}

describe('the downloads of a pull request', () => {
	it('are kept, so an update from a clone that was not fetched again downloads only what is new', async () => {
		const { upstream, github } = await shop();
		const clone = await cloneShop(upstream, join(await tempDirectory(), 'shop'));
		// What the clone never fetched: a commit on the base and one on the pull request.
		await commitFiles(upstream, 'main', 'base', 40);
		await commitFiles(upstream, 'discount', 'gap', 40);
		await upstream.git('checkout', '--quiet', 'main');
		await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		const { service, data } = await serviceFor(github);

		let id: ReportId | undefined;
		const opening = await downloadedBy(data, async () => {
			id = created(value(await service.open(clone.dir, DISCOUNT)));
		});
		expect(opening).toBeGreaterThanOrEqual(2 * 40);
		if (id === undefined) throw new Error('not opened');

		// One small commit pushed: its commit, two trees and a file, and maybe an
		// object its changes are written against, which git adds to complete the pack.
		await commitFiles(upstream, 'discount', 'gap', 41);
		await upstream.git('checkout', '--quiet', 'main');
		await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		const reportId = id;
		const updating = await downloadedBy(data, async () => {
			expect(value(await service.update(reportId))).toMatchObject({ kind: 'updated' });
		});
		expect(updating).toBeLessThanOrEqual(5);
	});

	it('download a blobless or a shallow clone’s history once, and then only what is new', async () => {
		for (const kind of ['blobless', 'shallow'] as const) {
			const github = await startGitHubStandIn();
			standIns.push(github);
			const { server, clone } = await partialClone('blob:none');
			const used =
				kind === 'blobless'
					? clone
					: await (async () => {
							const dir = absolutePath(join(await tempDirectory(), 'shallow'));
							await server.git(
								'clone',
								'--quiet',
								'--depth=1',
								'--branch=feat',
								`file://${server.dir}`,
								dir
							);
							return GitRepo.open(dir);
						})();
			await used.git('remote', 'set-url', 'origin', SHOP_REMOTE);
			github.addRepository(SHOP_OWNER, SHOP_NAME, server);
			await github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, head: 'feat' });
			const { service, data } = await serviceFor(github);

			let id: ReportId | undefined;
			const opening = await downloadedBy(data, async () => {
				id = created(value(await service.open(used.dir, DISCOUNT)));
			});
			// Both commits, their trees and their files: the whole history.
			expect(opening).toBe(9);
			if (id === undefined) throw new Error('not opened');

			await commitFiles(server, 'feat', 'more', 1);
			await server.git('checkout', '--quiet', 'main');
			await github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, head: 'feat' });
			const reportId = id;
			const updating = await downloadedBy(data, async () => {
				expect(value(await service.update(reportId))).toMatchObject({ kind: 'updated' });
			});
			expect(updating).toBeLessThanOrEqual(5);
		}
	});

	it('are kept through garbage collection while their Delve is, and go with it', async () => {
		const { upstream, github } = await shop();
		const clone = await cloneShop(upstream, join(await tempDirectory(), 'shop'));
		await commitFiles(upstream, 'discount', 'gap', 3);
		await upstream.git('checkout', '--quiet', 'main');
		await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		const { service, data } = await serviceFor(github);
		const id = created(value(await service.open(clone.dir, DISCOUNT)));
		const store = await onlyStore(data);
		const head = await headOf(upstream, 'discount');
		const kept = [...(await downloads(data)).keys()];
		expect(kept).toHaveLength(1);
		expect(await storeHas(store, head)).toBe(true);

		// Long kept, and collected: the Delve still keeps them, and its commit.
		const long = (Date.now() - 2 * GRACE_PERIOD) / 1000;
		const packs = join(store, 'objects', 'pack');
		for (const name of await readdir(packs)) await utimes(join(packs, name), long, long);
		// One kept for a pull request with no Delve, long ago, and one a moment ago.
		const stray = join(packs, 'pack-stray.keep');
		const fresh = join(packs, 'pack-fresh.keep');
		await writeFile(stray, 'diff-delver pull request 0123\n');
		await utimes(stray, long, long);
		await writeFile(fresh, 'diff-delver pull request 4567\n');
		value(await service.tidyStores());
		expect([...(await downloads(data)).keys()]).toEqual(kept);
		expect(await readdir(packs)).toContain('pack-fresh.keep');
		expect(await readdir(packs)).not.toContain('pack-stray.keep');
		expect(await storeHas(store, head)).toBe(true);
		await rm(fresh);

		value(await service.deleteReport(id));
		expect((await readdir(packs)).filter((name) => name.endsWith('.keep'))).toEqual([]);
		expect(await storeHas(store, head)).toBe(false);
	});

	it('that cannot be used any more are forgotten, and what is needed is downloaded again', async () => {
		const { upstream, github } = await shop();
		// A clone made long ago, then the pull request moves on, then a newer clone.
		const older = await cloneShop(upstream, join(await tempDirectory(), 'shop'));
		await commitFiles(upstream, 'discount', 'one', 2);
		await upstream.git('checkout', '--quiet', 'main');
		const newer = await cloneShop(upstream, join(await tempDirectory(), 'shop'));
		await commitFiles(upstream, 'discount', 'two', 2);
		await upstream.git('checkout', '--quiet', 'main');
		await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		const { service, data } = await serviceFor(github);
		const id = created(value(await service.open(newer.dir, DISCOUNT)));

		// Kept on top of the newer clone's history, which only it has.
		await rm(newer.dir, { recursive: true, force: true });
		await commitFiles(upstream, 'discount', 'three', 2);
		await upstream.git('checkout', '--quiet', 'main');
		await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
		const before = await downloads(data);
		expect(value(await service.open(older.dir, DISCOUNT))).toMatchObject({
			kind: 'resumed',
			report: { id, revision: 2 }
		});
		const page = value(await service.load(id));
		expect(page.diff.files.map((f) => f.file.path)).toEqual([
			'one/0.txt',
			'one/1.txt',
			'src/discount.ts',
			'src/price.ts',
			'three/0.txt',
			'three/1.txt',
			'two/0.txt',
			'two/1.txt'
		]);
		const after = await downloads(data);
		expect([...after.keys()].filter((file) => before.has(file))).toEqual([]);
	});
});
