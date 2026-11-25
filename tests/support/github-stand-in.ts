/**
 * A stand-in for GitHub, for tests and journeys (docs/DEVELOPING.md, "Real
 * tests": GitHub is outside the machine). Its repositories are real git
 * repositories on disk, which a fetch reads `refs/pull/<number>/head` and
 * branches from, as it would from GitHub; and a small HTTP server on a free
 * port of 127.0.0.1 answers the REST calls diff delver makes: one pull request,
 * a repository's open pull requests, and the repository itself. Its answers
 * name the repository's folder as its clone address, so a fetch never leaves
 * the machine. It records every request, so a test can check what was asked
 * and with which sign-in.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { GitHubAccess } from '#lib/server/sources/github/index.ts';
import { GITHUB_COM } from '#lib/core/github/github-host.tiny.ts';
import { parseGitHubToken } from '#lib/core/github/github-token.tiny.ts';
import { runGitText } from '#lib/server/git/run-git.ts';
import type { GitRepo } from './git-repo.ts';

/** One pull request, as the stand-in holds it. */
export interface StandInPull {
	readonly number: number;
	readonly title: string;
	readonly body?: string | null;
	/** `merged` is a closed pull request that was merged. */
	readonly state: 'open' | 'closed' | 'merged';
	readonly draft?: boolean;
	readonly author: string | null;
	/** Its branch in the repository; `refs/pull/<number>/head` follows it whenever the pull is set. */
	readonly head: string;
	readonly base: string;
	/** Seconds since 1970. */
	readonly updatedAt: number;
	/** The repository its branch comes from, when it is a fork's. */
	readonly fork?: string;
}

interface StandInRepository {
	readonly owner: string;
	readonly name: string;
	readonly repo: GitRepo;
	/** Shown only to a request with the token. */
	readonly private: boolean;
	readonly pulls: Map<number, StandInPull>;
}

/** A request the stand-in answered: its path and query, its sign-in and tag, if any, and its status. */
export interface StandInRequest {
	readonly path: string;
	readonly authorization: string | undefined;
	/** The tag it asked with (`If-None-Match`). */
	readonly ifNoneMatch: string | undefined;
	readonly status: number;
}

export interface GitHubStandIn {
	/** Where its API answers, with no slash at the end. */
	readonly apiBase: string;
	/**
	 * What diff delver is given to reach it: its address, `token` as the
	 * person's sign-in, and how long a fetch may take (a minute unless given).
	 */
	access(token?: string, options?: { readonly fetchSeconds?: number }): GitHubAccess;
	/** Serves `repo` as `owner/name` on github.com; `private` ones only to the token. */
	addRepository(owner: string, name: string, repo: GitRepo, options?: { private?: boolean }): void;
	/** Opens or changes a pull request, pointing `refs/pull/<number>/head` at its branch now. */
	setPull(owner: string, name: string, pull: StandInPull): Promise<void>;
	/**
	 * Answers every request with this status for now, such as 401 or 429, or
	 * undefined to answer again. A 429 or 403 says no requests are left, and,
	 * with `resetAt` (seconds since 1970), when they are reset, as GitHub does.
	 */
	refuseWith(status: number | undefined, options?: { readonly resetAt?: number }): void;
	/** The requests answered so far, oldest first. */
	readonly requests: readonly StandInRequest[];
	close(): Promise<void>;
}

/** The token the stand-in takes as a sign-in; any other is refused as expired. */
export const STAND_IN_TOKEN = 'stand-in-token';

function json(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {}
): void {
	response.writeHead(status, { 'content-type': 'application/json', ...headers });
	response.end(JSON.stringify(body));
}

async function commitOf(repo: GitRepo, ref: string): Promise<string> {
	const found = await runGitText({
		cwd: repo.dir,
		args: ['rev-parse', '--verify', `${ref}^{commit}`]
	});
	if (!found.ok) throw new Error(`The stand-in has no ${ref}`);
	return found.value;
}

async function pullJson(repository: StandInRepository, pull: StandInPull): Promise<unknown> {
	const fullName = `${repository.owner}/${repository.name}`;
	return {
		number: pull.number,
		title: pull.title,
		body: pull.body ?? null,
		state: pull.state === 'open' ? 'open' : 'closed',
		merged_at: pull.state === 'merged' ? new Date(pull.updatedAt * 1000).toISOString() : null,
		draft: pull.draft ?? false,
		user: pull.author === null ? null : { login: pull.author },
		updated_at: new Date(pull.updatedAt * 1000).toISOString(),
		head: {
			sha: await commitOf(repository.repo, `refs/pull/${String(pull.number)}/head`),
			ref: pull.head,
			repo: { full_name: pull.fork ?? fullName }
		},
		base: {
			sha: await commitOf(repository.repo, `refs/heads/${pull.base}`),
			ref: pull.base,
			repo: { full_name: fullName, clone_url: repository.repo.dir }
		}
	};
}

/** The tag of an answer, as GitHub makes one: weak, from what it says. */
function etagOf(body: unknown): string {
	return `W/"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}"`;
}

export async function startGitHubStandIn(): Promise<GitHubStandIn> {
	const repositories = new Map<string, StandInRepository>();
	const requests: StandInRequest[] = [];
	let refusing: { readonly status: number; readonly resetAt: number | undefined } | undefined;
	const key = (owner: string, name: string): string => `${owner}/${name}`.toLowerCase();

	const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? '/', 'http://stand-in');
		const authorization = request.headers.authorization;
		const ifNoneMatch = request.headers['if-none-match'];
		response.on('finish', () => {
			requests.push({
				path: `${url.pathname}${url.search}`,
				authorization,
				ifNoneMatch,
				status: response.statusCode
			});
		});
		if (refusing !== undefined) {
			const { status, resetAt } = refusing;
			const limited = status === 429 || status === 403;
			json(
				response,
				status,
				{ message: 'refused' },
				{
					...(limited ? { 'x-ratelimit-remaining': '0' } : {}),
					...(limited && resetAt !== undefined ? { 'x-ratelimit-reset': String(resetAt) } : {})
				}
			);
			return;
		}
		const signedIn = authorization === `Bearer ${STAND_IN_TOKEN}`;
		if (authorization !== undefined && !signedIn) {
			json(response, 401, { message: 'Bad credentials' });
			return;
		}
		const match = /^\/repos\/([^/]+)\/([^/]+)(\/pulls(?:\/(\d+))?)?$/.exec(url.pathname);
		const repository =
			match === null ? undefined : repositories.get(key(match[1] ?? '', match[2] ?? ''));
		if (match === null || repository === undefined || (repository.private && !signedIn)) {
			json(response, 404, { message: 'Not Found' });
			return;
		}
		if (match[3] === undefined) {
			json(response, 200, {
				full_name: `${repository.owner}/${repository.name}`,
				private: repository.private
			});
			return;
		}
		if (match[4] !== undefined) {
			const pull = repository.pulls.get(Number(match[4]));
			if (pull === undefined) {
				json(response, 404, { message: 'Not Found' });
				return;
			}
			const body = await pullJson(repository, pull);
			const etag = etagOf(body);
			if (ifNoneMatch === etag) {
				response.writeHead(304, { etag });
				response.end();
			} else json(response, 200, body, { etag });
			return;
		}
		const open = [...repository.pulls.values()]
			.filter((pull) => pull.state === 'open')
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const perPage = Number(url.searchParams.get('per_page') ?? '30');
		const shown = open.slice(0, perPage);
		const more = open.length > shown.length;
		json(
			response,
			200,
			await Promise.all(shown.map((pull) => pullJson(repository, pull))),
			more ? { link: '<http://stand-in/next>; rel="next"' } : {}
		);
	};

	const server: Server = createServer((request, response) => {
		answer(request, response).catch((error: unknown) => {
			json(response, 500, { message: String(error) });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('The stand-in has no port');
	const { port } = address;
	const apiBase = `http://127.0.0.1:${String(port)}`;

	return {
		apiBase,
		access(token, options = {}) {
			const parsed = token === undefined ? undefined : parseGitHubToken(token);
			if (parsed !== undefined && !parsed.ok) throw new Error('not a token');
			return {
				apiBase: (host) => {
					if (host !== GITHUB_COM) throw new Error(`The stand-in is github.com only, not ${host}`);
					return apiBase;
				},
				token: () => Promise.resolve(parsed?.value),
				seconds: 10,
				fetchSeconds: options.fetchSeconds ?? 60
			};
		},
		addRepository(owner, name, repo, options = {}) {
			repositories.set(key(owner, name), {
				owner,
				name,
				repo,
				private: options.private ?? false,
				pulls: new Map()
			});
		},
		async setPull(owner, name, pull) {
			const repository = repositories.get(key(owner, name));
			if (repository === undefined) throw new Error(`The stand-in has no ${owner}/${name}`);
			await repository.repo.git(
				'update-ref',
				`refs/pull/${String(pull.number)}/head`,
				`refs/heads/${pull.head}`
			);
			repository.pulls.set(pull.number, pull);
		},
		refuseWith(status, options = {}) {
			refusing = status === undefined ? undefined : { status, resetAt: options.resetAt };
		},
		requests,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		}
	};
}
