import { NoteActionSchema, type NotesChangedView } from '#lib/api/schemas.ts';
import { PRIVATE, commentView, draftsRefused } from '#lib/server/api/comments.ts';
import { notesView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * The reviewer acts on the agent's notes (DESIGN 5) from a page that shows the
 * Delve's current version: dismisses one, promotes one into the draft as a
 * comment of their own, or brings back the notes they dismissed. Promoting
 * writes the draft, so every action needs a browser that may write it.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, NoteActionSchema);
	if (!parsed.ok) return parsed.error;
	const action = parsed.value;
	const service = locals.daemon.service;
	switch (action.action) {
		case 'dismiss': {
			const done = service.setNoteState(id.value, action.version, action.note, 'dismissed');
			return done.ok
				? answer({ notes: notesView(done.value), comment: null })
				: serviceFailure(done.error);
		}
		case 'bring-back': {
			const done = service.restoreNotes(id.value, action.version);
			return done.ok
				? answer({ notes: notesView(done.value), comment: null })
				: serviceFailure(done.error);
		}
		case 'promote': {
			const done = await service.promoteNote(id.value, action.version, action.note);
			if (!done.ok) return serviceFailure(done.error);
			return answer({
				notes: notesView(done.value.notes),
				comment: done.value.comment === undefined ? null : commentView(done.value.comment)
			});
		}
	}
};

function answer(body: NotesChangedView): Response {
	return Response.json(body, { headers: PRIVATE });
}
