/**
 * GitHub pull requests through the real service (DESIGN 3.1, 6.1, 6.2), with
 * real repositories and the stand-in GitHub: listing them, opening one,
 * following it as commits are pushed, and what is said when GitHub refuses.
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock, type SettableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseRepoPath, type RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseSourceSpec, type SourceSpec } from '#lib/core/sources/source-spec.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import { partialClone } from '../../../../tests/support/partial-clone.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import {
	startGitHubStandIn,
	STAND_IN_TOKEN,
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
import {
	describeReportError,
	PULL_REQUEST_CHECK_EVERY_MS,
	PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS,
	ReportService,
	type OpenOutcome
} from './index.ts';

const FIRST = value(parseRevisionNumber(1));
const DISCOUNT = value(parseSourceSpec('https://github.com/acme/shop/pull/7'));
const RECEIPT = value(parseSourceSpec('https://github.com/acme/shop/pull/8'));

function path(text: string): RepoPath {
	return value(parseRepoPath(text));
}

function created(outcome: OpenOutcome): ReportId {
	if (outcome.kind !== 'created') throw new Error(`expected a new report, got ${outcome.kind}`);
	return outcome.report.id;
}

interface World {
	readonly upstream: GitRepo;
	readonly clone: GitRepo;
	readonly data: AbsolutePath;
	readonly github: GitHubStandIn;
	readonly clock: SettableClock;
	readonly service: ReportService;
}

const standIns: GitHubStandIn[] = [];
afterEach(async () => {
	await Promise.all(standIns.splice(0).map((s) => s.close()));
});

async function world(
	options: { private?: boolean; token?: string; fetchSeconds?: number } = {}
): Promise<World> {
	const root = await tempDirectory();
	const upstream = await GitRepo.init(absolutePath(join(root, 'upstream')));
	await buildShopUpstream(upstream);
	const clone = await cloneShop(upstream, join(root, 'shop'));
	const github = await startGitHubStandIn();
	standIns.push(github);
	await serveShop(github, upstream, options);
	const data = absolutePath(join(root, 'data'));
	const clock = settableClock(at(1_700_000_100_000));
	const who = await reviewer();
	const service = value(
		await ReportService.open({
			dataDirectory: data,
			clock,
			ids: sequentialIds(),
			repository: { gitEnv: who.gitEnv },
			github: github.access(
				options.token,
				options.fetchSeconds === undefined ? {} : { fetchSeconds: options.fetchSeconds }
			)
		})
	);
	return { upstream, clone, data, github, clock, service };
}

async function open(w: World, spec: SourceSpec = DISCOUNT): Promise<OpenOutcome> {
	return value(await w.service.open(w.clone.dir, spec));
}

/** The partial clone's server, and a clone of it with only `feat`'s newest commit. */
async function shallowClone(): Promise<{ server: GitRepo; clone: GitRepo }> {
	const { server } = await partialClone('blob:none');
	const dir = absolutePath(join(await tempDirectory(), 'shallow'));
	await server.git('clone', '--quiet', '--depth=1', '--branch=feat', `file://${server.dir}`, dir);
	return { server, clone: GitRepo.open(dir) };
}

/** Pushes a commit to the pull request's branch on the stand-in. */
async function push(w: World, file: string, text: string, message: string): Promise<void> {
	await w.upstream.git('checkout', '--quiet', 'discount');
	await w.upstream.write(file, text);
	await w.upstream.commit(message);
	await w.upstream.git('checkout', '--quiet', 'main');
	await w.github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
}

/** Every file under `dir`, read whole, as one text. */
async function everything(dir: string): Promise<string> {
	const names = await readdir(dir, { recursive: true, withFileTypes: true });
	const files = names.filter((n) => n.isFile()).map((n) => join(n.parentPath, n.name));
	return (await Promise.all(files.map((f) => readFile(f, 'latin1')))).join('\n');
}

describe('a GitHub pull request', () => {
	it('lists a clone’s open pull requests only when asked, and offers them from its remote offline', async () => {
		const w = await world();
		const history = value(await w.service.branches(w.clone.dir, ''));
		expect(history.gitHub).toEqual({
			remote: 'origin',
			repository: { host: 'github.com', owner: 'acme', name: 'shop' }
		});
		expect(w.github.requests).toEqual([]);
		const listed = value(await w.service.pullRequests(w.clone.dir));
		expect(listed.pulls.more).toBe(false);
		expect(
			listed.pulls.pulls.map((p) => [p.number, p.title, p.author, p.head, p.draft, p.fromFork])
		).toEqual([
			[7, 'Add a discount rate', 'octo', 'discount', false, false],
			[8, 'Print a receipt', 'hubot', 'receipt', true, true]
		]);
		expect(w.github.requests.map((r) => r.authorization)).toEqual([undefined]);
	});

	it('lists upstream’s pull requests in a clone of a fork, and opens a pull request of any remote', async () => {
		const w = await world();
		await w.clone.git('remote', 'set-url', 'origin', 'https://github.com/octo/shop.git');
		await w.clone.git('remote', 'add', 'upstream', SHOP_REMOTE);
		expect(value(await w.service.branches(w.clone.dir, '')).gitHub).toEqual({
			remote: 'upstream',
			repository: { host: 'github.com', owner: 'acme', name: 'shop' }
		});
		const listed = value(await w.service.pullRequests(w.clone.dir));
		expect(listed.remote).toBe('upstream');
		expect(listed.pulls.pulls.map((p) => p.number)).toEqual([7, 8]);

		// Named anything else, upstream's pull requests still open; origin's are the ones offered.
		await w.clone.git('remote', 'rename', 'upstream', 'acme');
		expect(value(await w.service.branches(w.clone.dir, '')).gitHub?.remote).toBe('origin');
		created(await open(w));
	});

	it('is not offered by a repository with no remote on GitHub', async () => {
		const w = await world();
		await w.clone.git('remote', 'set-url', 'origin', 'https://gitlab.com/acme/shop.git');
		expect(value(await w.service.branches(w.clone.dir, '')).gitHub).toBeUndefined();
		const listed = await w.service.pullRequests(w.clone.dir);
		expect(!listed.ok && listed.error.kind).toBe('NotOnGitHub');
		const opened = await w.service.open(w.clone.dir, DISCOUNT);
		expect(!opened.ok && opened.error.kind).toBe('NotACloneOf');
		if (!opened.ok)
			expect(describeReportError(opened.error)).toContain('none of its remotes is on GitHub');
		expect(w.github.requests).toEqual([]);
	});

	it('opens as a Delve of its changes against the merge base, writing nothing to the clone, and resumes', async () => {
		const w = await world();
		const { before, after, result } = await listingsAround([w.clone.dir], () => open(w));
		expect(after).toEqual(before);
		const id = created(result);
		const page = value(await w.service.load(id));
		expect(page.summary.title).toBe('Pull request #7: “Add a discount rate”');
		expect(page.report.source).toMatchObject({ kind: 'github', title: 'Add a discount rate' });
		expect(page.diff.files.map((f) => f.file.path)).toEqual(['src/discount.ts', 'src/price.ts']);
		expect(page.revision.headCommit).toBe((await w.upstream.snapshot('discount')).commit);
		expect(page.revision.baseCommit).toBe((await w.upstream.snapshot('main')).commit);

		const again = await open(
			w,
			value(parseSourceSpec('https://github.com/ACME/Shop/pull/7/files'))
		);
		expect(again).toMatchObject({ kind: 'resumed', update: undefined });
	});

	it('becomes the next version when a commit is pushed, keeping ticks on what did not change', async () => {
		const w = await world();
		const id = created(await open(w));
		value(
			await w.service.markReviewed(id, FIRST, { kind: 'file', path: path('src/discount.ts') }, true)
		);
		// A commit the clone has never seen: only GitHub has it.
		await push(w, 'src/coupon.ts', 'export const COUPON = 10;\n', 'Add a coupon');

		// A page's check asks GitHub at most every five minutes when signed out.
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		w.clock.advance(PULL_REQUEST_CHECK_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		w.clock.advance(PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS - PULL_REQUEST_CHECK_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'changed', files: 1 });
		const updated = value(await w.service.update(id));
		if (updated.kind !== 'updated') throw new Error(updated.kind);
		expect(updated.report.revision).toBe(2);
		expect(updated.summary.filesChanged).toBe(1);
		const page = value(await w.service.load(id));
		expect(page.diff.files.map((f) => f.file.path)).toEqual([
			'src/coupon.ts',
			'src/discount.ts',
			'src/price.ts'
		]);
		expect(page.progress.overall.reviewedUnits).toBe(4);
		expect(updated.summary.reviewedKept).toBe(4);
	});

	it('keeps its sorting and ticks when opened from a second clone, and moves there when the first is gone', async () => {
		const w = await world();
		const second = await cloneShop(w.upstream, join(await tempDirectory(), 'shop'));
		const id = created(await open(w));
		value(await w.service.upsertSections(id, FIRST, [{ id: 'rate', title: 'The rate' }]));
		value(await w.service.assign(id, FIRST, [{ file: 'src/discount.ts', section: 'rate' }]));
		value(
			await w.service.markReviewed(id, FIRST, { kind: 'file', path: path('src/discount.ts') }, true)
		);
		const kept = async (revision: number): Promise<void> => {
			const page = value(await w.service.load(id));
			expect(page.revision.number).toBe(revision);
			expect(page.sections.map((s) => s.id)).toEqual(['rate']);
			expect(page.progress.overall.reviewedUnits).toBe(4);
		};

		// The second clone resumes it, updated through the first, whose store it is in.
		await push(w, 'src/coupon.ts', 'export const COUPON = 10;\n', 'Add a coupon');
		const resumed = value(await w.service.open(second.dir, DISCOUNT));
		expect(resumed).toMatchObject({ kind: 'resumed', report: { id, revision: 2 } });
		await kept(2);
		expect(value(await w.service.load(id)).summary.repositoryPath).toBe(w.clone.dir);
		w.clock.advance(PULL_REQUEST_CHECK_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'unchanged' });

		// And the first again.
		await push(w, 'src/coupon.ts', 'export const COUPON = 20;\n', 'A larger coupon');
		expect(await open(w)).toMatchObject({ kind: 'resumed', report: { id, revision: 3 } });
		await kept(3);

		// With the first gone, the second takes over, keeping everything.
		await rm(w.clone.dir, { recursive: true, force: true });
		await push(w, 'src/coupon.ts', 'export const COUPON = 30;\n', 'A larger coupon still');
		expect(value(await w.service.open(second.dir, DISCOUNT))).toMatchObject({
			kind: 'resumed',
			report: { id, revision: 4 }
		});
		await kept(4);
		expect(value(await w.service.load(id)).summary.repositoryPath).toBe(second.dir);
		w.clock.advance(PULL_REQUEST_CHECK_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
	});

	it('follows a force-push, and running it again counts as asking', async () => {
		const w = await world();
		const id = created(await open(w));
		await w.upstream.git('checkout', '--quiet', 'discount');
		await w.upstream.git('reset', '--quiet', '--hard', 'main');
		await w.upstream.write('src/discount.ts', 'export const RATE = 0.1;\n');
		await w.upstream.commit('Start again');
		await w.upstream.git('checkout', '--quiet', 'main');
		await w.github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, title: 'A flat rate' });
		const again = await open(w);
		expect(again).toMatchObject({ kind: 'resumed', report: { id, revision: 2 } });
		const page = value(await w.service.load(id));
		expect(page.diff.files.map((f) => f.file.path)).toEqual(['src/discount.ts']);
		expect(page.summary.title).toBe('Pull request #7: “A flat rate”');
	});

	it('has nothing left to review once merged or closed, and says so', async () => {
		const w = await world();
		const id = created(await open(w));
		await w.github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, state: 'merged' });
		w.clock.advance(PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({
			kind: 'nothing-left',
			reason:
				'Nothing is left to review here: pull request #7 has been merged. What you were reading is still shown.',
			next: undefined
		});
		expect(await open(w)).toMatchObject({ kind: 'nothing-to-review', closed: id });

		await w.github.setPull(SHOP_OWNER, SHOP_NAME, { ...RECEIPT_CLOSED });
		const closed = await open(w, RECEIPT);
		expect(closed).toMatchObject({
			kind: 'nothing-to-review',
			source: 'Pull request #8: “Print a receipt”'
		});
	});

	it('says what to do when GitHub wants a sign-in, refuses one, or has had too many requests', async () => {
		const hidden = await world({ private: true });
		const needed = await hidden.service.open(hidden.clone.dir, DISCOUNT);
		expect(!needed.ok && needed.error.kind).toBe('GitHubSignInNeeded');
		if (!needed.ok) expect(describeReportError(needed.error)).toContain('gh auth login');

		const expired = await world({ private: true, token: 'an-old-token' });
		const refused = await expired.service.pullRequests(expired.clone.dir);
		expect(!refused.ok && refused.error.kind).toBe('GitHubSignInRefused');

		const busy = await world();
		busy.github.refuseWith(429);
		const limited = await busy.service.pullRequests(busy.clone.dir);
		expect(!limited.ok && limited.error).toMatchObject({
			kind: 'GitHubRateLimited',
			signedIn: false
		});

		const missing = await busy.service.open(
			busy.clone.dir,
			value(parseSourceSpec('https://github.com/acme/shop/pull/99'))
		);
		busy.github.refuseWith(undefined);
		expect(!missing.ok && missing.error.kind).toBe('GitHubRateLimited');
		// GitHub said not when to try again, so a minute is left.
		busy.clock.advance(60_000);
		const none = await busy.service.open(
			busy.clone.dir,
			value(parseSourceSpec('https://github.com/acme/shop/pull/99'))
		);
		expect(!none.ok && none.error.kind).toBe('PullRequestNotFound');
	});

	it('asks a page’s checks with the last answer’s tag, once a minute signed in', async () => {
		const w = await world({ token: STAND_IN_TOKEN });
		const id = created(await open(w));
		const asked = w.github.requests.length;
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		expect(w.github.requests.length).toBe(asked);
		w.clock.advance(PULL_REQUEST_CHECK_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		const [check, ...more] = w.github.requests.slice(asked);
		expect(more).toEqual([]);
		expect(check?.status).toBe(304);
		expect(check?.ifNoneMatch).toMatch(/^W\/"/);

		await push(w, 'src/coupon.ts', 'export const COUPON = 10;\n', 'Add a coupon');
		w.clock.advance(PULL_REQUEST_CHECK_EVERY_MS);
		expect(value(await w.service.checkForChanges(id))).toEqual({ kind: 'changed', files: 1 });
		expect(w.github.requests.at(-1)?.status).toBe(200);
	});

	it('keeps a refusal for a page’s checks, and asks again for a person unless told to wait', async () => {
		const w = await world();
		const id = created(await open(w));
		w.clock.advance(PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS);
		w.github.refuseWith(502);
		const count = (): number => w.github.requests.length;
		const failed = await w.service.checkForChanges(id);
		expect(!failed.ok && failed.error.kind).toBe('GitHubAnswerUnreadable');
		const asked = count();
		const again = await w.service.checkForChanges(id);
		expect(!again.ok && again.error.kind).toBe('GitHubAnswerUnreadable');
		expect(count()).toBe(asked);
		// Updating is the person asking, so GitHub is asked again.
		const updated = await w.service.update(id);
		expect(!updated.ok && updated.error.kind).toBe('GitHubAnswerUnreadable');
		expect(count()).toBe(asked + 1);

		// Too many requests: nobody asks again until GitHub said to.
		const resetAt = Math.floor(w.clock.now() / 1000) + 150;
		w.github.refuseWith(429, { resetAt });
		const limited = await w.service.update(id);
		expect(!limited.ok && limited.error).toMatchObject({
			kind: 'GitHubRateLimited',
			waitSeconds: 150
		});
		if (!limited.ok)
			expect(describeReportError(limited.error)).toContain('Try again in 3 minutes.');
		const limitedAt = count();
		w.github.refuseWith(undefined);
		w.clock.advance(90_000);
		const still = await w.service.update(id);
		expect(!still.ok && still.error).toMatchObject({ kind: 'GitHubRateLimited', waitSeconds: 60 });
		if (!still.ok) expect(describeReportError(still.error)).toContain('Try again in a minute.');
		const checked = await w.service.checkForChanges(id);
		expect(!checked.ok && checked.error.kind).toBe('GitHubRateLimited');
		expect(count()).toBe(limitedAt);
		w.clock.advance(60_000);
		expect(value(await w.service.update(id))).toMatchObject({ kind: 'unchanged' });
		expect(count()).toBe(limitedAt + 1);
	});

	it('downloads everything it needs into a blobless or a shallow clone’s store', async () => {
		for (const kind of ['blobless', 'shallow'] as const) {
			const github = await startGitHubStandIn();
			standIns.push(github);
			const { server, clone } =
				kind === 'blobless' ? await partialClone('blob:none') : await shallowClone();
			github.addRepository(SHOP_OWNER, SHOP_NAME, server);
			await github.setPull(SHOP_OWNER, SHOP_NAME, { ...DISCOUNT_PULL, head: 'feat' });
			await clone.git('remote', 'set-url', 'origin', SHOP_REMOTE);
			const who = await reviewer();
			const service = value(
				await ReportService.open({
					dataDirectory: absolutePath(join(await tempDirectory(), 'data')),
					clock: settableClock(at(1_700_000_100_000)),
					ids: sequentialIds(),
					repository: { gitEnv: who.gitEnv },
					github: github.access()
				})
			);
			const { before, after, result } = await listingsAround([clone.dir], async () =>
				value(await service.open(clone.dir, DISCOUNT))
			);
			expect(after).toEqual(before);
			const id = created(result);
			const page = value(await service.load(id));
			expect(page.diff.files.map((f) => f.file.path)).toEqual(['d/c.txt']);
			const lines = value(
				await service.readPart(id, FIRST, 'sections', { kind: 'uncategorised' }, path('d/c.txt'))
			);
			expect(JSON.stringify(lines)).toContain('line 101');
		}
	});

	it('stops a download of its commits that takes too long, by its own limit, and says so', async () => {
		const w = await world({ fetchSeconds: 0 });
		const opened = await w.service.open(w.clone.dir, DISCOUNT);
		expect(!opened.ok && opened.error).toMatchObject({
			kind: 'PullRequestFetchFailed',
			stoppedAfter: 0
		});
		if (!opened.ok) {
			expect(describeReportError(opened.error)).toContain(
				'commits from GitHub was stopped after 0 seconds, unfinished. A large repository can take longer: run "git fetch" in this clone first'
			);
		}
	});

	it('signs in with the person’s token, and keeps it nowhere', async () => {
		const w = await world({ private: true, token: STAND_IN_TOKEN });
		created(await open(w));
		expect(w.github.requests.every((r) => r.authorization === `Bearer ${STAND_IN_TOKEN}`)).toBe(
			true
		);
		expect(await everything(w.data)).not.toContain(STAND_IN_TOKEN);
	});

	it('is opened only from a clone of its repository', async () => {
		const w = await world();
		const other = value(parseSourceSpec('https://github.com/someone/else/pull/1'));
		const opened = await w.service.open(w.clone.dir, other);
		expect(!opened.ok && opened.error.kind).toBe('NotACloneOf');
		if (!opened.ok) {
			expect(describeReportError(opened.error)).toContain(
				'is a clone of acme/shop, not of someone/else'
			);
		}
		expect(w.github.requests).toEqual([]);
	});
});

const RECEIPT_CLOSED = {
	number: 8,
	title: 'Print a receipt',
	state: 'closed',
	author: 'hubot',
	head: 'receipt',
	base: 'main',
	updatedAt: 1_700_000_000
} as const;
