/**
 * The reviewer's comments on one Delve, as its page holds them: the saved
 * draft, read from the daemon, and what is being written and not saved yet.
 * It is made by the page and outlives every viewer, so an update, a regroup or
 * a file put away never loses what was typed (DESIGN 1.1, commitment 7): each
 * piece of writing is drawn under its lines while they are on the page, and
 * in the list of comments when they are not.
 */
import { describeApiError, type ApiClient } from '#lib/api/client.ts';
import type { AddDraftComment, DraftCommentView } from '#lib/api/schemas.ts';
import type { EscapedPath } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { isCommentBody, MAX_COMMENT_LENGTH } from '#lib/core/review/draft-comment.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';

/** Lines of one side of a file, in the version they are numbered in. */
export type CommentPlace = Omit<AddDraftComment, 'body'>;

function samePlace(a: CommentPlace, b: CommentPlace): boolean {
	return (
		a.version === b.version &&
		a.anchor.path === b.anchor.path &&
		a.anchor.side === b.anchor.side &&
		a.anchor.first === b.anchor.first &&
		a.anchor.last === b.anchor.last
	);
}

/** One comment being written: a new one, or a saved one whose words are being changed. */
export class Writing {
	/** Its place among the things being written, which never changes. */
	readonly key: number;
	/** The saved comment whose words these replace; undefined for a new comment. */
	readonly editing: DraftCommentView | undefined;
	/** The lines it is on. A new comment's move when the reviewer chooses lines of a newer version. */
	place: CommentPlace;
	body: string;
	/** Why the last save did not happen, in place. */
	problem = $state('');
	/** The version the page showed when a save was refused because the Delve had a newer one. */
	behindOn = $state.raw<RevisionNumber>();
	saving = $state(false);
	/** How many places among the diff's lines draw its box now. */
	inDiff = $state(0);
	/** How many comments in the open list of comments draw its box now, as one being changed there. */
	inList = $state(0);
	/** Counts each time its box is asked to take the keyboard. */
	focusAsked = $state(0);
	/** How many of those a box has answered, so each is answered once. */
	focusGiven = 0;

	constructor(key: number, place: CommentPlace, editing?: DraftCommentView) {
		this.key = key;
		this.place = $state.raw(place);
		this.editing = editing;
		this.body = $state(editing?.body ?? '');
	}

	/** Whether there is something here a careless press must not throw away. */
	get worthKeeping(): boolean {
		return this.editing === undefined ? this.body.trim() !== '' : this.body !== this.editing.body;
	}
}

/** What a list or a file's lines draw of the comments on one version of one file. */
export interface CommentsHere {
	readonly saved: readonly DraftCommentView[];
	readonly writing: readonly Writing[];
}

export type SaveOutcome =
	{ readonly kind: 'saved'; readonly comment: DraftCommentView } | { readonly kind: 'not-saved' };

/** Why a comment was not deleted, and whether because the Delve has a newer version than the page shows. */
export interface NotDeleted {
	readonly message: string;
	readonly behind: boolean;
}

export class Comments {
	readonly id: ReportId;
	readonly #client: ApiClient;
	/** The saved draft, oldest first; undefined until it has been read. */
	saved = $state.raw<readonly DraftCommentView[]>();
	/** The daemon's time when the draft was last read, to say how long ago. */
	now = $state.raw<Timestamp>();
	loading = $state(false);
	/** Why the draft could not be read. */
	problem = $state('');
	writing = $state.raw<readonly Writing[]>([]);
	/** What just happened, for a screen reader: "Comment saved." */
	said = $state('');
	#keys = 0;
	#reading: Promise<void> | undefined;

	constructor(id: ReportId, client: ApiClient) {
		this.id = id;
		this.#client = client;
	}

	/** Reads the saved draft; a read already under way is the one waited for. */
	async load(): Promise<void> {
		this.#reading ??= this.#read().finally(() => (this.#reading = undefined));
		await this.#reading;
	}

	async #read(): Promise<void> {
		this.loading = true;
		const read = await this.#client.draftComments(this.id);
		this.loading = false;
		if (!read.ok) {
			this.problem = describeApiError(read.error);
			return;
		}
		this.problem = '';
		this.saved = read.value.comments;
		this.now = read.value.now;
	}

	/** What is on one version of one file, saved and being written. */
	on(version: RevisionNumber, path: EscapedPath): CommentsHere {
		const there = ({ version: on, anchor }: CommentPlace): boolean =>
			on === version && anchor.path === path;
		return {
			saved: (this.saved ?? []).filter(there),
			writing: this.writing.filter((w) => w.editing === undefined && there(w.place))
		};
	}

	/** The new comments whose lines are in another version than the page shows: they wait for new lines. */
	waitingForLines(shown: RevisionNumber): readonly Writing[] {
		return this.writing.filter((w) => w.editing === undefined && w.place.version !== shown);
	}

	/**
	 * Starts a comment on lines of the version shown. If one is being written
	 * there already, that one takes the keyboard. If a new comment still waits
	 * for lines, because the version it was written on is no longer shown, it
	 * moves here with its words, the oldest first: that is how the reviewer
	 * keeps what they typed across an update.
	 */
	start(place: CommentPlace): Writing {
		const there = this.writing.find((w) => w.editing === undefined && samePlace(w.place, place));
		const waiting = this.waitingForLines(place.version)[0];
		const writing = there ?? waiting ?? new Writing((this.#keys += 1), place);
		if (there === undefined && waiting !== undefined) {
			waiting.place = place;
			waiting.problem = '';
			waiting.behindOn = undefined;
		}
		if (!this.writing.includes(writing)) this.writing = [...this.writing, writing];
		writing.focusAsked += 1;
		return writing;
	}

	/**
	 * Starts changing a saved comment's words, in a box that starts with them, or
	 * goes back to the box already open for it.
	 */
	edit(comment: DraftCommentView): Writing {
		const there = this.changing(comment);
		const writing =
			there ??
			new Writing((this.#keys += 1), { version: comment.version, anchor: comment.anchor }, comment);
		if (there === undefined) this.writing = [...this.writing, writing];
		writing.focusAsked += 1;
		return writing;
	}

	/** The box open on a saved comment's words, if there is one. */
	changing(comment: DraftCommentView): Writing | undefined {
		return this.writing.find((w) => w.editing?.id === comment.id);
	}

	/**
	 * Deletes a saved comment, from a page that shows the Delve's current
	 * version. One the daemon no longer has is gone already, which is what was
	 * asked. Otherwise it stays, with why.
	 */
	async remove(comment: DraftCommentView, shown: RevisionNumber): Promise<NotDeleted | undefined> {
		const deleted = await this.#client.deleteDraftComment(this.id, comment.id, { version: shown });
		if (
			!deleted.ok &&
			!(deleted.error.kind === 'refused' && deleted.error.reason === 'CommentNotFound')
		) {
			return {
				message: describeApiError(deleted.error),
				behind: deleted.error.kind === 'refused' && deleted.error.reason === 'VersionOutOfDate'
			};
		}
		this.saved = (this.saved ?? []).filter((c) => c.id !== comment.id);
		this.writing = this.writing.filter((w) => w.editing?.id !== comment.id);
		this.said = 'Comment deleted.';
		return undefined;
	}

	/** Puts away something being written, with its words. */
	discard(writing: Writing): void {
		if (writing.saving) return;
		this.writing = this.writing.filter((w) => w !== writing);
	}

	/**
	 * Saves a new comment on the version the page shows, or a saved comment's
	 * new words from a page that shows the current version. One that is refused
	 * stays as it was typed, with why; when the Delve has moved on, it says so
	 * and waits for the page to show the new version.
	 */
	async save(writing: Writing, shown: RevisionNumber): Promise<SaveOutcome> {
		const editing = writing.editing;
		if (writing.saving || (editing === undefined && writing.place.version !== shown)) {
			return { kind: 'not-saved' };
		}
		if (!isCommentBody(writing.body)) {
			writing.problem =
				writing.body.trim() === ''
					? 'Write a comment before saving.'
					: `This comment is too long to save: keep it to ${String(MAX_COMMENT_LENGTH)} characters.`;
			return { kind: 'not-saved' };
		}
		writing.problem = '';
		writing.saving = true;
		const saved =
			editing === undefined
				? await this.#client.addDraftComment(this.id, { ...writing.place, body: writing.body })
				: await this.#client.editDraftComment(this.id, editing.id, {
						version: shown,
						body: writing.body
					});
		writing.saving = false;
		if (!saved.ok) {
			writing.problem = describeApiError(saved.error);
			writing.behindOn =
				saved.error.kind === 'refused' && saved.error.reason === 'VersionOutOfDate'
					? shown
					: undefined;
			return { kind: 'not-saved' };
		}
		this.saved =
			editing === undefined
				? [...(this.saved ?? []), saved.value]
				: (this.saved ?? []).map((c) => (c.id === editing.id ? saved.value : c));
		this.discard(writing);
		this.said = editing === undefined ? 'Comment saved.' : 'Comment changed.';
		// Read again for the daemon's time, and for what another tab saved meanwhile.
		void this.load();
		return { kind: 'saved', comment: saved.value };
	}
}
