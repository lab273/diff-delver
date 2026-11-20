import type { Tiny } from './tiny.ts';

/**
 * What a test timed, such as `building the refusal`, as `pnpm verify` names it in a warning.
 *
 * A label, not a checked value: any text may be one, and the type records what
 * the text is, so it cannot be passed where another kind of text is meant.
 */
export type MeasurementName = Tiny<string, 'MeasurementName'>;

/** Marks text as the name of what a test timed. */
export function measurementName(text: string): MeasurementName {
	return text as MeasurementName;
}
