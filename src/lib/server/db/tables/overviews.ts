/**
 * The `overviews` table: what the change does, in reading order, as the agent
 * wrote it for one version of a diff (DESIGN 7.1). Kept as written: it is
 * agent text, sanitised when a page shows it. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseAgentMarkdown, type AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRows, text } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({ markdown: text(parseAgentMarkdown) });

/** A revision's overview; undefined when the agent has written none. */
export function overviewOf(
	q: Queries,
	revision: RevisionId
): Result<AgentMarkdown | undefined, StoredRowInvalid> {
	const rows = parseRows(
		'overviews',
		row,
		q.all('SELECT markdown FROM overviews WHERE revision_id = ?', revision)
	);
	if (!rows.ok) return rows;
	return ok(rows.value[0]?.markdown);
}

/** Sets a revision's overview, replacing the one it had. */
export function setOverview(q: Queries, revision: RevisionId, markdown: AgentMarkdown): void {
	q.run(
		`INSERT INTO overviews (revision_id, markdown) VALUES (?, ?)
		 ON CONFLICT (revision_id) DO UPDATE SET markdown = excluded.markdown`,
		revision,
		markdown
	);
}
