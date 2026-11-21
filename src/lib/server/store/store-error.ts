/**
 * What can go wrong with the snapshot store, and what the reviewer is told. Every
 * variant has its message; adding one without writing it does not compile.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { describeDiffOutputError, type DiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { shownRepoPath } from '#lib/core/shown-path.tiny.ts';
import type { ByteSize } from '#lib/core/byte-size.tiny.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { Side } from '#lib/core/side.tiny.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import { describeGitError, type GitError } from '../git/run-git.ts';

/** The data directory, or the stores folder inside it, could not be created or written. */
export interface DataDirectoryUnusable {
	readonly kind: 'DataDirectoryUnusable';
	readonly directory: AbsolutePath;
	/** The operating system's reason, such as `EACCES: permission denied`. */
	readonly reason: string;
}

/** No store with this id is in the data directory. */
export interface StoreNotFound {
	readonly kind: 'StoreNotFound';
	readonly store: StoreId;
}

/** The store has no snapshot with this id: it was never taken here, or it was deleted. */
export interface SnapshotNotFound {
	readonly kind: 'SnapshotNotFound';
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
}

/** git gave the store an answer diff delver cannot read, which means the store was changed by hand. */
export interface StoreDamaged {
	readonly kind: 'StoreDamaged';
	readonly store: StoreId;
	readonly detail: string;
}

export type StoreError =
	GitError | DataDirectoryUnusable | StoreNotFound | SnapshotNotFound | StoreDamaged;

/** What happened and what to do next, for the reviewer. */
export function describeStoreError(error: StoreError): ReviewerMessage {
	switch (error.kind) {
		case 'DataDirectoryUnusable':
			return reviewerMessage(
				`diff delver could not write to its data folder ${error.directory} (${error.reason}). Check that the folder exists and that you can write to it, or choose another data folder, then try again.`
			);
		case 'StoreNotFound':
			return reviewerMessage(
				`diff delver has no saved copy of this repository (store ${error.store}). It may have been deleted from the data folder. Open the repository again to take a new snapshot.`
			);
		case 'SnapshotNotFound':
			return reviewerMessage(
				`This snapshot of the changes is no longer saved (snapshot ${error.snapshot} in store ${error.store}); it may have been deleted. Open the source again to take a new one.`
			);
		case 'StoreDamaged':
			return reviewerMessage(
				`diff delver's saved copy of this repository is damaged: ${error.detail}. Move the folder stores/${error.store}.git in diff delver's data folder out of the way, then open the repository again: diff delver makes a new copy, and diffs whose changes were saved in the old one will say so.`
			);
		case 'GitNotFound':
		case 'GitTooOld':
		case 'NoSuchDirectory':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'MissingObject':
		case 'GitFailed':
			return describeGitError(error);
	}
}

/** The path names a directory in that tree, not a file. */
export interface PathIsDirectory {
	readonly kind: 'PathIsDirectory';
	readonly side: Side;
	readonly path: RepoPath;
}

/** The path is a submodule: its content lives in another repository. */
export interface PathIsSubmodule {
	readonly kind: 'PathIsSubmodule';
	readonly side: Side;
	readonly path: RepoPath;
}

/** Nothing is at that path in that tree. */
export interface PathNotFound {
	readonly kind: 'PathNotFound';
	readonly side: Side;
	readonly path: RepoPath;
}

/** The file is binary, so it has no lines to show. */
export interface FileIsBinary {
	readonly kind: 'FileIsBinary';
	readonly side: Side;
	readonly path: RepoPath;
}

/** The file is larger than the reader takes. */
export interface FileTooLarge {
	readonly kind: 'FileTooLarge';
	readonly side: Side;
	readonly path: RepoPath;
	readonly size: ByteSize;
	readonly limit: ByteSize;
}

export type FileLookupError = StoreError | PathNotFound | PathIsDirectory | PathIsSubmodule;
export type LinesError = FileLookupError | FileIsBinary;
export type SnapshotDiffError = StoreError | DiffOutputError;

function sideName(side: Side): string {
	switch (side) {
		case 'old':
			return 'the old version';
		case 'new':
			return 'the new version';
	}
}

/** What happened and what to do next, for the reviewer. */
export function describeLinesError(error: LinesError): ReviewerMessage {
	switch (error.kind) {
		case 'PathNotFound':
			return reviewerMessage(
				`${shownRepoPath(error.path)} does not exist in ${sideName(error.side)}. Check the path, or open it from the file list.`
			);
		case 'PathIsDirectory':
			return reviewerMessage(
				`${shownRepoPath(error.path)} is a folder in ${sideName(error.side)}, not a file. Open one of the files inside it.`
			);
		case 'PathIsSubmodule':
			return reviewerMessage(
				`${shownRepoPath(error.path)} is a submodule in ${sideName(error.side)}: its files belong to another repository, so only the commit it points at is shown. Open that repository to review its files.`
			);
		case 'FileIsBinary':
			return reviewerMessage(
				`${shownRepoPath(error.path)} is a binary file in ${sideName(error.side)}, so it has no lines to show.`
			);
		case 'GitNotFound':
		case 'GitTooOld':
		case 'NoSuchDirectory':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'MissingObject':
		case 'GitFailed':
		case 'DataDirectoryUnusable':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'StoreDamaged':
			return describeStoreError(error);
	}
}

/** What happened and what to do next, for the reviewer. */
export function describeSnapshotDiffError(error: SnapshotDiffError): ReviewerMessage {
	switch (error.kind) {
		case 'MalformedRawListing':
		case 'MalformedPatch':
		case 'PatchCountMismatch':
		case 'PatchMismatch':
			return describeDiffOutputError(error);
		case 'GitNotFound':
		case 'GitTooOld':
		case 'NoSuchDirectory':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'MissingObject':
		case 'GitFailed':
		case 'DataDirectoryUnusable':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'StoreDamaged':
			return describeStoreError(error);
	}
}
