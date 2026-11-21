import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** A remote of a repository, as `git remote` lists it, such as `origin`. */
export type RemoteName = Tiny<string, 'RemoteName'>;

export interface InvalidRemoteName {
	readonly kind: 'InvalidRemoteName';
	readonly value: string;
}

function hasControlOrSpace(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Accepts a name git could have made a remote with: not empty, not starting with
 * `-` (so never read as an option), with no space, control character or `..`.
 */
export function parseRemoteName(value: string): Result<RemoteName, InvalidRemoteName> {
	const valid =
		value !== '' &&
		!value.startsWith('-') &&
		!value.includes('..') &&
		value.isWellFormed() &&
		!hasControlOrSpace(value);
	return valid ? ok(value as RemoteName) : err({ kind: 'InvalidRemoteName', value });
}
