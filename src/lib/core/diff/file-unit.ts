/**
 * The file-level unit (DESIGN 4.1): when a file has one, and what a person reads
 * for it.
 *
 * A file has a file-level unit, beside any changed lines, exactly when:
 *
 * - its change has no lines at all: a binary file, a submodule, an empty file
 *   added or deleted, or a change of name or mode only; or
 * - something about the file itself changed, which a line-by-line reading cannot
 *   show:
 *   - its name: git calls it `renamed` (the old path is gone) or `copied` (the
 *     old path is still there, and only the differences from it are shown as
 *     lines);
 *   - its mode or its kind: it exists on both sides with a different mode, such
 *     as becoming executable, or git calls it `type-changed`, such as a file
 *     becoming a link.
 *
 * A file that is added or deleted, with lines, has no file-level unit merely for
 * being added or deleted: its lines are the whole of its change. Neither has an
 * added file for its mode, even an executable one: its mode is part of the new
 * file, not a change to a file that was there.
 */
import { fileModeKind, type FileMode, type FileModeKind } from '../file-mode.tiny.ts';
import { escapedRepoPath } from '../path-bytes.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { FileDiff } from './file-diff.ts';

/** One thing about a file itself that changed. */
export type FileItselfChange =
	| { readonly kind: 'renamed'; readonly from: RepoPath }
	| { readonly kind: 'copied'; readonly from: RepoPath }
	| { readonly kind: 'mode'; readonly from: FileMode; readonly to: FileMode };

/** What changed about the file itself: its name, its mode or its kind. Empty when nothing did. */
export function fileItselfChanges(file: FileDiff): readonly FileItselfChange[] {
	const changes: FileItselfChange[] = [];
	const { old, new: now } = file;
	if (old === undefined || now === undefined) return changes;
	switch (file.status) {
		case 'renamed':
			changes.push({ kind: 'renamed', from: old.path });
			break;
		case 'copied':
			changes.push({ kind: 'copied', from: old.path });
			break;
		case 'added':
		case 'deleted':
		case 'modified':
		case 'type-changed':
			break;
	}
	if (old.mode !== now.mode) changes.push({ kind: 'mode', from: old.mode, to: now.mode });
	return changes;
}

/** Whether a file has a file-level unit, given whether its change has lines (see the top). */
export function hasFileUnit(file: FileDiff, hasLines: boolean): boolean {
	return !hasLines || fileItselfChanges(file).length > 0;
}

const KIND_NAMES: Readonly<Record<FileModeKind, string>> = {
	regular: 'a file',
	executable: 'an executable file',
	symlink: 'a link',
	submodule: 'a submodule',
	none: 'nothing',
	other: 'a special file'
};

/** A change of mode or kind in plain words: "made executable", "became a link". */
function describeMode(from: FileMode, to: FileMode): string {
	const was = fileModeKind(from);
	const is = fileModeKind(to);
	if (was === 'regular' && is === 'executable') return 'made executable';
	if (was === 'executable' && is === 'regular') return 'no longer executable';
	if (was === is) return `its mode changed from ${from} to ${to}`;
	return `became ${KIND_NAMES[is]}`;
}

function describeItself(change: FileItselfChange): string {
	switch (change.kind) {
		case 'renamed':
			return `renamed from ${escapedRepoPath(change.from)}`;
		case 'copied':
			return `copied from ${escapedRepoPath(change.from)}`;
		case 'mode':
			return describeMode(change.from, change.to);
	}
}

/**
 * How a file changed, as a list of files says it: "changed", "added",
 * "renamed from src/old.ts", "changed, made executable", "became a link",
 * "added, binary file".
 */
export function describeFileChange(file: FileDiff): ReviewerMessage {
	const parts: string[] = [];
	switch (file.status) {
		case 'added':
			parts.push('added');
			break;
		case 'deleted':
			parts.push('deleted');
			break;
		case 'modified': {
			const content = file.content;
			const edited = content.kind !== 'text' || content.hunks.length > 0;
			if (edited || fileItselfChanges(file).length === 0) parts.push('changed');
			break;
		}
		case 'type-changed':
			break;
		case 'renamed':
		case 'copied':
			break;
	}
	for (const change of fileItselfChanges(file)) parts.push(describeItself(change));
	switch (file.content.kind) {
		case 'binary':
			parts.push('binary file');
			break;
		case 'submodule':
			parts.push('submodule');
			break;
		case 'text':
			break;
	}
	return reviewerMessage(parts.join(', '));
}

/**
 * What the file-level unit stands for, in plain words, for the place it is
 * shown and ticked. Beside changed lines it is what changed about the file
 * itself ("made executable", "renamed from src/old.ts"); for a file whose
 * change has no lines it is the whole change ("changed, binary file",
 * "added, empty file", "renamed from src/old.ts").
 */
export function describeFileUnit(file: FileDiff): ReviewerMessage {
	const content = file.content;
	const hasLines = content.kind === 'text' && content.hunks.length > 0;
	if (hasLines) return reviewerMessage(fileItselfChanges(file).map(describeItself).join(', '));
	const empty =
		content.kind === 'text' &&
		fileItselfChanges(file).length === 0 &&
		(file.status === 'added' || file.status === 'deleted');
	return empty
		? reviewerMessage(`${describeFileChange(file)}, empty file`)
		: describeFileChange(file);
}
