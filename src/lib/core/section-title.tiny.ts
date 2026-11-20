import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A section's title, written by the agent: one line of plain text, such as
 * "Session expiry". Shown as text, never as Markdown.
 */
export type SectionTitle = Tiny<string, 'SectionTitle'>;

export type InvalidSectionTitleReason = 'blank' | 'too-long' | 'line-break' | 'malformed';

export interface InvalidSectionTitle {
	readonly kind: 'InvalidSectionTitle';
	readonly value: string;
	readonly reason: InvalidSectionTitleReason;
}

/** Long enough for any sensible title, short enough to fit a heading. */
export const MAX_SECTION_TITLE_LENGTH = 200;

/** Accepts one line that is not blank, not too long and well-formed Unicode. */
export function parseSectionTitle(value: string): Result<SectionTitle, InvalidSectionTitle> {
	const reason = problemOf(value);
	if (reason !== undefined) return err({ kind: 'InvalidSectionTitle', value, reason });
	return ok(value as SectionTitle);
}

function problemOf(value: string): InvalidSectionTitleReason | undefined {
	if (value.trim() === '') return 'blank';
	if (value.length > MAX_SECTION_TITLE_LENGTH) return 'too-long';
	if (/[\r\n\u2028\u2029]/.test(value)) return 'line-break';
	if (!value.isWellFormed()) return 'malformed';
	return undefined;
}
