/**
 * Words of a command as a person pastes them into a terminal: a POSIX shell
 * (sh, bash, zsh, and fish for what is written here).
 *
 * - A word made only of characters no shell reads specially is written as it
 *   is. Any other is put in single quotes, where nothing is special, with each
 *   single quote in it written `'\''`. So a folder with spaces, quotes, `$`, a
 *   backslash or a line break pastes as that folder and never as anything else.
 * - A path inside the person's home folder is written from `~`, which those
 *   shells replace with the home folder when it starts a word and is not
 *   quoted: `~/src/'my shop'`. It is shorter, and it is the same text on every
 *   machine that keeps the folder in the same place under home.
 *
 * Windows' own shells quote differently and are not written for here.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One word, quoted when it needs to be. */
export function shellWord(word: string): string {
	if (PLAIN_WORD.test(word)) return word;
	return `'${word.replaceAll("'", "'\\''")}'`;
}

/** The part of `path` under `home`, without the slash between; undefined when it is not inside it. */
function underHome(path: string, home: AbsolutePath | undefined): string | undefined {
	if (home === undefined || !home.startsWith('/')) return undefined;
	const base = home.endsWith('/') ? home.slice(0, -1) : home;
	// Home at the root abbreviates nothing.
	if (base === '') return undefined;
	if (path === base) return '';
	return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
}

/** One word, with a path under the home folder written from `~`. */
export function shellPath(word: string, home: AbsolutePath | undefined): string {
	const rest = underHome(word, home);
	if (rest === undefined) return shellWord(word);
	return rest === '' ? '~' : `~/${shellWord(rest)}`;
}

/** A whole command line. */
export function shellCommand(words: readonly string[], home: AbsolutePath | undefined): string {
	return words.map((word) => shellPath(word, home)).join(' ');
}

/**
 * A folder as a sentence names it, not for pasting: from `~` when it is under
 * the home folder, and otherwise whole.
 */
export function folderInWords(path: AbsolutePath, home: AbsolutePath | undefined): string {
	const rest = underHome(path, home);
	if (rest === undefined) return path;
	return rest === '' ? '~' : `~/${rest}`;
}
