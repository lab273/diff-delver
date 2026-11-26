/**
 * The `agent_notes` table: the agent's labelled notes on lines of one version
 * (DESIGN 5), kept apart from the reviewer's draft. Their words are agent
 * text, sanitised when a page shows them. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { parseAgentNoteId, type AgentNoteId } from '#lib/core/agent-note-id.tiny.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import {
	NOTE_LABELS,
	type AgentNote,
	type NewNote,
	type NoteState
} from '#lib/core/review/agent-note.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRow, parseRows, repoPath, text, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z
	.object({
		id: whole(parseAgentNoteId),
		version: whole(parseRevisionNumber),
		label: z.enum(NOTE_LABELS),
		path: repoPath,
		side: z.enum(['old', 'new']),
		first: whole(parseLineNumber),
		last: whole(parseLineNumber),
		body: text(parseAgentMarkdown),
		state: z.enum(['waiting', 'dismissed', 'promoted'])
	})
	.refine(({ first, last }) => last >= first)
	.transform(({ id, version, label, path, side, first, last, body, state }): AgentNote => ({
		id,
		version,
		label,
		anchor: { path, side, first, last },
		text: body,
		state
	}));

const COLUMNS = `n.id, r.number AS version, n.label, n.path, n.side, n.first_line AS first,
	n.last_line AS last, n.body, n.state`;

/** A revision's notes, in the order they were added. */
export function agentNotesOf(
	q: Queries,
	revision: RevisionId
): Result<readonly AgentNote[], StoredRowInvalid> {
	return parseRows(
		'agent_notes',
		row,
		q.all(
			`SELECT ${COLUMNS} FROM revisions r JOIN agent_notes n ON r.id = n.revision_id
			 WHERE n.revision_id = ? ORDER BY n.id`,
			revision
		)
	);
}

/** One note of the report, on whichever version, or undefined when it has none with that id. */
export function agentNoteOf(
	q: Queries,
	report: ReportId,
	id: AgentNoteId
): Result<AgentNote | undefined, StoredRowInvalid> {
	const found = q.get(
		`SELECT ${COLUMNS} FROM revisions r JOIN agent_notes n ON r.id = n.revision_id
		 WHERE r.report_id = ? AND n.id = ?`,
		report,
		id
	);
	return found === undefined ? ok(undefined) : parseRow('agent_notes', row, found);
}

export function insertAgentNote(
	q: Queries,
	revision: RevisionId,
	note: NewNote,
	now: Timestamp
): void {
	q.run(
		`INSERT INTO agent_notes (revision_id, label, path, side, first_line, last_line, body, written_at, state)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`,
		revision,
		note.label,
		repoPathBytes(note.anchor.path),
		note.anchor.side,
		note.anchor.first,
		note.anchor.last,
		note.text,
		now
	);
}

/** Removes a revision's notes the reviewer has not acted on: the agent's own, to replace them. */
export function removeWaitingNotes(q: Queries, revision: RevisionId): number {
	return q.run("DELETE FROM agent_notes WHERE revision_id = ? AND state = 'waiting'", revision);
}

export function setNoteState(q: Queries, id: AgentNoteId, state: NoteState): void {
	q.run('UPDATE agent_notes SET state = ? WHERE id = ?', state, id);
}

/** Brings back every dismissed note of a revision, for the reviewer who wants them again. */
export function restoreDismissedNotes(q: Queries, revision: RevisionId): void {
	q.run(
		"UPDATE agent_notes SET state = 'waiting' WHERE revision_id = ? AND state = 'dismissed'",
		revision
	);
}
