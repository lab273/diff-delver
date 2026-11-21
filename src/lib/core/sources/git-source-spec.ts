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
 *   request from `to` into `from` shows.
 */
import type { FileCount } from '../file-count.tiny.ts';
import { jsonQuoted } from '../json-quoted.ts';
import { gitSourceText, type GitSourceText } from './git-source-text.tiny.ts';
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
export function formatGitSourceSpec(spec: GitSourceSpec): GitSourceText {
	switch (spec.kind) {
		case 'working-tree':
			return gitSourceText('working-tree');
		case 'staged':
			return gitSourceText('staged');
		case 'commit':
			return gitSourceText(spec.revision);
		case 'range':
			return gitSourceText(`${spec.from}...${spec.to}`);
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

/** The source in plain words, as a title: "Uncommitted changes", "feature-x compared with main". */
export function describeGitSource(spec: GitSourceSpec): ReviewerMessage {
	switch (spec.kind) {
		case 'working-tree':
			return reviewerMessage('Uncommitted changes');
		case 'staged':
			return reviewerMessage('Staged changes');
		case 'commit':
			return reviewerMessage(
				spec.revision === HEAD || spec.revision === '@'
					? 'The last commit'
					: `Commit ${shortRevisionName(spec.revision)}`
			);
		case 'range': {
			const to =
				spec.to === HEAD || spec.to === '@' ? 'The checked-out commit' : shortRevisionName(spec.to);
			return reviewerMessage(`${to} compared with ${shortRevisionName(spec.from)}`);
		}
	}
}

/** "12 files", "1 file", "no files". */
export function describeFileCount(files: FileCount): string {
	if (files === 0) return 'no files';
	return files === 1 ? '1 file' : `${String(files)} files`;
}

/**
 * The source and its size, for a chooser: "Uncommitted changes (12 files)". With
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
