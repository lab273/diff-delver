/**
 * How diff delver reaches GitHub: the API's address for a host, and the
 * person's sign-in, if they have one (DESIGN 3.1: "Auth comes from `gh` or
 * `GITHUB_TOKEN`"). The daemon uses `machineGitHubAccess`; tests give a
 * stand-in's address and a token of their own, so no test reaches GitHub.
 *
 * The token is asked for each time it is needed, so signing in or out needs
 * no restart, and is never kept anywhere: it goes only into the header of a
 * request to GitHub (`github-api.ts`) and into git's environment for a fetch
 * from it (`snapshot-pull-request.ts`), never onto a command line or into a log.
 */
import { spawn } from 'node:child_process';
import { GITHUB_COM, type GitHubHost } from '#lib/core/github/github-host.tiny.ts';
import { gitHubCloneAddress, type GitHubRepository } from '#lib/core/github/github-repository.ts';
import { parseGitHubToken, type GitHubToken } from '#lib/core/github/github-token.tiny.ts';

export interface GitHubAccess {
	/** The API's address for a host, with no slash at the end: `https://api.github.com`. */
	apiBase(host: GitHubHost): string;
	/**
	 * Where git fetches a repository from: GitHub's own address for it,
	 * `https://github.com/owner/name.git`, made from the repository and never
	 * taken from an answer of GitHub's. The stand-in gives its folder.
	 */
	gitAddress(repository: GitHubRepository): string;
	/** The person's token for a host, or undefined when they have none: public repositories still work. */
	token(host: GitHubHost): Promise<GitHubToken | undefined>;
	/** How long a request to the API may take. */
	readonly seconds: number;
	/** How long a download of a pull request's commits may take, which on a large repository is long. */
	readonly fetchSeconds: number;
}

/** How long GitHub has to answer a request. */
export const GITHUB_SECONDS = 30;

/** How long GitHub has to send a pull request's commits: ten minutes. */
export const GITHUB_FETCH_SECONDS = 600;

/** How long `gh auth token` has to answer. */
const GH_SECONDS = 5;

/** The API of a host: github.com's own; GitHub Enterprise would be `https://<host>/api/v3`. */
function apiOf(host: GitHubHost): string {
	return host === GITHUB_COM ? 'https://api.github.com' : `https://${host}/api/v3`;
}

/**
 * The token `gh auth token` gives for the host, when the GitHub command is
 * installed and signed in; undefined otherwise. It runs with no terminal and
 * its prompts off, and is stopped after a few seconds.
 */
function ghToken(host: GitHubHost): Promise<GitHubToken | undefined> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn('gh', ['auth', 'token', '--hostname', host], {
				stdio: ['ignore', 'pipe', 'ignore'],
				env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
				timeout: GH_SECONDS * 1000
			});
		} catch {
			resolve(undefined);
			return;
		}
		const out: Buffer[] = [];
		child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
		child.on('error', () => {
			resolve(undefined);
		});
		child.on('close', (code) => {
			const token = parseGitHubToken(Buffer.concat(out).toString('utf8').trim());
			resolve(code === 0 && token.ok ? token.value : undefined);
		});
	});
}

/** The token in `GITHUB_TOKEN`, when it is set to one. */
function environmentToken(): GitHubToken | undefined {
	const token = parseGitHubToken((process.env.GITHUB_TOKEN ?? '').trim());
	return token.ok ? token.value : undefined;
}

/** This machine's way to GitHub: its API, and `gh auth token`, else `GITHUB_TOKEN`. */
export function machineGitHubAccess(): GitHubAccess {
	return {
		apiBase: apiOf,
		gitAddress: gitHubCloneAddress,
		async token(host) {
			return (await ghToken(host)) ?? (host === GITHUB_COM ? environmentToken() : undefined);
		},
		seconds: GITHUB_SECONDS,
		fetchSeconds: GITHUB_FETCH_SECONDS
	};
}
