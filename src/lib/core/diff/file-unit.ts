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
import { shownRepoPath } from '../shown-path.tiny.ts';
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

/**
 * A mode's kind as a reviewer sees it: a file mode git no longer writes, such
 * as the legacy `100664`, is still a file, executable when anyone may run it.
 */
function shownKind(mode: FileMode): FileModeKind {
	const kind = fileModeKind(mode);
	if (kind !== 'other' || !/^100[0-7]{3}$/.test(mode)) return kind;
	return /[1357]/.test(mode.slice(3)) ? 'executable' : 'regular';
}

/** Whether a change of mode is only that: the file is the same kind of thing before and after. */
function sameKind(from: FileMode, to: FileMode): boolean {
	return shownKind(from) === shownKind(to);
}

/**
 * A change of mode or kind in plain words: "made executable", "became a link".
 * With `modes: false`, a change that is only one of mode is "mode changed",
 * for a place that shows the two modes beside the words.
 */
function describeMode(from: FileMode, to: FileMode, modes = true): string {
	const was = shownKind(from);
	const is = shownKind(to);
	if (was === 'regular' && is === 'executable') return 'made executable';
	if (was === 'executable' && is === 'regular') return 'no longer executable';
	if (sameKind(from, to)) return modes ? `its mode changed from ${from} to ${to}` : 'mode changed';
	return `became ${KIND_NAMES[is]}`;
}

function describeItself(change: FileItselfChange): string {
	switch (change.kind) {
		case 'renamed':
			return `renamed from ${shownRepoPath(change.from)}`;
		case 'copied':
			return `copied from ${shownRepoPath(change.from)}`;
		case 'mode':
			return describeMode(change.from, change.to);
	}
}

/** A change to a file's mode or kind, as git writes the modes, and in plain words. */
export interface ModeChange {
	readonly from: FileMode;
	readonly to: FileMode;
	/**
	 * "made executable", "no longer executable", "became a link", or "mode
	 * changed" when the file is the same kind of thing before and after; never
	 * the modes themselves, which are shown beside the words.
	 */
	readonly words: ReviewerMessage;
	/** Whether the file became another kind of thing (made executable, became a link), not only its mode changed. */
	readonly kindChanged: boolean;
}

/**
 * The change to a file's mode or kind, when it has one: what a reviewer must
 * not miss, since its lines cannot show it. Undefined for an added or deleted
 * file, whose mode is part of it.
 */
export function modeChangeOf(file: FileDiff): ModeChange | undefined {
	for (const change of fileItselfChanges(file)) {
		if (change.kind === 'mode') {
			return {
				from: change.from,
				to: change.to,
				words: reviewerMessage(describeMode(change.from, change.to, false)),
				kindChanged: !sameKind(change.from, change.to)
			};
		}
	}
	return undefined;
}

/** Whether a file's content changed: its text has lines, or it is not text. */
function contentChanged(file: FileDiff): boolean {
	const content = file.content;
	return content.kind !== 'text' || content.hunks.length > 0;
}

/**
 * How a file's lines changed, without what changed about the file itself:
 * "added", "deleted" or "changed". For a list's group that holds a file's
 * lines but not its file-level unit.
 */
export function describeFileLines(file: FileDiff): ReviewerMessage {
	switch (file.status) {
		case 'added':
			return reviewerMessage('added');
		case 'deleted':
			return reviewerMessage('deleted');
		case 'modified':
		case 'type-changed':
		case 'renamed':
		case 'copied':
			return reviewerMessage('changed');
	}
}

/** How the words for a file's change are given. */
export interface FileChangeWords {
	/** False leaves out a change of mode or kind, for a place that shows it on its own. */
	readonly withMode?: boolean;
	/**
	 * True when a binary file is known, from its bytes, to be an image the page
	 * shows as a picture on every side it has: it is then an "image", not a
	 * "binary file". Only its bytes can say so, so the list of files, and an
	 * agent, are told "binary file".
	 */
	readonly image?: boolean;
}

/**
 * How a file changed, as a list of files says it: "changed", "added",
 * "renamed from src/old.ts", "changed, renamed from src/old.ts", "changed,
 * made executable", "became a link", "added, binary file", or with `image`,
 * "added, image". A file whose name or mode changed says "changed" first when
 * its content changed too. With `withMode: false` it leaves out a change of
 * mode or kind, for a place that shows that on its own (`modeChangeOf`), and
 * may then be empty.
 */
export function describeFileChange(file: FileDiff, options: FileChangeWords = {}): ReviewerMessage {
	const parts: string[] = [];
	switch (file.status) {
		case 'added':
			parts.push('added');
			break;
		case 'deleted':
			parts.push('deleted');
			break;
		case 'modified':
			if (contentChanged(file) || fileItselfChanges(file).length === 0) parts.push('changed');
			break;
		case 'renamed':
		case 'copied':
			if (contentChanged(file)) parts.push('changed');
			break;
		case 'type-changed':
			break;
	}
	for (const change of fileItselfChanges(file)) {
		if (change.kind !== 'mode' || options.withMode !== false) parts.push(describeItself(change));
	}
	switch (file.content.kind) {
		case 'binary':
			parts.push(options.image === true ? 'image' : 'binary file');
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
 * "added, empty file", "renamed from src/old.ts"). `withMode: false` leaves
 * out a change of mode or kind, as `describeFileChange` does.
 */
export function describeFileUnit(file: FileDiff, options: FileChangeWords = {}): ReviewerMessage {
	const content = file.content;
	const hasLines = content.kind === 'text' && content.hunks.length > 0;
	if (hasLines) {
		return reviewerMessage(
			fileItselfChanges(file)
				.filter((change) => change.kind !== 'mode' || options.withMode !== false)
				.map(describeItself)
				.join(', ')
		);
	}
	const empty =
		content.kind === 'text' &&
		fileItselfChanges(file).length === 0 &&
		(file.status === 'added' || file.status === 'deleted');
	return empty
		? reviewerMessage(`${describeFileChange(file, options)}, empty file`)
		: describeFileChange(file, options);
}
