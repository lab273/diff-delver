import type { Tiny } from '../tiny.ts';

/**
 * A source in its one written form, such as `working-tree` or `main...feature-x`,
 * which `parseGitSourceSpec` reads back to the same source. A label: only
 * `formatGitSourceSpec` makes one, from a parsed source.
 */
export type GitSourceText = Tiny<string, 'GitSourceText'>;

/** Marks text as a source's written form; for `formatGitSourceSpec`. */
export function gitSourceText(text: string): GitSourceText {
	return text as GitSourceText;
}
