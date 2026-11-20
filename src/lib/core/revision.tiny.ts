import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A git revision as a person typed it: a branch, tag, commit id or expression such
 * as `HEAD~2`. Not checked against any repository; git resolves it when a
 * snapshot is taken, so the same revision can name different commits over time.
 */
export type Revision = Tiny<string, 'Revision'>;

export type InvalidRevisionReason =
	| 'empty'
	/** Starts with `-`, so git would read it as an option. */
	| 'starts-with-dash'
	/** Has `..`, which separates the two ends of a range. */
	| 'has-range'
	| 'surrounding-space'
	| 'control-character';

export interface InvalidRevision {
	readonly kind: 'InvalidRevision';
	readonly value: string;
	readonly reason: InvalidRevisionReason;
}

/** Whether the text has a C0 control character or DEL, none of which a ref name can hold. */
function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function parseRevision(value: string): Result<Revision, InvalidRevision> {
	const reason = problemOf(value);
	if (reason !== undefined) return err({ kind: 'InvalidRevision', value, reason });
	return ok(value as Revision);
}

function problemOf(value: string): InvalidRevisionReason | undefined {
	if (value === '') return 'empty';
	if (value.trim() !== value) return 'surrounding-space';
	if (hasControlCharacter(value)) return 'control-character';
	if (value.startsWith('-')) return 'starts-with-dash';
	if (value.includes('..')) return 'has-range';
	return undefined;
}

/** `HEAD`: the commit checked out now. */
export const HEAD = 'HEAD' as Revision;
