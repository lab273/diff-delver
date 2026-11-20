import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** An absolute path on the local machine, such as a repository directory. */
export type AbsolutePath = Tiny<string, 'AbsolutePath'>;

export interface InvalidAbsolutePath {
	readonly kind: 'InvalidAbsolutePath';
	readonly value: string;
}

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Accepts a POSIX path starting with `/` or a Windows drive or UNC path. */
export function parseAbsolutePath(value: string): Result<AbsolutePath, InvalidAbsolutePath> {
	if (value.includes('\0') || !(value.startsWith('/') || WINDOWS_ABSOLUTE.test(value))) {
		return err({ kind: 'InvalidAbsolutePath', value });
	}
	return ok(value as AbsolutePath);
}
