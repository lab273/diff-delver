import type { Tiny } from './tiny.ts';

/**
 * Where in an issue record a finding is, such as `notes` or `comments[2].text`.
 *
 * A label, not a checked value: any text may be one, and the type records what
 * the text is, so it cannot be passed where another kind of text is meant.
 */
export type FieldPath = Tiny<string, 'FieldPath'>;

/** Marks text as a path to a field of an issue record. */
export function fieldPath(text: string): FieldPath {
	return text as FieldPath;
}
