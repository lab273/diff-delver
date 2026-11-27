import type { DiffSummary } from '#lib/api/schemas.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';

/** A Delve to ask about deleting (`DeleteDelve.svelte`). */
export interface DeleteTarget {
	readonly id: ReportId;
	/** What it is called in the question: "Uncommitted changes in shop". */
	readonly name: string;
	/** What deleting it frees, when it has been measured. */
	readonly disk: DiffSummary['disk'];
}
