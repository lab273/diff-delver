import { err, ok, type Result } from './result.ts';

/**
 * How a file changed between the two trees. A change of mode only, such as making
 * a file executable, is `modified`; `type-changed` is a change of kind, such as a
 * regular file becoming a symbolic link.
 */
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type-changed';

export interface InvalidFileStatus {
	readonly kind: 'InvalidFileStatus';
	readonly value: string;
}

/** Accepts git's one-letter status from raw diff output: `A`, `D`, `M`, `R`, `C` or `T`. */
export function parseGitStatusLetter(value: string): Result<FileStatus, InvalidFileStatus> {
	switch (value) {
		case 'A':
			return ok('added');
		case 'D':
			return ok('deleted');
		case 'M':
			return ok('modified');
		case 'R':
			return ok('renamed');
		case 'C':
			return ok('copied');
		case 'T':
			return ok('type-changed');
		default:
			return err({ kind: 'InvalidFileStatus', value });
	}
}
