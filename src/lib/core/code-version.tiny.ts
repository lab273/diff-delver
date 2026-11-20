import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * Which build of diff delver a daemon runs: the package version and a hash of
 * the code it was built from, such as `0.0.1+1a2b3c4d5e6f`. Two daemons with the
 * same version run the same code, so a command can use a daemon only when its own
 * version is the same. 1 to 100 printable ASCII characters, no spaces.
 */
export type CodeVersion = Tiny<string, 'CodeVersion'>;

export interface InvalidCodeVersion {
	readonly kind: 'InvalidCodeVersion';
	readonly value: string;
}

export function parseCodeVersion(value: string): Result<CodeVersion, InvalidCodeVersion> {
	if (!/^[\x21-\x7e]{1,100}$/.test(value)) return err({ kind: 'InvalidCodeVersion', value });
	return ok(value as CodeVersion);
}
