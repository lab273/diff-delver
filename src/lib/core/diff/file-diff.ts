/**
 * The diff of one file between two trees, as the rest of diff delver sees it.
 * Built from git's output by `parseDiffTreeOutput`; never supplied by the agent.
 */
import type { BlobId } from '../blob-id.tiny.ts';
import type { FileMode } from '../file-mode.tiny.ts';
import type { FileStatus } from '../file-status.tiny.ts';
import type { HunkId } from '../hunk-id.tiny.ts';
import type { LineCount } from '../line-count.tiny.ts';
import type { LineNumber } from '../line-number.tiny.ts';
import type { LineText } from '../line-text.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Similarity } from '../similarity.tiny.ts';

/** One side of a file: where it is, its mode and its content's object id. */
export interface FileVersion {
	readonly path: RepoPath;
	readonly mode: FileMode;
	readonly blob: BlobId;
}

export interface FileDiff {
	/**
	 * The path the file is known by: its new path, or its old path when it was
	 * deleted. Unique within one diff, and what `assign` items name.
	 */
	readonly path: RepoPath;
	readonly status: FileStatus;
	/** The file in the base tree; absent when it was added. */
	readonly old: FileVersion | undefined;
	/** The file in the head tree; absent when it was deleted. */
	readonly new: FileVersion | undefined;
	/** For a rename or copy, how alike the two sides are. */
	readonly similarity: Similarity | undefined;
	readonly content: FileContent;
}

/**
 * What changed inside the file. A text change with no hunks (a pure rename, a mode
 * change, an empty file added or deleted) has no lines to show; nor do binary files
 * and submodules. Each of those has a single file-level unit.
 */
export type FileContent =
	| { readonly kind: 'text'; readonly hunks: readonly Hunk[] }
	| { readonly kind: 'binary' }
	| { readonly kind: 'submodule' };

/**
 * Where a hunk sits on one side, as in its `@@ -start,length +start,length @@`
 * header. When `length` is 0, `start` is the line after which the change sits,
 * and 0 means the top of the file.
 */
export interface HunkSpan {
	readonly start: LineCount;
	readonly length: LineCount;
}

export interface Hunk {
	readonly id: HunkId;
	readonly old: HunkSpan;
	readonly new: HunkSpan;
	/** The text git shows after the second `@@`, usually the enclosing function. Often empty. */
	readonly heading: LineText;
	readonly lines: readonly DiffLine[];
}

export type DiffLine = ContextLine | AddedLine | DeletedLine;

interface LineBase {
	readonly text: LineText;
	/** The file ends with this line and has no newline after it (`\ No newline at end of file`). */
	readonly noNewlineAtEnd: boolean;
}

/** An unchanged line shown for context. It belongs to no bucket. */
export interface ContextLine extends LineBase {
	readonly kind: 'context';
	readonly old: LineNumber;
	readonly new: LineNumber;
}

export interface AddedLine extends LineBase {
	readonly kind: 'added';
	readonly new: LineNumber;
}

export interface DeletedLine extends LineBase {
	readonly kind: 'deleted';
	readonly old: LineNumber;
}

/** The hunks of a file, or none when its change has no lines. */
export function hunksOf(file: FileDiff): readonly Hunk[] {
	switch (file.content.kind) {
		case 'text':
			return file.content.hunks;
		case 'binary':
		case 'submodule':
			return [];
	}
}
