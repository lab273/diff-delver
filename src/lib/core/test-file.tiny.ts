import type { Tiny } from './tiny.ts';

/**
 * The file a test is in, relative to the repository, as `pnpm verify` shows it.
 *
 * A label, not a checked value: any text may be one, and the type records what
 * the text is, so it cannot be passed where another kind of text is meant.
 */
export type TestFile = Tiny<string, 'TestFile'>;

/** Marks text as the file of a test. */
export function testFile(text: string): TestFile {
	return text as TestFile;
}
