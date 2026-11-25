/**
 * Each Delve's comments, and its overall review, kept by the tab and not by a page: a Delve's page is
 * made again whenever the reviewer leaves it by one of diff delver's own links
 * and comes back, and what they were writing must still be there (DESIGN 1.1,
 * commitment 7). So the comments of every Delve this tab has shown live here
 * for as long as the tab's document does, and the page asks for them by Delve.
 *
 * They are kept in this tab's memory and nowhere else: what is typed and not
 * saved is the reviewer's private text, so it is in no storage another page,
 * another tab or anything let in by a link could read. Loading the document
 * again, or closing the tab, is the one thing that would lose it, and then the
 * browser asks first.
 */
import type { ApiClient } from '#lib/api/client.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { Comments } from './comments.svelte.ts';

const kept = new Map<ReportId, Comments>();
let asksBeforeLeaving = false;

function unsaved(comments: Comments | undefined): boolean {
	if (comments === undefined) return false;
	return comments.overallUnsaved || comments.writing.some((writing) => writing.worthKeeping);
}

/** Whether something typed on a Delve's comments or overall review in this tab is not saved yet. */
export function hasUnsavedWords(id: ReportId): boolean {
	return unsaved(kept.get(id));
}

/**
 * The comments of a Delve as this tab holds them, made the first time they are
 * asked for. Where a page is drawn for one request and thrown away, as on the
 * server, nothing is kept.
 */
export function keptComments(id: ReportId, client: () => ApiClient): Comments {
	if (typeof window === 'undefined') return new Comments(id, client());
	const held = kept.get(id);
	if (held !== undefined) return held;
	const made = new Comments(id, client());
	kept.set(id, made);
	if (!asksBeforeLeaving) {
		asksBeforeLeaving = true;
		// On whichever page of diff delver the tab is, while any Delve has words not saved.
		window.addEventListener('beforeunload', (event) => {
			for (const comments of kept.values()) {
				if (unsaved(comments)) {
					event.preventDefault();
					return;
				}
			}
		});
	}
	return made;
}
