/**
 * The few calls diff delver makes to GitHub's REST API: one pull request, and
 * a repository's open pull requests. Each is made only when a person asks
 * (opening a pull request, bringing it up to date, opening the list), with a
 * time limit, and never asks anything of the person. GitHub's answers are
 * read with Zod at this edge; what they hold is text from GitHub, shown with
 * what cannot be seen written out and never as markup.
 */
import { z } from 'zod';
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import {
	parseGitHubBranchName,
	type GitHubBranchName
} from '#lib/core/github/github-branch-name.tiny.ts';
import { parseGitHubAuthor, type GitHubAuthor } from '#lib/core/github/github-author.tiny.ts';
import type { GitHubRepository } from '#lib/core/github/github-repository.ts';
import type { GitHubToken } from '#lib/core/github/github-token.tiny.ts';
import type { ListedPullRequest } from '#lib/core/github/listed-pull-request.ts';
import type { PullRequestRef, PullRequestState } from '#lib/core/github/pull-request.ts';
import {
	pullRequestDescriptionOf,
	type PullRequestDescription
} from '#lib/core/github/pull-request-description.tiny.ts';
import { parsePullRequestNumber } from '#lib/core/github/pull-request-number.tiny.ts';
import {
	pullRequestTitleOf,
	type PullRequestTitle
} from '#lib/core/github/pull-request-title.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseTimestamp, type Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseGitHubEtag, type GitHubEtag } from '#lib/core/github/github-etag.tiny.ts';
import type { GitHubAccess } from './github-access.ts';
import type { GitHubApiError } from './github-error.ts';

/** How many open pull requests the list asks for: the most recently updated. */
export const PULL_REQUESTS_LISTED = 50;

/** What diff delver needs of one pull request. */
export interface PullRequestDetails {
	readonly ref: PullRequestRef;
	readonly title: PullRequestTitle;
	/** Its description, as its author wrote it; undefined when it has none. */
	readonly description: PullRequestDescription | undefined;
	readonly state: PullRequestState;
	readonly draft: boolean;
	readonly author: GitHubAuthor | undefined;
	/** The commit its branch is at, and the branch's name. */
	readonly head: { readonly commit: CommitId; readonly branch: GitHubBranchName };
	/** The branch it would merge into, and the commit GitHub last saw it at. */
	readonly base: { readonly commit: CommitId; readonly branch: GitHubBranchName };
}

function tiny<T>(parse: (value: string) => Result<T, unknown>) {
	return z.string().transform((value, context) => {
		const parsed = parse(value);
		if (parsed.ok) return parsed.value;
		context.addIssue({ code: 'custom', message: 'not valid here' });
		return z.NEVER;
	});
}

const time = z.string().transform((value, context) => {
	const parsed = parseTimestamp(Date.parse(value));
	if (parsed.ok) return parsed.value;
	context.addIssue({ code: 'custom', message: 'not a time' });
	return z.NEVER;
});

const number = z.number().transform((value, context) => {
	const parsed = parsePullRequestNumber(value);
	if (parsed.ok) return parsed.value;
	context.addIssue({ code: 'custom', message: 'not a number' });
	return z.NEVER;
});

const user = z.object({ login: tiny(parseGitHubAuthor) }).nullable();

const pullShape = z.object({
	number,
	title: z.string().transform(pullRequestTitleOf),
	body: z.string().nullable().optional(),
	state: z.enum(['open', 'closed']),
	merged_at: z.string().nullable().optional(),
	draft: z.boolean().optional(),
	user,
	updated_at: time,
	head: z.object({
		sha: tiny(parseCommitId),
		ref: tiny(parseGitHubBranchName),
		repo: z.object({ full_name: z.string() }).nullable()
	}),
	base: z.object({
		sha: tiny(parseCommitId),
		ref: tiny(parseGitHubBranchName),
		repo: z.object({ full_name: z.string() })
	})
});

type PullShape = z.infer<typeof pullShape>;

export interface Answer {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
}

/**
 * One request to GitHub's API: a GET, or with `send`, a POST of that JSON,
 * which is never followed to another address, so what is sent goes only
 * where it was meant to.
 */
export async function ask(
	access: GitHubAccess,
	repository: GitHubRepository,
	path: string,
	token: GitHubToken | undefined,
	etag?: GitHubEtag,
	send?: unknown
): Promise<Result<Answer, GitHubApiError>> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'diff-delver'
	};
	if (token !== undefined) headers.Authorization = `Bearer ${token}`;
	if (etag !== undefined) headers['If-None-Match'] = etag;
	if (send !== undefined) headers['Content-Type'] = 'application/json';
	let response: Response;
	try {
		response = await fetch(`${access.apiBase(repository.host)}${path}`, {
			headers,
			...(send === undefined
				? { redirect: 'follow' }
				: { method: 'POST', body: JSON.stringify(send), redirect: 'error' }),
			signal: AbortSignal.timeout(access.seconds * 1000)
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === 'TimeoutError';
		return err(
			timedOut
				? { kind: 'GitHubTimedOut', host: repository.host, seconds: access.seconds }
				: { kind: 'GitHubUnreachable', host: repository.host }
		);
	}
	let body: unknown;
	try {
		body = response.status === 304 ? undefined : await response.json();
	} catch {
		body = undefined;
	}
	return ok({ status: response.status, headers: response.headers, body });
}

/**
 * How many seconds from `now` GitHub asks to be left alone, from a refusal's
 * `retry-after` (seconds from now) or `x-ratelimit-reset` (when the limit is
 * reset, in seconds since 1970); undefined when it says neither.
 */
function secondsToWait(headers: Headers, now: Timestamp): number | undefined {
	const after = Number(headers.get('retry-after') ?? '');
	if (headers.has('retry-after') && Number.isFinite(after) && after >= 0) return Math.ceil(after);
	const reset = Number(headers.get('x-ratelimit-reset') ?? '');
	if (!headers.has('x-ratelimit-reset') || !Number.isFinite(reset)) return undefined;
	return Math.max(0, Math.ceil(reset - now / 1000));
}

/** What a refusal means: who is asking matters for every one of them. */
export function refusal(
	answer: Answer,
	repository: GitHubRepository,
	token: GitHubToken | undefined,
	now: Timestamp
): GitHubApiError {
	const signedIn = token !== undefined;
	const limited =
		answer.status === 429 ||
		(answer.status === 403 &&
			(answer.headers.get('x-ratelimit-remaining') === '0' || answer.headers.has('retry-after')));
	if (limited) {
		return {
			kind: 'GitHubRateLimited',
			host: repository.host,
			signedIn,
			waitSeconds: secondsToWait(answer.headers, now)
		};
	}
	if (answer.status === 401) {
		return signedIn
			? { kind: 'GitHubSignInRefused', host: repository.host }
			: { kind: 'GitHubSignInNeeded', repository };
	}
	if (answer.status === 403 || answer.status === 404) {
		return signedIn
			? { kind: 'GitHubNoAccess', repository }
			: { kind: 'GitHubSignInNeeded', repository };
	}
	return { kind: 'GitHubAnswerUnreadable', host: repository.host, status: answer.status };
}

export function repositoryPath(repository: GitHubRepository): string {
	return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function stateOf(pull: PullShape): PullRequestState {
	if (pull.state === 'open') return 'open';
	return pull.merged_at === null || pull.merged_at === undefined ? 'closed' : 'merged';
}

function fromFork(pull: PullShape): boolean {
	return (
		pull.head.repo === null ||
		pull.head.repo.full_name.toLowerCase() !== pull.base.repo.full_name.toLowerCase()
	);
}

/**
 * What reading a pull request found: its details, with the tag GitHub gave
 * this answer (`ETag`) to ask with next time, or, asked with the tag it gave
 * last, that nothing has changed since.
 */
export type ReadPullRequest =
	| {
			readonly kind: 'read';
			readonly details: PullRequestDetails;
			readonly etag: GitHubEtag | undefined;
	  }
	| { readonly kind: 'not-modified' };

/** Each answer of `readPullRequest`, with whether it was asked signed in. */
export interface PullRequestAnswer {
	readonly signedIn: boolean;
	readonly read: Result<ReadPullRequest, GitHubApiError>;
}

/**
 * One pull request, as GitHub has it now. With `etag`, the tag of the answer
 * read last, GitHub may answer that nothing has changed (304), which it does
 * not count against a signed-in person's requests. `now`, by the caller's
 * clock, says how long a refusal for too many requests asks to wait.
 */
export async function readPullRequest(
	access: GitHubAccess,
	ref: PullRequestRef,
	now: Timestamp,
	etag?: GitHubEtag
): Promise<PullRequestAnswer> {
	const token = await access.token(ref.repository.host);
	return { signedIn: token !== undefined, read: await readWith(access, ref, now, token, etag) };
}

async function readWith(
	access: GitHubAccess,
	ref: PullRequestRef,
	now: Timestamp,
	token: GitHubToken | undefined,
	etag: GitHubEtag | undefined
): Promise<Result<ReadPullRequest, GitHubApiError>> {
	const { repository } = ref;
	const asked = await ask(
		access,
		repository,
		`${repositoryPath(repository)}/pulls/${String(ref.number)}`,
		token,
		etag
	);
	if (!asked.ok) return asked;
	if (asked.value.status === 304 && etag !== undefined) return ok({ kind: 'not-modified' });
	if (asked.value.status === 404) {
		// Not found: the pull request, or the repository? Only the repository can say.
		const repo = await ask(access, repository, repositoryPath(repository), token);
		if (!repo.ok) return repo;
		if (repo.value.status === 200) return err({ kind: 'PullRequestNotFound', pullRequest: ref });
		return err(refusal(repo.value, repository, token, now));
	}
	if (asked.value.status !== 200) return err(refusal(asked.value, repository, token, now));
	const read = pullShape.safeParse(asked.value.body);
	if (!read.success) {
		return err({
			kind: 'GitHubAnswerUnreadable',
			host: repository.host,
			status: asked.value.status
		});
	}
	const pull = read.data;
	const tag = parseGitHubEtag(asked.value.headers.get('etag') ?? '');
	const details: PullRequestDetails = {
		ref,
		title: pull.title,
		description: pullRequestDescriptionOf(pull.body),
		state: stateOf(pull),
		draft: pull.draft ?? false,
		author: pull.user?.login,
		head: { commit: pull.head.sha, branch: pull.head.ref },
		base: { commit: pull.base.sha, branch: pull.base.ref }
	};
	return ok({ kind: 'read', details, etag: tag.ok ? tag.value : undefined });
}

/** A page of a repository's open pull requests. */
export interface OpenPullRequests {
	readonly pulls: readonly ListedPullRequest[];
	/** Whether it has more than were listed. */
	readonly more: boolean;
}

/** The repository's open pull requests, most recently updated first, at most `PULL_REQUESTS_LISTED`. */
export async function listOpenPullRequests(
	access: GitHubAccess,
	repository: GitHubRepository,
	now: Timestamp
): Promise<Result<OpenPullRequests, GitHubApiError>> {
	const token = await access.token(repository.host);
	const query = new URLSearchParams({
		state: 'open',
		sort: 'updated',
		direction: 'desc',
		per_page: String(PULL_REQUESTS_LISTED)
	});
	const asked = await ask(
		access,
		repository,
		`${repositoryPath(repository)}/pulls?${query.toString()}`,
		token
	);
	if (!asked.ok) return asked;
	if (asked.value.status !== 200) return err(refusal(asked.value, repository, token, now));
	const read = z.array(pullShape).safeParse(asked.value.body);
	if (!read.success) {
		return err({
			kind: 'GitHubAnswerUnreadable',
			host: repository.host,
			status: asked.value.status
		});
	}
	const link = asked.value.headers.get('link') ?? '';
	return ok({
		pulls: read.data.map((pull): ListedPullRequest => ({
			number: pull.number,
			title: pull.title,
			author: pull.user?.login,
			head: pull.head.ref,
			base: pull.base.ref,
			fromFork: fromFork(pull),
			draft: pull.draft ?? false,
			updatedAt: pull.updated_at
		})),
		more: /rel="next"/.test(link)
	});
}
