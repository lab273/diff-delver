import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * The name of a commit's author, as git gives it with `%an`: text from the
 * repository, shown as text with what cannot be seen written out, never an
 * email address.
 */
export type AuthorName = Tiny<string, 'AuthorName'>;

export interface InvalidAuthorName {
	readonly kind: 'InvalidAuthorName';
	readonly value: string;
}

/** Accepts one line of well-formed text, possibly empty: a commit may name no author. */
export function parseAuthorName(value: string): Result<AuthorName, InvalidAuthorName> {
	if (value.includes('\n') || value.includes('\0') || !value.isWellFormed()) {
		return err({ kind: 'InvalidAuthorName', value });
	}
	return ok(value as AuthorName);
}

/**
 * Any text as an author's name, for a list that must show every commit: a line
 * break or NUL becomes a space, and text that is not well formed is made so.
 */
export function authorNameOf(value: string): AuthorName {
	return value.toWellFormed().replaceAll(/[\n\0]/g, ' ') as AuthorName;
}
