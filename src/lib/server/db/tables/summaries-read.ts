/**
 * The `summaries_read` table: which texts of the agent's overview and of its
 * section summaries the reviewer has read in each Delve
 * (`core/review/summary-read.ts`), by a hash of the text, so the same text is
 * read in every version and a rewritten one is unread again. The only code
 * that sees its rows.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { map, type Result } from '#lib/core/result.ts';
import type { SummaryPlace } from '#lib/core/review/summary-read.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseRows } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

/** The overview's row has no section. */
const OVERVIEW = '';

const row = z.object({
	section: z.string().refine((s) => s === OVERVIEW || parseSectionId(s).ok),
	hash: z.string().regex(/^[0-9a-f]{64}$/)
});

function columnOf(place: SummaryPlace): string {
	return place.kind === 'overview' ? OVERVIEW : place.section;
}

function hashOf(text: AgentMarkdown): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Whether a text of the agent's was read, in this Delve. */
export type ReadCheck = (place: SummaryPlace, text: AgentMarkdown) => boolean;

/** What the Delve's reviewer has read of the agent's writing. */
export function summariesReadOf(q: Queries, report: ReportId): Result<ReadCheck, StoredRowInvalid> {
	return map(
		parseRows(
			'summaries_read',
			row,
			q.all(
				'SELECT section_id AS section, text_hash AS hash FROM summaries_read WHERE report_id = ?',
				report
			)
		),
		(rows) => {
			const read = new Set(rows.map((r) => `${r.section}\u0000${r.hash}`));
			return (place, text) => read.has(`${columnOf(place)}\u0000${hashOf(text)}`);
		}
	);
}

/** Records that the reviewer read this text of the agent's; reading it again changes nothing. */
export function markSummaryRead(
	q: Queries,
	report: ReportId,
	place: SummaryPlace,
	text: AgentMarkdown
): void {
	q.run(
		`INSERT INTO summaries_read (report_id, section_id, text_hash) VALUES (?, ?, ?)
		 ON CONFLICT DO NOTHING`,
		report,
		columnOf(place),
		hashOf(text)
	);
}
