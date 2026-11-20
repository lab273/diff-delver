import type { Tiny } from './tiny.ts';

/**
 * What git wrote to its error output, in the C locale. Shown to the reviewer only
 * inside a message that says what it means. Any text is valid.
 */
export type GitStderr = Tiny<string, 'GitStderr'>;

export function gitStderr(text: string): GitStderr {
	return text as GitStderr;
}

/** The first line, which is where git puts its message. */
export function firstLineOf(stderr: GitStderr): GitStderr {
	return (stderr.trim().split('\n')[0] ?? '') as GitStderr;
}
