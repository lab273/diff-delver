import { describe, expect, it } from 'vitest';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';
import { parseGitHubBranchName, type GitHubBranchName } from './github-branch-name.tiny.ts';
import { parseGitHubAuthor } from './github-author.tiny.ts';
import {
	describeListedDetails,
	describeListedTitle,
	describePullRequestList,
	type ListedPullRequest
} from './listed-pull-request.ts';
import { parsePullRequestNumber } from './pull-request-number.tiny.ts';
import { pullRequestTitleOf } from './pull-request-title.tiny.ts';

function at(ms: number): Timestamp {
	const t = parseTimestamp(ms);
	if (!t.ok) throw new Error('time');
	return t.value;
}

function branch(name: string): GitHubBranchName {
	const b = parseGitHubBranchName(name);
	if (!b.ok) throw new Error(name);
	return b.value;
}

const HOUR = 3_600_000;
const number = parsePullRequestNumber(12);
const author = parseGitHubAuthor('octo');
if (!number.ok || !author.ok) throw new Error('parts');

const pull: ListedPullRequest = {
	number: number.value,
	title: pullRequestTitleOf('Add a discount rate'),
	author: author.value,
	head: branch('discount'),
	base: branch('main'),
	fromFork: false,
	draft: false,
	updatedAt: at(10 * HOUR)
};

describe('a listed pull request', () => {
	it('shows its number and title, then who, from where to where and when', () => {
		expect(describeListedTitle(pull)).toBe('#12 Add a discount rate');
		expect(describeListedDetails(pull, at(13 * HOUR))).toBe(
			'By octo, from discount into main, updated 3 hours ago'
		);
	});

	it('says when its branch is a fork’s, or its author is gone', () => {
		expect(
			describeListedDetails({ ...pull, fromFork: true, author: undefined }, at(10 * HOUR))
		).toBe('By a deleted account, from a fork’s discount into main, updated just now');
	});

	it('says how many it lists, in which repository, and what to do', () => {
		expect(describePullRequestList(0, false, 'acme/shop')).toBe(
			'acme/shop has no open pull requests.'
		);
		expect(describePullRequestList(1, false, 'acme/shop')).toBe(
			'1 open pull request in acme/shop. Choose it to review it.'
		);
		expect(describePullRequestList(3, false, 'acme/shop')).toBe(
			'3 open pull requests in acme/shop, most recently updated first. Choose one to review it.'
		);
		expect(describePullRequestList(50, true, 'acme/shop')).toBe(
			'The 50 open pull requests in acme/shop updated most recently. Choose one to review it.'
		);
	});
});
