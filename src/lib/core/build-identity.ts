/**
 * Which build of diff delver is running, as the header of every page says it
 * (DESIGN 9): the release, if it is one, and the commit it was built from,
 * with when that commit was made and whether the working tree it was built
 * from had changes not committed. Each is recorded when the command is built
 * (`vite.cli.config.ts`), and any of them may be unknown, as for a build made
 * where git or the repository was not there.
 */
import type { CodeVersion } from './code-version.tiny.ts';
import type { CommitId } from './commit-id.tiny.ts';
import { describeExactTime } from './history/history-words.ts';
import { releaseTag, type ReleaseVersion } from './release-version.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from './reviewer-message.tiny.ts';
import { describeTimeAgo } from './time-ago.ts';
import type { Timestamp } from './timestamp.tiny.ts';

/** The commit a build was made from. */
export interface BuildCommit {
	readonly commit: CommitId;
	/** When the commit was made (its committer date), when git said. */
	readonly committedAt: Timestamp | undefined;
	/** Whether the working tree had changes not committed when it was built. */
	readonly changes: boolean;
}

export interface BuildIdentity {
	readonly release: ReleaseVersion | undefined;
	readonly commit: BuildCommit | undefined;
}

/** How many characters of a commit's id the header shows, as git's short form does. */
export const SHORT_COMMIT_LENGTH = 7;

/** A commit as the header, `--version` and the log name it: "a3f9c21", or "a3f9c21 + changes". */
export function shortCommit(commit: BuildCommit): string {
	const short = commit.commit.slice(0, SHORT_COMMIT_LENGTH);
	return commit.changes ? `${short} + changes` : short;
}

/**
 * A build's version with its commit, as `--version` and the daemon's log say
 * it: "0.0.1-dev+3f2a1b9c0d4e (a3f9c21)"; the version alone when no commit is known.
 */
export function versionWithCommit(version: CodeVersion, commit: BuildCommit | undefined): string {
	return commit === undefined ? version : `${version} (${shortCommit(commit)})`;
}

export interface BuildWords {
	/** What the header shows: "v0.2.0 · a3f9c21 · 3 days ago", "a3f9c21 + changes · 2 hours ago". */
	readonly text: ReviewerMessage;
	/** The text without how long ago, for a narrow window: "v0.2.0 · a3f9c21". */
	readonly named: ReviewerMessage;
	/** How long ago the commit was made, when that is known: "3 days ago". */
	readonly ago: ReviewerMessage | undefined;
	/** All of it, exactly: "Built from commit a3f9c21…, made 15 January 2026, 09:30 UTC". */
	readonly full: ReviewerMessage;
}

/** The build in words, measured from `now`, the daemon's clock; undefined when nothing is known of it. */
export function describeBuild(build: BuildIdentity, now: Timestamp): BuildWords | undefined {
	const { release, commit } = build;
	if (release === undefined && commit === undefined) return undefined;
	const shown: string[] = [];
	const full: string[] = [];
	let ago: ReviewerMessage | undefined;
	if (release !== undefined) {
		shown.push(releaseTag(release));
		full.push(`diff delver ${releaseTag(release)}`);
	}
	if (commit !== undefined) {
		shown.push(shortCommit(commit));
		let built = `built from commit ${commit.commit}`;
		if (commit.committedAt !== undefined) {
			ago = describeTimeAgo(commit.committedAt, now);
			built += `, made ${describeExactTime(commit.committedAt)}`;
		}
		if (commit.changes) built += ', with changes not committed';
		full.push(built);
	}
	// The product's name is written in lowercase; a sentence that starts otherwise has a capital.
	const sentence = full.join(', ');
	return {
		text: reviewerMessage([...shown, ...(ago === undefined ? [] : [ago])].join(' · ')),
		named: reviewerMessage(shown.join(' · ')),
		ago,
		full: reviewerMessage(
			release === undefined ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}` : sentence
		)
	};
}
