import type { Tiny } from '../tiny.ts';

/**
 * A source in its one written form, such as `working-tree`, `main...feature-x`
 * or a pull request's address, which `parseSourceSpec` reads back to the same
 * source. A label: only `formatGitSourceSpec` and `formatSourceSpec` make one,
 * from a parsed source.
 */
export type SourceText = Tiny<string, 'SourceText'>;

/** Marks text as a source's written form; for `formatGitSourceSpec` and `formatSourceSpec`. */
export function asSourceText(text: string): SourceText {
	return text as SourceText;
}
