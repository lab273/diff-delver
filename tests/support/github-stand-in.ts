/**
 * A stand-in for GitHub, for tests and journeys (docs/DEVELOPING.md, "Real
 * tests": GitHub is outside the machine). Its repositories are real git
 * repositories on disk, which a fetch reads `refs/pull/<number>/head` and
 * branches from, as it would from GitHub; and a small HTTP server on a free
 * port of 127.0.0.1 answers the REST calls diff delver makes: one pull request,
 * a repository's open pull requests, the repository itself, and a pull
 * request's reviews: posting one, as GitHub checks it (its commit in the pull
 * request, its text and each comment at most 65,536 characters, each comment
 * on a line of a hunk of its own diff of the pull request, no other review
 * while the person has a draft one, no approving one's own), and listing them. What it
 * gives diff delver says git fetches a repository from its folder, so a fetch
 * never leaves the machine. It records every request, so a test can check what was asked
 * and with which sign-in.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
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
	/**
	 * The commit the API names as its head instead of the one
	 * `refs/pull/<number>/head` is at, as GitHub's answer can lag just after
	 * a push.
	 */
	readonly answeredHead?: string;
}

interface StandInRepository {
	readonly owner: string;
	readonly name: string;
	readonly repo: GitRepo;
	/** Shown only to a request with the token. */
	readonly private: boolean;
	readonly pulls: Map<number, StandInPull>;
	/** Each pull request's reviews, oldest first. */
	readonly reviews: Map<number, StandInReview[]>;
}

/** A review posted to a pull request on the stand-in, as GitHub keeps it. */
export interface StandInReview {
	readonly id: number;
	readonly user: string;
	readonly state: 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED';
	readonly commitId: string;
	readonly body: string;
	readonly comments: readonly StandInReviewComment[];
}

/** A comment of a review on its lines, as it was posted. */
export interface StandInReviewComment {
	readonly path: string;
	readonly body: string;
	readonly line: number;
	readonly side: 'LEFT' | 'RIGHT';
	readonly startLine?: number;
	readonly startSide?: 'LEFT' | 'RIGHT';
}

/** How the stand-in answers the next review posted, instead of as GitHub would. */
export type ReviewRefusal =
	/** GitHub refuses it with this status and message. */
	| { readonly kind: 'status'; readonly status: number; readonly message: string }
	/** GitHub makes the review, and the connection drops before its answer is sent. */
	| { readonly kind: 'drop-answer' }
	/**
	 * The connection drops before any answer, and GitHub makes the review
	 * only later, when `makeLateReviews` is called, as after a time-out.
	 */
	| { readonly kind: 'make-late' };

/** A request the stand-in answered: its path and query, its sign-in and tag, if any, and its status. */
export interface StandInRequest {
	readonly method: string;
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
	/**
	 * Refuses every fetch of a repository's commits for now, as a dropped
	 * connection would, or with false serves them again. The API still answers.
	 */
	refuseFetches(refuse: boolean): void;
	/**
	 * Refuses the reviews posted next, one refusal each, oldest first, instead
	 * of checking them as GitHub would.
	 */
	refuseReviews(...refusals: readonly ReviewRefusal[]): void;
	/** Makes the reviews held back by `make-late` refusals, as GitHub at last does. */
	makeLateReviews(): void;
	/** The reviews of a pull request, oldest first, as posted. */
	reviews(owner: string, name: string, number: number): readonly StandInReview[];
	/** Adds a review to a pull request as someone posted it on GitHub, by any account. */
	plantReview(
		owner: string,
		name: string,
		number: number,
		review: Pick<StandInReview, 'user' | 'state' | 'body'>
	): void;
	/** The requests answered so far, oldest first. */
	readonly requests: readonly StandInRequest[];
	close(): Promise<void>;
}

/** The token the stand-in takes as a sign-in; any other is refused as expired. */
export const STAND_IN_TOKEN = 'stand-in-token';

/** Who is signed in with `STAND_IN_TOKEN`. */
export const STAND_IN_USER = 'reviewer';

/** The account id of `STAND_IN_USER`; any other account's is another. */
export const STAND_IN_USER_ID = 7001;

/** The id the stand-in gives the first review posted to it; each next one is one more. */
export const FIRST_REVIEW_ID = 4001;

/** Reads a request's body as JSON, or undefined when it is not. */
async function bodyOf(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return parsed;
	} catch {
		return undefined;
	}
}

const githubSide = z.enum(['LEFT', 'RIGHT']);

/** A review as GitHub's API takes it. */
const postedReview = z.object({
	commit_id: z.string(),
	body: z.string().optional(),
	event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']).optional(),
	comments: z
		.array(
			z.object({
				path: z.string(),
				body: z.string(),
				line: z.number().int(),
				side: githubSide,
				start_line: z.number().int().optional(),
				start_side: githubSide.optional()
			})
		)
		.optional()
});

/** The lines each file's diff shows on each side, by its path in the pull request, as GitHub's has them. */
async function hunksOf(
	repo: GitRepo,
	base: string,
	head: string
): Promise<Map<string, { LEFT: [number, number][]; RIGHT: [number, number][] }>> {
	const diff = await runGitText({
		cwd: repo.dir,
		args: ['-c', 'core.quotePath=false', 'diff', '--unified=3', '-M', `${base}...${head}`]
	});
	if (!diff.ok) throw new Error('The stand-in could not diff the pull request');
	const files = new Map<string, { LEFT: [number, number][]; RIGHT: [number, number][] }>();
	let current: { LEFT: [number, number][]; RIGHT: [number, number][] } | undefined;
	let oldPath = '';
	for (const line of diff.value.split('\n')) {
		if (line.startsWith('diff --git ')) current = undefined;
		else if (line.startsWith('--- ')) oldPath = line.slice(4).replace(/^a\//, '');
		else if (line.startsWith('+++ ')) {
			const newPath = line.slice(4).replace(/^b\//, '');
			current = { LEFT: [], RIGHT: [] };
			files.set(newPath === '/dev/null' ? oldPath : newPath, current);
		} else if (line.startsWith('@@ ') && current !== undefined) {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (match === null) continue;
			const span = (start?: string, length?: string): [number, number] => [
				Number(start),
				Number(start) + Number(length ?? '1') - 1
			];
			current.LEFT.push(span(match[1], match[2]));
			current.RIGHT.push(span(match[3], match[4]));
		}
	}
	return files;
}

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
			sha:
				pull.answeredHead ??
				(await commitOf(repository.repo, `refs/pull/${String(pull.number)}/head`)),
			ref: pull.head,
			repo: { full_name: pull.fork ?? fullName }
		},
		base: {
			sha: await commitOf(repository.repo, `refs/heads/${pull.base}`),
			ref: pull.base,
			repo: { full_name: fullName, clone_url: `https://github.com/${fullName}.git` }
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
	let refusingFetches = false;
	let refusing: { readonly status: number; readonly resetAt: number | undefined } | undefined;
	const reviewRefusals: ReviewRefusal[] = [];
	let nextReviewId = FIRST_REVIEW_ID;
	/** Reviews GitHub makes later, with the list each goes in. */
	const late: { readonly review: StandInReview; readonly into: StandInReview[] }[] = [];
	const userIds = new Map<string, number>([[STAND_IN_USER, STAND_IN_USER_ID]]);
	const userId = (login: string): number => {
		const known = userIds.get(login);
		if (known !== undefined) return known;
		const made = STAND_IN_USER_ID + userIds.size;
		userIds.set(login, made);
		return made;
	};
	const key = (owner: string, name: string): string => `${owner}/${name}`.toLowerCase();

	const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? '/', 'http://stand-in');
		const authorization = request.headers.authorization;
		const ifNoneMatch = request.headers['if-none-match'];
		response.on('close', () => {
			requests.push({
				method: request.method ?? 'GET',
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
		if (url.pathname === '/user') {
			if (signedIn) json(response, 200, { login: STAND_IN_USER, id: STAND_IN_USER_ID });
			else json(response, 401, { message: 'Requires authentication' });
			return;
		}
		const reviewsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
		if (reviewsMatch !== null) {
			await answerReviews(request, response, reviewsMatch, signedIn, url);
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

	const answerReviews = async (
		request: IncomingMessage,
		response: ServerResponse,
		match: RegExpExecArray,
		signedIn: boolean,
		url: URL
	): Promise<void> => {
		const repository = repositories.get(key(match[1] ?? '', match[2] ?? ''));
		const pull = repository?.pulls.get(Number(match[3]));
		if (repository === undefined || pull === undefined || (repository.private && !signedIn)) {
			json(response, 404, { message: 'Not Found' });
			return;
		}
		const all = repository.reviews.get(pull.number) ?? [];
		repository.reviews.set(pull.number, all);
		const shown = (review: StandInReview): unknown => ({
			id: review.id,
			user: { login: review.user, id: userId(review.user) },
			body: review.body,
			state: review.state,
			commit_id: review.commitId,
			html_url: `https://github.com/${repository.owner}/${repository.name}/pull/${String(pull.number)}#pullrequestreview-${String(review.id)}`
		});
		if (request.method !== 'POST') {
			const visible = all.filter(
				(r) => r.state !== 'PENDING' || (signedIn && r.user === STAND_IN_USER)
			);
			const perPage = Number(url.searchParams.get('per_page') ?? '30');
			const page = Number(url.searchParams.get('page') ?? '1');
			const listed = visible.slice((page - 1) * perPage, page * perPage);
			const more = visible.length > page * perPage;
			json(
				response,
				200,
				listed.map(shown),
				more ? { link: '<http://stand-in/next>; rel="next"' } : {}
			);
			return;
		}
		const body = await bodyOf(request);
		if (!signedIn) {
			json(response, 401, { message: 'Requires authentication' });
			return;
		}
		const refusal = reviewRefusals.shift();
		if (refusal?.kind === 'status') {
			json(response, refusal.status, { message: refusal.message });
			return;
		}
		const read = postedReview.safeParse(body);
		if (!read.success) {
			json(response, 422, { message: 'Unprocessable Entity' });
			return;
		}
		const sent = read.data;
		const event = sent.event;
		const comments = (sent.comments ?? []).map((c): StandInReviewComment => ({
			path: c.path,
			body: c.body,
			line: c.line,
			side: c.side,
			...(c.start_line === undefined ? {} : { startLine: c.start_line }),
			...(c.start_side === undefined ? {} : { startSide: c.start_side })
		}));
		// GitHub takes no review from a person while they have a draft one there, of any kind.
		if (all.some((r) => r.state === 'PENDING' && r.user === STAND_IN_USER)) {
			json(response, 422, {
				message: 'Unprocessable Entity',
				errors: ['User can only have one pending review per pull request']
			});
			return;
		}
		if ((event === 'APPROVE' || event === 'REQUEST_CHANGES') && pull.author === STAND_IN_USER) {
			json(response, 422, {
				message: 'Unprocessable Entity',
				errors: [
					event === 'APPROVE'
						? 'Can not approve your own pull request'
						: 'Can not request changes on your own pull request'
				]
			});
			return;
		}
		const tooLong = [sent.body ?? '', ...comments.map((c) => c.body)].some(
			(text) => Array.from(text).length > 65_536
		);
		if (tooLong) {
			json(response, 422, {
				message: 'Unprocessable Entity',
				errors: ['Body is too long (maximum is 65536 characters)']
			});
			return;
		}
		const inPull = await runGitText({
			cwd: repository.repo.dir,
			args: ['merge-base', '--is-ancestor', sent.commit_id, `refs/pull/${String(pull.number)}/head`]
		});
		if (!inPull.ok) {
			json(response, 422, {
				message: 'Unprocessable Entity',
				errors: ['No commit found for SHA: ' + sent.commit_id]
			});
			return;
		}
		const hunks = await hunksOf(repository.repo, pull.base, sent.commit_id);
		const placed = comments.every((c) => {
			const spans = hunks.get(c.path)?.[c.side] ?? [];
			const first = c.startLine ?? c.line;
			return spans.some(([from, to]) => first >= from && c.line <= to);
		});
		if (!placed) {
			json(response, 422, {
				message: 'Unprocessable Entity',
				errors: ['Line could not be resolved']
			});
			return;
		}
		const state =
			event === 'APPROVE'
				? 'APPROVED'
				: event === 'REQUEST_CHANGES'
					? 'CHANGES_REQUESTED'
					: event === 'COMMENT'
						? 'COMMENTED'
						: 'PENDING';
		const review: StandInReview = {
			id: nextReviewId,
			user: STAND_IN_USER,
			state,
			commitId: sent.commit_id,
			body: sent.body ?? '',
			comments
		};
		nextReviewId += 1;
		if (refusal?.kind === 'make-late') {
			late.push({ review, into: all });
			response.socket?.destroy();
			return;
		}
		all.push(review);
		if (refusal?.kind === 'drop-answer') {
			response.socket?.destroy();
			return;
		}
		json(response, 200, shown(review));
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
				gitAddress: (repository) => {
					const served = repositories.get(key(repository.owner, repository.name));
					if (served === undefined) {
						throw new Error(`The stand-in has no ${repository.owner}/${repository.name}`);
					}
					// A folder that is no repository, so git's transport fails.
					return refusingFetches ? join(served.repo.dir, 'refused') : served.repo.dir;
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
				pulls: new Map(),
				reviews: new Map()
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
		refuseFetches(refuse) {
			refusingFetches = refuse;
		},
		refuseReviews(...refusals) {
			reviewRefusals.push(...refusals);
		},
		makeLateReviews() {
			for (const { review, into } of late.splice(0)) into.push(review);
		},
		reviews(owner, name, number) {
			return repositories.get(key(owner, name))?.reviews.get(number) ?? [];
		},
		plantReview(owner, name, number, review) {
			const repository = repositories.get(key(owner, name));
			const pull = repository?.pulls.get(number);
			if (repository === undefined || pull === undefined) {
				throw new Error(`The stand-in has no ${owner}/${name}#${String(number)}`);
			}
			const all = repository.reviews.get(number) ?? [];
			repository.reviews.set(number, all);
			all.push({ ...review, id: nextReviewId, commitId: pull.head, comments: [] });
			nextReviewId += 1;
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
