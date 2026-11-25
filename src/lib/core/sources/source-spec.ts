/**
 * Every source a Delve can follow (DESIGN 3.1): a local git source, or a
 * GitHub pull request. How each is written, read back and named.
 *
 * Text written as a web address (`https://…`) is read as a pull request's
 * address and as nothing else, since no git revision is written so; anything
 * else is a git source (`parseGitSourceSpec`).
 */
import { err, ok, type Result } from '../result.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import {
	describeInvalidPullRequestUrl,
	describePullRequest,
	looksLikeAddress,
	parsePullRequestUrl,
	pullRequestUrl,
	type InvalidPullRequestUrl,
	type PullRequestRef
} from '../github/pull-request.ts';
import {
	describeGitSource,
	describeInvalidSourceSpec,
	formatGitSourceSpec,
	parseGitSourceSpec,
	type GitSourceSpec,
	type InvalidSourceSpec
} from './git-source-spec.ts';
import { asSourceText, type SourceText } from './source-text.tiny.ts';

/** A GitHub pull request, followed by its number (DESIGN 6.1). */
export interface PullRequestSpec {
	readonly kind: 'pull-request';
	readonly pullRequest: PullRequestRef;
}

export type SourceSpec = GitSourceSpec | PullRequestSpec;

export type InvalidSource = InvalidSourceSpec | InvalidPullRequestUrl;

/** Reads a source as a person would type it: a pull request's address, or a git source. */
export function parseSourceSpec(text: string): Result<SourceSpec, InvalidSource> {
	if (looksLikeAddress(text)) {
		const pull = parsePullRequestUrl(text);
		return pull.ok ? ok({ kind: 'pull-request', pullRequest: pull.value }) : pull;
	}
	const spec = parseGitSourceSpec(text);
	return spec.ok ? spec : err(spec.error);
}

/** The source in its one written form, which `parseSourceSpec` reads back to the same source. */
export function formatSourceSpec(spec: SourceSpec): SourceText {
	return spec.kind === 'pull-request'
		? asSourceText(pullRequestUrl(spec.pullRequest))
		: formatGitSourceSpec(spec);
}

/** The source in plain words, before it is opened: "Uncommitted changes", "Pull request #12". */
export function describeSource(spec: SourceSpec): ReviewerMessage {
	return spec.kind === 'pull-request'
		? describePullRequest(spec.pullRequest, undefined)
		: describeGitSource(spec);
}

/** What is wrong with what was typed, and what to give instead. */
export function describeInvalidSource(error: InvalidSource): ReviewerMessage {
	return error.kind === 'InvalidPullRequestUrl'
		? describeInvalidPullRequestUrl(error)
		: describeInvalidSourceSpec(error);
}
