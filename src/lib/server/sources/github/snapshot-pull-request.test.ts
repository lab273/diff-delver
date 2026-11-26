/**
 * How the person's token reaches git's fetch of a pull request: only in git's
 * environment, as a header for GitHub's own address, and never in its
 * arguments, where any other user of the computer could read it.
 */
import { describe, expect, it } from 'vitest';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { parseGitHubBranchName } from '#lib/core/github/github-branch-name.tiny.ts';
import { GITHUB_COM } from '#lib/core/github/github-host.tiny.ts';
import { parseGitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { parsePullRequestUrl } from '#lib/core/github/pull-request.ts';
import { pullRequestTitleOf } from '#lib/core/github/pull-request-title.tiny.ts';
import { emptyRepo } from '../../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { locateRepository, type LocalRepository } from '../git/index.ts';
import type { PullRequestDetails } from './github-api.ts';
import { fetchArguments, fetchEnvironment } from './snapshot-pull-request.ts';

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

async function repository(): Promise<LocalRepository> {
	const repo = await emptyRepo();
	return value(await locateRepository(repo.dir));
}

describe('the fetch of a pull request', () => {
	it('gives git the token as a header for GitHub’s address, in its environment only', async () => {
		const repo = await repository();
		const address = 'https://github.com/acme/shop.git';
		const env = fetchEnvironment(repo, address, GITHUB_COM, TOKEN);
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

	it('gives no header for any other address, nor without a token', async () => {
		const repo = await repository();
		for (const address of [
			'/srv/git/shop.git',
			'http://github.com/acme/shop.git',
			'https://github.com.example/acme/shop.git',
			'https://example.com/https://github.com/acme/shop.git'
		]) {
			const env = fetchEnvironment(repo, address, GITHUB_COM, TOKEN);
			expect(env.GIT_CONFIG_COUNT).toBeUndefined();
			expect(JSON.stringify(env)).not.toContain(BASIC);
		}
		const signedOut = fetchEnvironment(
			repo,
			'https://github.com/acme/shop.git',
			GITHUB_COM,
			undefined
		);
		expect(signedOut.GIT_CONFIG_COUNT).toBeUndefined();
		expect(signedOut.GIT_TERMINAL_PROMPT).toBe('0');
	});
});
