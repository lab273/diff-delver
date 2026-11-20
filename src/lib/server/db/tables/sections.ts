/** The `sections` table: the sections of each revision, in reading order. The only code that sees its rows. */
import { z } from 'zod';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import type { Section } from '#lib/core/reports/report.ts';
import { map, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseSectionTitle } from '#lib/core/section-title.tiny.ts';
import { nullable, parseRows, text } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({
	id: text(parseSectionId),
	title: text(parseSectionTitle),
	summary: nullable(text(parseAgentMarkdown))
});

/** A revision's sections in reading order. */
export function sectionsOf(
	q: Queries,
	revision: RevisionId
): Result<readonly Section[], StoredRowInvalid> {
	return map(
		parseRows(
			'sections',
			row,
			q.all(
				'SELECT id, title, summary FROM sections WHERE revision_id = ? ORDER BY position, id',
				revision
			)
		),
		(rows) => rows.map((r) => ({ id: r.id, title: r.title, summary: r.summary }))
	);
}

/**
 * Sets a revision's sections to these, in this reading order: each is added or
 * updated in place, so assignments to it stay valid. Sections not listed must
 * hold no units; they are removed.
 */
export function replaceSections(
	q: Queries,
	revision: RevisionId,
	sections: readonly Section[]
): void {
	const kept = new Set<string>(sections.map((s) => s.id));
	for (const existing of q.all('SELECT id FROM sections WHERE revision_id = ?', revision)) {
		const id = existing.id;
		if (typeof id === 'string' && !kept.has(id)) {
			q.run('DELETE FROM sections WHERE revision_id = ? AND id = ?', revision, id);
		}
	}
	sections.forEach((section, position) => {
		q.run(
			`INSERT INTO sections (revision_id, id, title, summary, position) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (revision_id, id) DO UPDATE SET title = excluded.title, summary = excluded.summary, position = excluded.position`,
			revision,
			section.id,
			section.title,
			section.summary ?? null,
			position
		);
	});
}
