/**
 * The agent's writing as something to read (DESIGN 8.1): its overview of the
 * change and each section's summary are unread until the reviewer has been to
 * them and moved on. Which ones were read is the reviewer's, kept per Delve by
 * the text read, so a text read stays read in every version that has it and a
 * rewritten one is unread again.
 */
import type { SectionId } from '../section-id.tiny.ts';

/** One piece of the agent's writing: its overview, or a section's summary. */
export type SummaryPlace =
	{ readonly kind: 'overview' } | { readonly kind: 'section'; readonly section: SectionId };

/** What a version's writing is, read or not: the overview's, and each section's that has a summary. */
export interface SummariesRead {
	/** Whether the overview was read; false when there is none. */
	readonly overview: boolean;
	/** The sections whose summary was read. */
	readonly sections: ReadonlySet<SectionId>;
}

/** Nothing read. */
export const NOTHING_READ: SummariesRead = { overview: false, sections: new Set() };
