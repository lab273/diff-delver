/**
 * What can go wrong asking GitHub about a pull request, or fetching one, and
 * what the reviewer is told: what happened and what to do next. No message
 * holds a token, or anything GitHub answered that could.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import type { GitHubHost } from '#lib/core/github/github-host.tiny.ts';
import { visibleText } from '#lib/core/hidden-characters.ts';
import { gitHubRepositoryText, type GitHubRepository } from '#lib/core/github/github-repository.ts';
import { pullRequestShortName, type PullRequestRef } from '#lib/core/github/pull-request.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { describeGitSourceError, type GitSourceError } from '../git/index.ts';

/** GitHub could not be reached at all: no network, or the address does not answer. */
export interface GitHubUnreachable {
	readonly kind: 'GitHubUnreachable';
	readonly host: GitHubHost;
}

/** GitHub did not answer in time. */
export interface GitHubTimedOut {
	readonly kind: 'GitHubTimedOut';
	readonly host: GitHubHost;
	readonly seconds: number;
}

/** GitHub wants to know who is asking: the repository is private, or needs a sign-in. */
export interface GitHubSignInNeeded {
	readonly kind: 'GitHubSignInNeeded';
	readonly repository: GitHubRepository;
}

/** The token diff delver found was refused: it has expired or been revoked. */
export interface GitHubSignInRefused {
	readonly kind: 'GitHubSignInRefused';
	readonly host: GitHubHost;
}

/** The person is signed in, and GitHub says the repository is not there or not theirs to see. */
export interface GitHubNoAccess {
	readonly kind: 'GitHubNoAccess';
	readonly repository: GitHubRepository;
}

/** GitHub has had too many requests from this person, or this machine, for now. */
export interface GitHubRateLimited {
	readonly kind: 'GitHubRateLimited';
	readonly host: GitHubHost;
	readonly signedIn: boolean;
	/** How many seconds from now GitHub asks to be left alone, when it said. */
	readonly waitSeconds: number | undefined;
}

/** The repository is there, and has no pull request with that number. */
export interface PullRequestNotFound {
	readonly kind: 'PullRequestNotFound';
	readonly pullRequest: PullRequestRef;
}

/** GitHub answered with something diff delver could not read. */
export interface GitHubAnswerUnreadable {
	readonly kind: 'GitHubAnswerUnreadable';
	readonly host: GitHubHost;
	/** The status it answered with. */
	readonly status: number;
}

/** The pull request's commits could not be downloaded from GitHub. */
export interface PullRequestFetchFailed {
	readonly kind: 'PullRequestFetchFailed';
	readonly pullRequest: PullRequestRef;
	/** How many seconds it ran before it was stopped, when it took too long. */
	readonly stoppedAfter: number | undefined;
}

/** The pull request's branch and its base share no history in what was downloaded. */
export interface PullRequestNoMergeBase {
	readonly kind: 'PullRequestNoMergeBase';
	readonly pullRequest: PullRequestRef;
	readonly head: CommitId;
}

/** The folder is a clone of another repository, or of none on GitHub. */
export interface NotACloneOf {
	readonly kind: 'NotACloneOf';
	readonly directory: AbsolutePath;
	readonly wanted: GitHubRepository;
	/** The repository it is a clone of on GitHub, if any. */
	readonly found: GitHubRepository | undefined;
}

/** The repository has no remote on GitHub, so it has no pull requests to list. */
export interface NotOnGitHub {
	readonly kind: 'NotOnGitHub';
	readonly directory: AbsolutePath;
}

/** What asking GitHub's API can fail with. */
export type GitHubApiError =
	| GitHubUnreachable
	| GitHubTimedOut
	| GitHubSignInNeeded
	| GitHubSignInRefused
	| GitHubNoAccess
	| GitHubRateLimited
	| PullRequestNotFound
	| GitHubAnswerUnreadable;

/** What opening or following a pull request can fail with. */
export type GitHubSourceError =
	| GitHubApiError
	| PullRequestFetchFailed
	| PullRequestNoMergeBase
	| NotACloneOf
	| NotOnGitHub
	| GitSourceError;

const SIGN_IN =
	'Sign in with the GitHub command, "gh auth login", or set GITHUB_TOKEN to a token that can read it, then try again.';

/** A time limit in words: "10 minutes", "30 seconds". */
function describeDuration(seconds: number): string {
	if (seconds < 120) return `${String(seconds)} seconds`;
	return `${String(Math.round(seconds / 60))} minutes`;
}

/** When to try again, from how long GitHub asked to wait: "Try again in 3 minutes." */
function describeWait(seconds: number | undefined): string {
	if (seconds === undefined) return 'Wait a few minutes, then try again.';
	if (seconds <= 60) return 'Try again in a minute.';
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 120) return `Try again in ${String(minutes)} minutes.`;
	return `Try again in ${String(Math.ceil(minutes / 60))} hours.`;
}

/** What happened and what to do next, for the reviewer. */
export function describeGitHubSourceError(error: GitHubSourceError): ReviewerMessage {
	switch (error.kind) {
		case 'GitHubUnreachable':
			return reviewerMessage(
				`${error.host} could not be reached. Check that this computer is online, then try again.`
			);
		case 'GitHubTimedOut':
			return reviewerMessage(
				`${error.host} did not answer within ${String(error.seconds)} seconds. Try again in a moment.`
			);
		case 'GitHubSignInNeeded':
			return reviewerMessage(
				`GitHub did not show ${gitHubRepositoryText(error.repository)} to diff delver: it is private, or not there. ${SIGN_IN}`
			);
		case 'GitHubSignInRefused':
			return reviewerMessage(
				`GitHub refused the sign-in diff delver found for ${error.host}: it has most likely expired. Sign in again with "gh auth login", or set GITHUB_TOKEN to a new token, then try again.`
			);
		case 'GitHubNoAccess':
			return reviewerMessage(
				`GitHub says ${gitHubRepositoryText(error.repository)} is not there, or that you may not see it. Check the address, and that the account you signed in with ("gh auth status" shows it) can read it.`
			);
		case 'GitHubRateLimited': {
			const wait = describeWait(error.waitSeconds);
			return reviewerMessage(
				error.signedIn
					? `GitHub has had too many requests from your account for now. ${wait}`
					: `GitHub has had too many requests from this computer for now. ${wait} GitHub allows many more to a signed-in person: sign in with the GitHub command, "gh auth login", or set GITHUB_TOKEN to a token.`
			);
		}
		case 'PullRequestNotFound':
			return reviewerMessage(
				`${pullRequestShortName(error.pullRequest)} is not a pull request: GitHub has none with that number. Check the address, then try again.`
			);
		case 'GitHubAnswerUnreadable':
			return reviewerMessage(
				`${error.host} answered in a way diff delver could not read (status ${String(error.status)}). Try again in a moment.`
			);
		case 'PullRequestFetchFailed':
			return reviewerMessage(
				error.stoppedAfter !== undefined
					? `Downloading ${pullRequestShortName(error.pullRequest)}'s commits from GitHub was stopped after ${describeDuration(error.stoppedAfter)}, unfinished. A large repository can take longer: run "git fetch" in this clone first, so that less is left to download, then try again.`
					: `${pullRequestShortName(error.pullRequest)}'s commits could not be downloaded from GitHub. Check that this computer is online and that you can read the repository, then try again.`
			);
		case 'PullRequestNoMergeBase':
			return reviewerMessage(
				`${pullRequestShortName(error.pullRequest)}'s branch shares no history with its base branch, so there is nothing to compare it with. If this clone is shallow, download more history with "git fetch --unshallow", then try again.`
			);
		case 'NotACloneOf':
			return reviewerMessage(
				error.found === undefined
					? `${visibleText(error.directory)} is not a clone of ${gitHubRepositoryText(error.wanted)}: none of its remotes is on GitHub. Run diff delver in a clone of ${gitHubRepositoryText(error.wanted)} to open its pull requests.`
					: `${visibleText(error.directory)} is a clone of ${gitHubRepositoryText(error.found)}, not of ${gitHubRepositoryText(error.wanted)}. Run diff delver in a clone of ${gitHubRepositoryText(error.wanted)} to open its pull requests.`
			);
		case 'NotOnGitHub':
			return reviewerMessage(
				`${visibleText(error.directory)} has no remote on GitHub, so it has no pull requests to show. Add one with "git remote add", or open its commits or branches instead.`
			);
		case 'UnresolvedConflict':
		case 'NoWorkingTree':
		case 'UnknownRevision':
		case 'NoCommitsYet':
		case 'ShallowHistory':
		case 'NoCommonHistory':
		case 'PartialCloneMissing':
		case 'GitNotFound':
		case 'GitTooOld':
		case 'NoSuchDirectory':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'MissingObject':
		case 'GitFailed':
		case 'DataDirectoryUnusable':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'StoreDamaged':
			return describeGitSourceError(error);
	}
}
