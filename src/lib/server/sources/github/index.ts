/**
 * GitHub pull requests as sources (DESIGN 3.1, the GitHub PR row): asking
 * GitHub about them, finding a local repository's GitHub remote, and turning
 * one into a snapshot in the store. Import them from here.
 */
export type { GitHubAccess } from './github-access.ts';
export { GITHUB_SECONDS, machineGitHubAccess } from './github-access.ts';
export type { OpenPullRequests, PullRequestDetails } from './github-api.ts';
export { listOpenPullRequests, PULL_REQUESTS_LISTED, readPullRequest } from './github-api.ts';
export type { GitHubApiError, GitHubSourceError } from './github-error.ts';
export { describeGitHubSourceError } from './github-error.ts';
export { gitHubRemoteOf } from './github-remote.ts';
export { pullRequestFingerprint, snapshotPullRequest } from './snapshot-pull-request.ts';
