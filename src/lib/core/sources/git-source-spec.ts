/**
 * What a person can point diff delver at in a local git repository (DESIGN 3.1,
 * the first two rows of its table), and how it is written and described.
 *
 * - `working-tree`: the last commit against the files as they are now, staged or
 *   not, with untracked files and without ignored ones.
 * - `staged`: the last commit against the index.
 * - `commit`: a commit's first parent against it (the empty tree for a root
 *   commit).
 * - `range`: the merge base of `from` and `to` against `to`, which is what a pull
 *   request from `to` into `from` shows. A `from` that is git's empty tree
 *   (`EMPTY_TREE`) compares from nothing: every commit up to `to`, which is how
 *   a run of commits that starts at the repository's first commit is reviewed.
 */
import type { FileCount } from '../file-count.tiny.ts';
import { EMPTY_TREE } from '../object-format.ts';
import { jsonQuoted } from '../json-quoted.ts';
import { asSourceText, type SourceText } from './source-text.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { HEAD, parseRevision, type InvalidRevision, type Revision } from '../revision.tiny.ts';

export type GitSourceSpec =
	| { readonly kind: 'working-tree' }
	| { readonly kind: 'staged' }
	| { readonly kind: 'commit'; readonly revision: Revision }
	| { readonly kind: 'range'; readonly from: Revision; readonly to: Revision };

export const WORKING_TREE: GitSourceSpec = { kind: 'working-tree' };
export const STAGED: GitSourceSpec = { kind: 'staged' };

/** What was typed could not be read as a source. */
export interface InvalidSourceSpec {
	readonly kind: 'InvalidSourceSpec';
	readonly text: string;
	/** Absent when nothing was typed. */
	readonly revision: InvalidRevision | undefined;
}

/** The words that name the two sources that are not revisions. Matched in any case. */
const WORDS: ReadonlyMap<string, GitSourceSpec> = new Map<string, GitSourceSpec>([
	['working-tree', WORKING_TREE],
	['worktree', WORKING_TREE],
	['uncommitted', WORKING_TREE],
	['staged', STAGED],
	['cached', STAGED],
	['--staged', STAGED],
	['--cached', STAGED]
]);

/**
 * Reads a source as a person would type it:
 *
 * - `working-tree` (or `worktree`, `uncommitted`) and `staged` (or `cached`,
 *   `--staged`, `--cached`), in any case;
 * - `A...B` or `A..B`: a range, the merge base of A and B against B. Both
 *   spellings mean what a pull request shows, which is what people want when they
 *   name two branches; an empty end is `HEAD`, as in git;
 * - anything else: one commit, such as `HEAD`, `abc1234` or `v1.2^`.
 *
 * Surrounding space is ignored. A branch that happens to be called `staged` is
 * reached as `refs/heads/staged`.
 */
export function parseGitSourceSpec(text: string): Result<GitSourceSpec, InvalidSourceSpec> {
	const typed = text.trim();
	if (typed === '') return err({ kind: 'InvalidSourceSpec', text, revision: undefined });
	const word = WORDS.get(typed.toLowerCase());
	if (word !== undefined) return ok(word);
	const separator = typed.includes('...') ? '...' : typed.includes('..') ? '..' : undefined;
	if (separator === undefined) {
		const revision = parseRevision(typed);
		return revision.ok
			? ok({ kind: 'commit', revision: revision.value })
			: err({ kind: 'InvalidSourceSpec', text, revision: revision.error });
	}
	const at = typed.indexOf(separator);
	const end = (part: string): Result<Revision, InvalidRevision> =>
		part === '' ? ok(HEAD) : parseRevision(part);
	const from = end(typed.slice(0, at));
	if (!from.ok) return err({ kind: 'InvalidSourceSpec', text, revision: from.error });
	const to = end(typed.slice(at + separator.length));
	if (!to.ok) return err({ kind: 'InvalidSourceSpec', text, revision: to.error });
	return ok({ kind: 'range', from: from.value, to: to.value });
}

/**
 * The source in its one written form, which `parseGitSourceSpec` reads back to the
 * same source: `working-tree`, `staged`, the revision, or `from...to`. Use it
 * wherever a source is stored or compared as text, such as a report's identity.
 */
export function formatGitSourceSpec(spec: GitSourceSpec): SourceText {
	switch (spec.kind) {
		case 'working-tree':
			return asSourceText('working-tree');
		case 'staged':
			return asSourceText('staged');
		case 'commit':
			return asSourceText(spec.revision);
		case 'range':
			return asSourceText(`${spec.from}...${spec.to}`);
	}
}

/** Whether two specs are the same source. */
export function sameGitSourceSpec(a: GitSourceSpec, b: GitSourceSpec): boolean {
	return formatGitSourceSpec(a) === formatGitSourceSpec(b);
}

/** A ref name as people say it: `refs/heads/main` is `main`, `refs/remotes/origin/main` is `origin/main`. */
export function shortRevisionName(revision: Revision): string {
	for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
		if (revision.startsWith(prefix) && revision.length > prefix.length) {
			return revision.slice(prefix.length);
		}
	}
	return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(revision) ? revision.slice(0, 7) : revision;
}

/**
 * Whether a branch's short name would be read as something else: `HEAD`, the
 * checked-out commit, or one of the words that name a source, such as
 * `staged`. Such a branch is never called by its short name alone.
 */
export function isMisleadingBranchName(name: string): boolean {
	return name === 'HEAD' || WORDS.has(name.toLowerCase());
}

const LOCAL_BRANCH = 'refs/heads/';

/**
 * A revision as a title or a sentence names it: `shortRevisionName`, but a
 * local branch whose short name would be read as something else is "the local
 * branch HEAD", so that it is never taken for the checked-out commit.
 */
export function revisionInWords(revision: Revision): string {
	const short = shortRevisionName(revision);
	return revision.startsWith(LOCAL_BRANCH) && isMisleadingBranchName(short)
		? `the local branch ${short}`
		: short;
}

/** `text` with its first letter a capital, to start a title or a sentence with a phrase. */
function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a range end is git's empty tree, in either object format: a range from nothing. */
export function isEmptyTreeRevision(revision: Revision): boolean {
	const text: string = revision;
	return text === EMPTY_TREE.sha1 || text === EMPTY_TREE.sha256;
}

const FULL_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** The source in plain words, as a title: "Uncommitted changes", "feature-x compared with main". */
export function describeGitSource(spec: GitSourceSpec): ReviewerMessage {
	switch (spec.kind) {
		case 'working-tree':
			return reviewerMessage('Uncommitted changes');
		case 'staged':
			return reviewerMessage('Staged changes');
		case 'commit': {
			if (spec.revision === HEAD || spec.revision === '@')
				return reviewerMessage('The last commit');
			const named = revisionInWords(spec.revision);
			return reviewerMessage(
				// A phrase, not a name: "The last commit of the local branch HEAD".
				named === shortRevisionName(spec.revision)
					? `Commit ${named}`
					: `The last commit of ${named}`
			);
		}
		case 'range': {
			// Two commit ids. A run of commits chosen from a list is written so, and
			// its report is titled by its commits (`reportTitle`); these are the words
			// before it is opened, and for ids that are not such a run.
			if (FULL_ID.test(spec.to) && isEmptyTreeRevision(spec.from)) {
				return reviewerMessage(`Every commit up to ${shortRevisionName(spec.to)}`);
			}
			if (FULL_ID.test(spec.to) && FULL_ID.test(spec.from)) {
				return reviewerMessage(
					`Commit ${shortRevisionName(spec.to)} compared with commit ${shortRevisionName(spec.from)}`
				);
			}
			const checkedOut = spec.to === HEAD || spec.to === '@';
			const named = checkedOut ? 'the checked-out commit' : revisionInWords(spec.to);
			// A branch's name is kept as it is written; a phrase starts with a capital.
			const isName = !checkedOut && named === shortRevisionName(spec.to);
			return reviewerMessage(
				`${isName ? named : capitalised(named)} compared with ${revisionInWords(spec.from)}`
			);
		}
	}
}

/** "12 files", "1 file", "no files". */
export function describeFileCount(files: FileCount): string {
	if (files === 0) return 'no files';
	return files === 1 ? '1 file' : `${String(files)} files`;
}

/**
 * The source and its size, for the start page's choice: "Uncommitted changes (12 files)". With
 * no size, when it could not be counted, the source alone.
 */
export function describeGitSourceWithSize(
	spec: GitSourceSpec,
	files: FileCount | undefined
): ReviewerMessage {
	const title = describeGitSource(spec);
	return files === undefined ? title : reviewerMessage(`${title} (${describeFileCount(files)})`);
}

/** What happened and what to do next, for the reviewer. */
export function describeInvalidSourceSpec(error: InvalidSourceSpec): ReviewerMessage {
	const help =
		'Give a commit (such as HEAD or abc1234), two branches to compare (such as main...feature-x), "staged" or "working-tree".';
	if (error.revision === undefined) return reviewerMessage(`Nothing was given to open. ${help}`);
	const shown = jsonQuoted(error.text.trim());
	switch (error.revision.reason) {
		case 'empty':
			return reviewerMessage(`${shown} is missing a revision on one side. ${help}`);
		case 'starts-with-dash':
			return reviewerMessage(
				`${shown} starts with "-", which git would read as an option. ${help}`
			);
		case 'has-range':
			return reviewerMessage(`${shown} has more than one range in it. ${help}`);
		case 'surrounding-space':
			return reviewerMessage(
				`${shown} has spaces around one of its revisions. Remove them and try again.`
			);
		case 'control-character':
			return reviewerMessage(
				`${shown} holds a character that cannot be part of a revision. ${help}`
			);
	}
}
