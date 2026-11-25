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
import { parseGitHubOwner, type GitHubOwner } from '#lib/core/github/github-owner.tiny.ts';
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
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
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
	readonly author: GitHubOwner | undefined;
	/** The commit its branch is at, and the branch's name. */
	readonly head: { readonly commit: CommitId; readonly branch: GitHubBranchName };
	/** The branch it would merge into, the commit GitHub last saw it at, and where to fetch from. */
	readonly base: {
		readonly commit: CommitId;
		readonly branch: GitHubBranchName;
		/** The address its repository is cloned from; `refs/pull/<number>/head` is fetched from it too. */
		readonly cloneUrl: string;
	};
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

const user = z.object({ login: tiny(parseGitHubOwner) }).nullable();

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
		repo: z.object({ full_name: z.string(), clone_url: z.string() })
	})
});

type PullShape = z.infer<typeof pullShape>;

interface Answer {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
}

async function ask(
	access: GitHubAccess,
	repository: GitHubRepository,
	path: string,
	token: GitHubToken | undefined
): Promise<Result<Answer, GitHubApiError>> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'diff-delver'
	};
	if (token !== undefined) headers.Authorization = `Bearer ${token}`;
	let response: Response;
	try {
		response = await fetch(`${access.apiBase(repository.host)}${path}`, {
			headers,
			redirect: 'follow',
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
		body = await response.json();
	} catch {
		body = undefined;
	}
	return ok({ status: response.status, headers: response.headers, body });
}

/** What a refusal means: who is asking matters for every one of them. */
function refusal(
	answer: Answer,
	repository: GitHubRepository,
	token: GitHubToken | undefined
): GitHubApiError {
	const signedIn = token !== undefined;
	const limited =
		answer.status === 429 ||
		(answer.status === 403 && answer.headers.get('x-ratelimit-remaining') === '0');
	if (limited) return { kind: 'GitHubRateLimited', host: repository.host, signedIn };
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

function repositoryPath(repository: GitHubRepository): string {
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

/** One pull request, as GitHub has it now. */
export async function readPullRequest(
	access: GitHubAccess,
	ref: PullRequestRef
): Promise<Result<PullRequestDetails, GitHubApiError>> {
	const { repository } = ref;
	const token = await access.token(repository.host);
	const asked = await ask(
		access,
		repository,
		`${repositoryPath(repository)}/pulls/${String(ref.number)}`,
		token
	);
	if (!asked.ok) return asked;
	if (asked.value.status === 404) {
		// Not found: the pull request, or the repository? Only the repository can say.
		const repo = await ask(access, repository, repositoryPath(repository), token);
		if (!repo.ok) return repo;
		if (repo.value.status === 200) return err({ kind: 'PullRequestNotFound', pullRequest: ref });
		return err(refusal(repo.value, repository, token));
	}
	if (asked.value.status !== 200) return err(refusal(asked.value, repository, token));
	const read = pullShape.safeParse(asked.value.body);
	if (!read.success) {
		return err({
			kind: 'GitHubAnswerUnreadable',
			host: repository.host,
			status: asked.value.status
		});
	}
	const pull = read.data;
	return ok({
		ref,
		title: pull.title,
		description: pullRequestDescriptionOf(pull.body),
		state: stateOf(pull),
		draft: pull.draft ?? false,
		author: pull.user?.login,
		head: { commit: pull.head.sha, branch: pull.head.ref },
		base: { commit: pull.base.sha, branch: pull.base.ref, cloneUrl: pull.base.repo.clone_url }
	});
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
	repository: GitHubRepository
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
	if (asked.value.status !== 200) return err(refusal(asked.value, repository, token));
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
