/**
 * Borrowing another repository's objects read-only, as git's "alternates". Paths
 * are quoted the way git reads them, so one with a colon, quote, backslash or
 * newline survives in the file and in the environment variable alike.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';

/** A path quoted as git reads an alternates entry. */
export function quotedAlternate(path: AbsolutePath): string {
	return `"${path.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`;
}

/** A line of an `objects/info/alternates` file. */
export function alternatesLine(path: AbsolutePath): string {
	return `${quotedAlternate(path)}\n`;
}

/**
 * The environment that lets one git command read the objects in `objects` as
 * well as its own, and never fetch a missing one from a promisor remote. Only
 * for commands that write no objects: git freshens (touches the file of) an
 * object it is asked to write that an alternate already has.
 */
export function borrowObjects(objects: AbsolutePath): Readonly<Record<string, string>> {
	return { GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedAlternate(objects), GIT_NO_LAZY_FETCH: '1' };
}
