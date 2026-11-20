import type { Tiny } from './tiny.ts';

/**
 * A test's full name, its describe blocks and its title, as a test report gives it.
 *
 * A label, not a checked value: any text may be one, and the type records what
 * the text is, so it cannot be passed where another kind of text is meant.
 */
export type TestName = Tiny<string, 'TestName'>;

/** Marks text as the name of a test. */
export function testName(text: string): TestName {
	return text as TestName;
}
