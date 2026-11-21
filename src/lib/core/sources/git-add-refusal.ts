/**
 * Why `git add --ignore-errors` left a file out of a working-tree snapshot,
 * read from what git printed, and said once per file in plain words.
 *
 * git prints one or two lines for each file it refuses, such as
 * `error: open("a"): Permission denied` and then `error: unable to index file
 * 'a'`. They are grouped by path and the most specific reason is kept. An
 * error line of a kind not known here is not shown as it is: the reviewer is
 * told that some other file was left out.
 *
 * git prints paths from the top of the working tree, as they are on disk. Pure.
 */
import { shownRepoPath } from '../shown-path.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';

export type AddRefusalReason =
	/** The file could not be opened or read; `because` is the system's reason, such as "permission denied". */
	| { readonly kind: 'unreadable'; readonly because: ReviewerMessage }
	/** A folder that could not be opened, so nothing in it was added. */
	| { readonly kind: 'unreadable-folder'; readonly because: ReviewerMessage }
	/** Not a file, folder or symbolic link: a named pipe, a socket or a device. */
	| { readonly kind: 'not-a-file' }
	/** A repository inside the working tree with no commit to record. */
	| { readonly kind: 'empty-repository' }
	/** git could not add it and gave no more specific reason. */
	| { readonly kind: 'not-added' };

export interface AddRefusal {
	readonly path: RepoPath;
	readonly reason: AddRefusalReason;
}

export interface AddRefusals {
	/** One per path, sorted by path. */
	readonly refusals: readonly AddRefusal[];
	/** git reported an error this module does not recognise. */
	readonly unrecognised: boolean;
}

/** How specific each reason is; a more specific one replaces a less specific one for the same path. */
function rank(reason: AddRefusalReason): number {
	return reason.kind === 'not-added' ? 0 : 1;
}

/** The system's reason as words in a sentence: "Permission denied" is "permission denied". */
function because(text: string): ReviewerMessage {
	return reviewerMessage(text.charAt(0).toLowerCase() + text.slice(1));
}

interface Pattern {
	readonly match: RegExp;
	readonly reason: (found: RegExpExecArray) => AddRefusalReason;
}

const PATTERNS: readonly Pattern[] = [
	{
		match: /^error: (?:open|read|readlink)\("(.+)"\): (.+)$/,
		reason: (found) => ({ kind: 'unreadable', because: because(found[2] ?? '') })
	},
	{
		match: /^error: (.+): can only add regular files, symbolic links or git-directories$/,
		reason: () => ({ kind: 'not-a-file' })
	},
	{
		match: /^error: '(.+)\/' does not have a commit checked out$/,
		reason: () => ({ kind: 'empty-repository' })
	},
	{
		match: /^error: unable to index file '(.+?)\/?'$/,
		reason: () => ({ kind: 'not-added' })
	},
	{
		match: /^warning: could not open directory '(.+)\/': (.+)$/,
		reason: (found) => ({ kind: 'unreadable-folder', because: because(found[2] ?? '') })
	}
];

/** The files git refused, from what `git add --ignore-errors` printed. */
export function parseAddRefusals(stderr: string): AddRefusals {
	const byPath = new Map<string, AddRefusal>();
	let unrecognised = false;
	for (const line of stderr.split('\n')) {
		let known = false;
		for (const pattern of PATTERNS) {
			const found = pattern.match.exec(line);
			const path = found === null ? undefined : parseRepoPath(found[1] ?? '');
			if (found === null || path === undefined || !path.ok) continue;
			known = true;
			const reason = pattern.reason(found);
			const before = byPath.get(path.value);
			if (before === undefined || rank(reason) > rank(before.reason)) {
				byPath.set(path.value, { path: path.value, reason });
			}
			break;
		}
		if (!known && line.startsWith('error: ')) unrecognised = true;
	}
	const refusals = [...byPath.values()].toSorted((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	);
	return { refusals, unrecognised };
}

/** One sentence for the reviewer: which file was left out, why, and what to do. */
export function describeAddRefusal(refusal: AddRefusal): ReviewerMessage {
	const path = shownRepoPath(refusal.path);
	switch (refusal.reason.kind) {
		case 'unreadable':
			return reviewerMessage(
				`Not included: ${path}, which could not be read (${refusal.reason.because}). Check that you can read it, then refresh.`
			);
		case 'unreadable-folder':
			return reviewerMessage(
				`Not included: the folder ${path}, which could not be opened (${refusal.reason.because}), so nothing in it is included. Check that you can open it, then refresh.`
			);
		case 'not-a-file':
			return reviewerMessage(
				`Not included: ${path}, which is not a file, folder or symbolic link (it may be a named pipe, a socket or a device), so it cannot be part of a snapshot.`
			);
		case 'empty-repository':
			return reviewerMessage(
				`Not included: ${path}, a repository inside this one with no commits yet, so there is no commit to record for it. Make a commit in it, or remove it, then refresh.`
			);
		case 'not-added':
			return reviewerMessage(
				`Not included: ${path}, which git could not add. Check that you can read it, then refresh.`
			);
	}
}

/** What the reviewer is told when git refused a file for a reason not recognised here. */
export const OTHER_FILES_LEFT_OUT = reviewerMessage(
	'Some other file could not be included, for a reason diff delver does not recognise. Check that every changed file can be read, then refresh.'
);

/** Every message for what `git add` refused, one per file. */
export function describeAddRefusals(found: AddRefusals): readonly ReviewerMessage[] {
	const messages = found.refusals.map(describeAddRefusal);
	return found.unrecognised ? [...messages, OTHER_FILES_LEFT_OUT] : messages;
}
