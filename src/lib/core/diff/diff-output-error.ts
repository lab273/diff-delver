import type { FileStatus } from '../file-status.tiny.ts';
import type { ByteOffset } from '../byte-offset.tiny.ts';
import type { FileCount } from '../file-count.tiny.ts';
import type { LineNumber } from '../line-number.tiny.ts';
import type { PatchCount } from '../patch-count.tiny.ts';
import { escapedRepoPath } from '../path-bytes.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';

/**
 * git's diff output could not be read. Each of these means diff delver and git
 * disagree about the format, which is a bug to report, not something the reviewer
 * caused.
 */
export type DiffOutputError =
	| {
			/** The NUL-separated file listing did not have the expected shape. */
			readonly kind: 'MalformedRawListing';
			/** Byte offset in the output where reading stopped. */
			readonly offset: ByteOffset;
			readonly detail: string;
	  }
	| {
			/** The patch text did not have the expected shape. */
			readonly kind: 'MalformedPatch';
			/** 1-based line of the patch text where reading stopped. */
			readonly line: LineNumber;
			readonly detail: string;
	  }
	| {
			/** The listing and the patch text describe different numbers of files. */
			readonly kind: 'PatchCountMismatch';
			readonly listedFiles: FileCount;
			readonly expectedPatches: PatchCount;
			readonly foundPatches: PatchCount;
	  }
	| {
			/** A file's patch does not match how the listing says the file changed. */
			readonly kind: 'PatchMismatch';
			readonly path: RepoPath;
			readonly status: FileStatus;
			readonly detail: string;
	  };

/** What happened and what to do next, for the reviewer. */
export function describeDiffOutputError(error: DiffOutputError): ReviewerMessage {
	return reviewerMessage(diffOutputErrorText(error));
}

function diffOutputErrorText(error: DiffOutputError): string {
	const report =
		'This is a bug in diff delver, not in your repository. Please report it with your git version.';
	switch (error.kind) {
		case 'MalformedRawListing':
			return `git's list of changed files could not be read (at byte ${error.offset}: ${error.detail}). ${report}`;
		case 'MalformedPatch':
			return `git's diff could not be read (line ${error.line}: ${error.detail}). ${report}`;
		case 'PatchCountMismatch':
			return `git listed ${error.listedFiles} changed files, which should give ${error.expectedPatches} patches, but its diff has ${error.foundPatches}. ${report}`;
		case 'PatchMismatch':
			return `git's diff of ${escapedRepoPath(error.path)} does not match its status (${error.status}): ${error.detail}. ${report}`;
	}
}
