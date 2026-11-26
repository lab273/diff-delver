/**
 * How the person's token reaches git's fetch of a pull request: only in git's
 * environment, as a header for GitHub's own address, and never in its
 * arguments, where any other user of the computer could read it. And that the
 * refs the fetch makes are gone before it lets the store go.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryNameOf } from '#lib/core/repository-name.tiny.ts';
import type { Result } from '#lib/core/result.ts';
import { randomIds } from '#lib/server/system.ts';
import {
	collectGarbage,
	ensureStore,
	FETCHING_REFS,
	type StoreError
} from '#lib/server/store/index.ts';
import { runGitText } from '#lib/server/git/run-git.ts';
import { withStoreLock } from '#lib/server/store/store-lock.ts';
import { locateRepository } from '../git/index.ts';
import { tempDirectory } from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import {
	startGitHubStandIn,
	type GitHubStandIn
} from '../../../../../tests/support/github-stand-in.ts';
import {
	buildShopUpstream,
	cloneShop,
	DISCOUNT_PULL,
	serveShop,
	SHOP_NAME,
	SHOP_OWNER
} from '../../../../../tests/support/pull-request-fixture.ts';
import { at } from '../../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../../tests/support/reviewer-git.ts';
import type { GitHubAccess } from './github-access.ts';
import { readPullRequest } from './github-api.ts';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { parseGitHubBranchName } from '#lib/core/github/github-branch-name.tiny.ts';
import { GITHUB_COM } from '#lib/core/github/github-host.tiny.ts';
import { parseGitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { parsePullRequestUrl } from '#lib/core/github/pull-request.ts';
import { pullRequestTitleOf } from '#lib/core/github/pull-request-title.tiny.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import type { PullRequestDetails } from './github-api.ts';
import { fetchArguments, fetchEnvironment, snapshotPullRequest } from './snapshot-pull-request.ts';

const TOKEN = value(parseGitHubToken('ghp_standInTokenForTheseTests'));
const COMMIT = value(parseCommitId('0123456789abcdef0123456789abcdef01234567'));
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

const details: PullRequestDetails = {
	ref: value(parsePullRequestUrl('https://github.com/acme/shop/pull/7')),
	title: pullRequestTitleOf('Add a discount rate'),
	description: undefined,
	state: 'open',
	draft: false,
	author: undefined,
	head: { commit: COMMIT, branch: value(parseGitHubBranchName('discount')) },
	base: { commit: COMMIT, branch: value(parseGitHubBranchName('main')) }
};

describe('the fetch of a pull request', () => {
	it('gives git the token as a header for GitHub’s address, in its environment only', () => {
		const address = 'https://github.com/acme/shop.git';
		const env = fetchEnvironment(address, GITHUB_COM, TOKEN);
		expect(env).toMatchObject({
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
			GIT_TERMINAL_PROMPT: '0',
			GIT_ASKPASS: 'false'
		});
		const args = fetchArguments(details, address, 'refs/diff-delver/fetching/s_1/');
		expect(args).toContain(address);
		for (const arg of args) {
			expect(arg).not.toContain(TOKEN);
			expect(arg).not.toContain(BASIC);
		}
	});

	it('gives no header for any other address, nor without a token', () => {
		for (const address of [
			'/srv/git/shop.git',
			'http://github.com/acme/shop.git',
			'https://github.com.example/acme/shop.git',
			'https://example.com/https://github.com/acme/shop.git'
		]) {
			const env = fetchEnvironment(address, GITHUB_COM, TOKEN);
			expect(env.GIT_CONFIG_COUNT).toBeUndefined();
			expect(JSON.stringify(env)).not.toContain(BASIC);
		}
		const signedOut = fetchEnvironment('https://github.com/acme/shop.git', GITHUB_COM, undefined);
		expect(signedOut.GIT_CONFIG_COUNT).toBeUndefined();
		expect(signedOut.GIT_TERMINAL_PROMPT).toBe('0');
	});
});

const standIns: GitHubStandIn[] = [];
afterEach(async () => {
	await Promise.all(standIns.splice(0).map((s) => s.close()));
});

describe('the refs of a pull request’s fetch', () => {
	it('are gone before a collection waiting for the store can run', async () => {
		const upstream = await GitRepo.init(absolutePath(join(await tempDirectory(), 'upstream')));
		await buildShopUpstream(upstream);
		const github = await startGitHubStandIn();
		standIns.push(github);
		await serveShop(github, upstream);
		const clone = await cloneShop(upstream, join(await tempDirectory(), 'shop'));
		// A commit the clone lacks, whose parent is only in the clone, which the
		// store borrows only while it fetches: a collection could not walk it.
		await upstream.git('checkout', '--quiet', 'discount');
		await upstream.write('more.txt', 'more\n');
		await upstream.commit('More');
		await upstream.git('checkout', '--quiet', 'main');
		await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);

		const data = await tempDirectory();
		const repo = value(await locateRepository(clone.dir, { gitEnv: (await reviewer()).gitEnv }));
		const store = value(
			await ensureStore(data, repo.storeId, repo.objectFormat, repositoryNameOf(repo.commonDir))
		);
		const stand = github.access();
		const read = value((await readPullRequest(stand, details.ref, at(1_700_000_000_000))).read);
		if (read.kind !== 'read') throw new Error('expected the pull request');
		// Asked for the token while the fetch holds the store: whatever asks for
		// the store alone waits, and is the first to have it when the fetch is done.
		let found: Promise<string> | undefined;
		let collecting: Promise<Result<void, StoreError>> | undefined;
		const access: GitHubAccess = {
			...stand,
			token: (host) => {
				found ??= withStoreLock(store.dir, 'exclusive', async () =>
					value(
						await runGitText({
							cwd: store.dir,
							args: ['for-each-ref', '--format=%(refname)', FETCHING_REFS]
						})
					)
				);
				collecting ??= collectGarbage(store);
				return stand.token(host);
			}
		};
		value(
			await snapshotPullRequest(
				data,
				repo,
				repo.storeId,
				read.details,
				access,
				randomIds.snapshotId()
			)
		);
		if (found === undefined || collecting === undefined) {
			throw new Error('the fetch never asked for the token');
		}
		expect(await found).toBe('');
		value(await collecting);
	});
});
