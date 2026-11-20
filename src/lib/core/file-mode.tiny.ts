import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A git tree entry mode, six octal digits as git writes them, such as `100644`. */
export type FileMode = Tiny<string, 'FileMode'>;

/** What a mode means. `none` is git's `000000`: the file does not exist on that side. */
export type FileModeKind = 'regular' | 'executable' | 'symlink' | 'submodule' | 'none' | 'other';

export interface InvalidFileMode {
	readonly kind: 'InvalidFileMode';
	readonly value: string;
}

export function parseFileMode(value: string): Result<FileMode, InvalidFileMode> {
	if (!/^[0-7]{6}$/.test(value)) return err({ kind: 'InvalidFileMode', value });
	return ok(value as FileMode);
}

export function fileModeKind(mode: FileMode): FileModeKind {
	switch (mode) {
		case '100644':
			return 'regular';
		case '100755':
			return 'executable';
		case '120000':
			return 'symlink';
		case '160000':
			return 'submodule';
		case '000000':
			return 'none';
		default:
			return 'other';
	}
}
