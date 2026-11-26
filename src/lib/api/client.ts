/**
 * The one typed client of the daemon's API, used by the pages (with SvelteKit's
 * `fetch`, so a page rendered on the server makes its requests in-process), by
 * the command and by tests (with the daemon's address and its token).
 *
 * Every call returns a `Result`: the response parsed with its schema, or an
 * `ApiError` with a message for the reviewer. A refused request carries the
 * daemon's own message; one that never got an answer, or got one this client
 * cannot read, says so.
 */
import type { z } from 'zod';
import type { DaemonToken } from '#lib/core/daemon-token.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import {
	ApiErrorBodySchema,
	DraftCommentSchema,
	NotesChangedSchema,
	type NoteAction,
	type NotesChangedView,
	DraftCommentsSchema,
	JustFinishedSchema,
	FinishedReviewsSchema,
	ReviewPreviewSchema,
	OverallReviewSchema,
	type OverallReviewView,
	type SaveOverallReview,
	type FinishReview,
	type JustFinishedView,
	type FinishedReviewsView,
	type ReviewPreviewView,
	type DraftCommentView,
	type DraftCommentsView,
	type AddDraftComment,
	type DeleteDraftComment,
	type EditDraftComment,
	ChangeCheckSchema,
	CommitsSchema,
	HistorySchema,
	RemoteCheckSchema,
	PullRequestsSchema,
	RunSizeSchema,
	type CommitsQuery,
	type CommitsView,
	type HistoryQuery,
	type HistoryView,
	type RemoteCheckRequest,
	type RemoteCheckView,
	type PullRequestsRequest,
	type PullRequestsView,
	type RunSizeQuery,
	type RunSizeView,
	DaemonInfoSchema,
	DeletedSchema,
	EntryCodeSchema,
	DiffListSchema,
	DiffPageSchema,
	DiffRefreshSchema,
	LinesSchema,
	FileMatchesSchema,
	FileReaderSchema,
	type FileMatch,
	type FileReaderView,
	MarkedSchema,
	PartLinesSchema,
	ColoursSchema,
	DiffSearchSchema,
	type DiffSearchQuery,
	type DiffSearchView,
	SettingsSchema,
	type SettingsView,
	type SettingChangeRequest,
	type ColoursQuery,
	type ColoursView,
	OpenResponseSchema,
	StartResponseSchema,
	StateChangeSchema,
	ReviewWindowSchema,
	AgentSortingSchema,
	StoppingSchema,
	SuggestResponseSchema,
	UpdateResponseSchema,
	type ChangeCheckResponse,
	type DaemonInfo,
	type DeletedResponse,
	type EntryCodeResponse,
	type DiffList,
	type DiffPage,
	type ImageQuery,
	type LinesQuery,
	type LinesView,
	type Marked,
	type MarkReviewedRequest,
	type PartLines,
	type PartQuery,
	type ReviewWindow,
	type AgentSorting,
	type ViewName,
	type OpenRequest,
	type OpenResponse,
	type StartRequest,
	type StartResponse,
	type StateChange,
	type Stopping,
	type StopRequest,
	type SuggestResponse,
	type UpdateResponse
} from './schemas.ts';
import type { DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { groupKeyId } from '#lib/core/group-key-id.tiny.ts';
import { writeSpans } from '#lib/core/viewer/line-spans.ts';

export type ApiError =
	/** The daemon answered with an error: its message says what happened and what to do. */
	| {
			readonly kind: 'refused';
			readonly status: number;
			/** The kind of error, such as `ReportNotFound`. */
			readonly reason: string;
			readonly message: ReviewerMessage;
	  }
	/** No answer, and none to a check that it is running: the daemon has stopped, or cannot be reached. */
	| { readonly kind: 'unreachable'; readonly detail: string }
	/**
	 * No answer to this request, though the daemon answers: the browser gave up
	 * on it, such as when it had too many under way.
	 */
	| { readonly kind: 'interrupted'; readonly detail: string }
	/** An answer this client cannot read, from another build of diff delver. */
	| { readonly kind: 'unreadable'; readonly status: number; readonly detail: string };

export function describeApiError(error: ApiError): ReviewerMessage {
	switch (error.kind) {
		case 'refused':
			return error.message;
		case 'unreachable':
			return reviewerMessage(
				`diff delver is not answering (${error.detail}). It may have stopped: run diff-delver in a terminal, in your repository, to start it again.`
			);
		case 'interrupted':
			return reviewerMessage(
				`This did not reach diff delver (${error.detail}), though diff delver is running. Try again.`
			);
		case 'unreadable':
			return reviewerMessage(
				`diff delver sent an answer this page cannot read (${error.detail}). It may have been updated while the page was open: reload the page. If that does not help, run diff-delver again in a terminal.`
			);
	}
}

export interface ClientOptions {
	/** The fetch to use: SvelteKit's in a load function, the global one elsewhere. */
	readonly fetch: typeof fetch;
	/** The daemon's address, such as `http://127.0.0.1:43210`, or '' for the page's own. */
	readonly base: string;
	/** The token, for callers that are not the browser, which has its cookie. */
	readonly token?: DaemonToken;
}

type Method = 'GET' | 'POST' | 'DELETE';

export class ApiClient {
	readonly #options: ClientOptions;

	constructor(options: ClientOptions) {
		this.#options = options;
	}

	async #call<T>(
		method: Method,
		path: string,
		schema: z.ZodType<T>,
		body?: unknown
	): Promise<Result<T, ApiError>> {
		const headers: Record<string, string> = { accept: 'application/json' };
		// Every change is sent as JSON, with or without a body: never as a form, which
		// SvelteKit refuses from a caller with no Origin, such as the command.
		if (method !== 'GET') headers['content-type'] = 'application/json';
		if (this.#options.token !== undefined)
			headers['authorization'] = `Bearer ${this.#options.token}`;
		let response: Response;
		try {
			response = await this.#options.fetch(`${this.#options.base}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
		} catch (error) {
			const detail =
				error instanceof Error
					? error.cause instanceof Error
						? error.cause.message
						: error.message
					: String(error);
			// Only a daemon that does not answer either has stopped; one that answers
			// was not reached by this request for some other reason.
			return err({ kind: (await this.#answers()) ? 'interrupted' : 'unreachable', detail });
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			return err({
				kind: 'unreadable',
				status: response.status,
				detail: `HTTP ${String(response.status)}, not JSON`
			});
		}
		if (!response.ok) {
			const refused = ApiErrorBodySchema.safeParse(json);
			return refused.success
				? err({
						kind: 'refused',
						status: response.status,
						reason: refused.data.error.kind,
						message: refused.data.error.message
					})
				: err({
						kind: 'unreadable',
						status: response.status,
						detail: `HTTP ${String(response.status)}`
					});
		}
		const parsed = schema.safeParse(json);
		if (parsed.success) return ok(parsed.data);
		const issue = parsed.error.issues[0];
		return err({
			kind: 'unreadable',
			status: response.status,
			detail: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'not as expected'}`
		});
	}

	/** Whether the daemon answers at all, after a request that got no answer. */
	async #answers(): Promise<boolean> {
		try {
			const response = await this.#options.fetch(`${this.#options.base}/api/daemon`, {
				headers: {
					accept: 'application/json',
					...(this.#options.token === undefined
						? {}
						: { authorization: `Bearer ${this.#options.token}` })
				}
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	listDiffs(): Promise<Result<DiffList, ApiError>> {
		return this.#call('GET', '/api/diffs', DiffListSchema);
	}

	start(request: StartRequest): Promise<Result<StartResponse, ApiError>> {
		return this.#call('POST', '/api/start', StartResponseSchema, request);
	}

	open(request: OpenRequest): Promise<Result<OpenResponse, ApiError>> {
		return this.#call('POST', '/api/open', OpenResponseSchema, request);
	}

	/** What could be opened in a folder; with `asked`, also whether that source can be. */
	suggest(directory: string, asked?: string): Promise<Result<SuggestResponse, ApiError>> {
		const query = new URLSearchParams({ directory });
		if (asked !== undefined) query.set('asked', asked);
		return this.#call('GET', `/api/suggest?${query.toString()}`, SuggestResponseSchema);
	}

	/** A repository's branches, and when it last fetched; with `find`, the branches whose name holds it. */
	history(query: HistoryQuery): Promise<Result<HistoryView, ApiError>> {
		const params = new URLSearchParams({ directory: query.directory });
		if (query.find !== '') params.set('find', query.find);
		return this.#call('GET', `/api/history?${params.toString()}`, HistorySchema);
	}

	/** A page of a branch's commits, from `from` and `onMain` (a page's `next`) or its newest. */
	commits(query: CommitsQuery): Promise<Result<CommitsView, ApiError>> {
		const params = new URLSearchParams({ directory: query.directory, branch: query.branch });
		if (query.from !== undefined) params.set('from', query.from);
		if (query.onMain !== undefined) params.set('onMain', String(query.onMain));
		return this.#call('GET', `/api/history/commits?${params.toString()}`, CommitsSchema);
	}

	/** The size of the diff a run of commits makes. */
	runSize(query: RunSizeQuery): Promise<Result<RunSizeView, ApiError>> {
		const params = new URLSearchParams({ directory: query.directory, to: query.to });
		if (query.from !== undefined) params.set('from', query.from);
		return this.#call('GET', `/api/history/size?${params.toString()}`, RunSizeSchema);
	}

	/** Asks the repository's remotes what they have. A network call: only when the person asks. */
	checkRemotes(request: RemoteCheckRequest): Promise<Result<RemoteCheckView, ApiError>> {
		return this.#call('POST', '/api/history/check', RemoteCheckSchema, request);
	}

	/** The repository's open pull requests on GitHub: a network call, only when the person asks. */
	pullRequests(request: PullRequestsRequest): Promise<Result<PullRequestsView, ApiError>> {
		return this.#call('POST', '/api/history/pull-requests', PullRequestsSchema, request);
	}

	/** A diff's page: of its newest version, or of `version`, the one a page shows. */
	loadDiff(
		id: ReportId,
		view: ViewName = 'sections',
		version?: RevisionNumber
	): Promise<Result<DiffPage, ApiError>> {
		const query = new URLSearchParams();
		if (view !== 'sections') query.set('view', view);
		if (version !== undefined) query.set('version', String(version));
		const text = query.toString();
		return this.#call('GET', `/api/diffs/${id}${text === '' ? '' : `?${text}`}`, DiffPageSchema);
	}

	/** Reads the pinned frame only if it changed since the one on screen. */
	refreshDiff(
		id: ReportId,
		view: ViewName,
		version: RevisionNumber,
		frame: string
	): Promise<Result<DiffPage | null, ApiError>> {
		const query = new URLSearchParams({ view, version: String(version), since: frame });
		return this.#call('GET', `/api/diffs/${id}?${query.toString()}`, DiffRefreshSchema);
	}

	/** One part's lines, of the version the page shows. */
	readPart(id: ReportId, part: PartQuery): Promise<Result<PartLines, ApiError>> {
		const query = new URLSearchParams({
			version: String(part.version),
			assignments: part.assignments,
			view: part.view,
			group: groupKeyId(part.group),
			path: part.path
		});
		return this.#call('GET', `/api/diffs/${id}/part?${query.toString()}`, PartLinesSchema);
	}

	/** Searches the version the page shows, part by part. */
	searchDiff(id: ReportId, search: DiffSearchQuery): Promise<Result<DiffSearchView, ApiError>> {
		const query = new URLSearchParams({
			version: String(search.version),
			assignments: search.assignments,
			view: search.view,
			text: search.text,
			matchCase: String(search.matchCase),
			changedOnly: String(search.changedOnly)
		});
		return this.#call('GET', `/api/diffs/${id}/search?${query.toString()}`, DiffSearchSchema);
	}

	/** How the person likes diffs shown. */
	readSettings(): Promise<Result<SettingsView, ApiError>> {
		return this.#call('GET', '/api/settings', SettingsSchema);
	}

	/** Changes one setting; gives the settings as they now are. */
	changeSetting(change: SettingChangeRequest): Promise<Result<SettingsView, ApiError>> {
		return this.#call('POST', '/api/settings', SettingsSchema, change);
	}

	/** The colours of lines of each side of a file, of the version the page shows. */
	readColours(id: ReportId, colours: ColoursQuery): Promise<Result<ColoursView, ApiError>> {
		const query = new URLSearchParams({
			version: String(colours.version),
			path: colours.path,
			old: writeSpans(colours.old),
			new: writeSpans(colours.new)
		});
		if (colours.exact !== undefined) query.set('exact', colours.exact);
		return this.#call('GET', `/api/diffs/${id}/colours?${query.toString()}`, ColoursSchema);
	}

	searchFiles(
		id: ReportId,
		version: RevisionNumber,
		name: string
	): Promise<Result<FileMatch[], ApiError>> {
		const query = new URLSearchParams({ version: String(version), name });
		return this.#call('GET', `/api/diffs/${id}/files?${query}`, FileMatchesSchema);
	}

	readFile(id: ReportId, file: LinesQuery): Promise<Result<FileReaderView, ApiError>> {
		const query = new URLSearchParams({
			version: String(file.version),
			path: file.path,
			side: file.side,
			first: String(file.first),
			last: String(file.last)
		});
		return this.#call('GET', `/api/diffs/${id}/file?${query}`, FileReaderSchema);
	}

	/**
	 * The address of one side of an image of the version the page shows, for an
	 * `<img>`, which the browser fetches with the page's own cookie.
	 */
	imageAddress(id: ReportId, image: ImageQuery): string {
		const query = new URLSearchParams({
			version: String(image.version),
			side: image.side,
			path: image.path
		});
		return `${this.#options.base}/api/diffs/${id}/image?${query.toString()}`;
	}

	/** Lines of one side of a file, of the version the page shows, for unchanged lines a part opens. */
	readLines(id: ReportId, lines: LinesQuery): Promise<Result<LinesView, ApiError>> {
		const query = new URLSearchParams({
			version: String(lines.version),
			side: lines.side,
			path: lines.path,
			first: String(lines.first),
			last: String(lines.last)
		});
		return this.#call('GET', `/api/diffs/${id}/lines?${query.toString()}`, LinesSchema);
	}

	/** The reviewer's whole draft: every comment, on whichever version, oldest first. */
	draftComments(id: ReportId): Promise<Result<DraftCommentsView, ApiError>> {
		return this.#call('GET', `/api/diffs/${id}/comments`, DraftCommentsSchema);
	}

	addDraftComment(
		id: ReportId,
		request: AddDraftComment
	): Promise<Result<DraftCommentView, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/comments`, DraftCommentSchema, request);
	}

	/** Changes a comment's words, from a page that shows the Delve's current version. */
	editDraftComment(
		id: ReportId,
		comment: DraftCommentId,
		request: EditDraftComment
	): Promise<Result<DraftCommentView, ApiError>> {
		return this.#call(
			'POST',
			`/api/diffs/${id}/comments/${String(comment)}`,
			DraftCommentSchema,
			request
		);
	}

	/** Deletes a comment, from a page that shows the Delve's current version; gives what it was. */
	deleteDraftComment(
		id: ReportId,
		comment: DraftCommentId,
		request: DeleteDraftComment
	): Promise<Result<DraftCommentView, ApiError>> {
		return this.#call(
			'DELETE',
			`/api/diffs/${id}/comments/${String(comment)}`,
			DraftCommentSchema,
			request
		);
	}

	/** Replaces the words of the draft's overall review, on the words the page read. */
	saveOverallReview(
		id: ReportId,
		request: SaveOverallReview
	): Promise<Result<OverallReviewView, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/overall`, OverallReviewSchema, request);
	}

	/** Dismisses, promotes or brings back the agent's notes, from a page that shows the current version. */
	changeNotes(id: ReportId, request: NoteAction): Promise<Result<NotesChangedView, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/notes`, NotesChangedSchema, request);
	}

	/** What finishing the draft now would hand over, for a page that shows `version`. */
	previewReview(
		id: ReportId,
		version: RevisionNumber
	): Promise<Result<ReviewPreviewView, ApiError>> {
		return this.#call(
			'GET',
			`/api/diffs/${id}/reviews/preview?version=${String(version)}`,
			ReviewPreviewSchema
		);
	}

	/** Finishes the draft the page showed as the Delve's next review. */
	finishReview(id: ReportId, request: FinishReview): Promise<Result<JustFinishedView, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/reviews`, JustFinishedSchema, request);
	}

	/** The Delve's finished reviews, oldest first. */
	reviews(id: ReportId): Promise<Result<FinishedReviewsView, ApiError>> {
		return this.#call('GET', `/api/diffs/${id}/reviews`, FinishedReviewsSchema);
	}

	/** Marks a part, a file or a group of the version the page shows as reviewed, or not. */
	markReviewed(id: ReportId, request: MarkReviewedRequest): Promise<Result<Marked, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/reviewed`, MarkedSchema, request);
	}

	/** Whether the diff has moved on from the version `seen`, which a page shows, or its files have. */
	checkForChanges(
		id: ReportId,
		seen?: RevisionNumber
	): Promise<Result<ChangeCheckResponse, ApiError>> {
		const query = seen === undefined ? '' : `?seen=${String(seen)}`;
		return this.#call('GET', `/api/diffs/${id}/changes${query}`, ChangeCheckSchema);
	}

	/** Brings the diff up to date with its files. */
	updateDiff(id: ReportId): Promise<Result<UpdateResponse, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/update`, UpdateResponseSchema);
	}

	closeDiff(id: ReportId): Promise<Result<StateChange, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/close`, StateChangeSchema);
	}

	reopenDiff(id: ReportId): Promise<Result<StateChange, ApiError>> {
		return this.#call('POST', `/api/diffs/${id}/reopen`, StateChangeSchema);
	}

	deleteDiff(id: ReportId): Promise<Result<DeletedResponse, ApiError>> {
		return this.#call('DELETE', `/api/diffs/${id}`, DeletedSchema);
	}

	daemonInfo(): Promise<Result<DaemonInfo, ApiError>> {
		return this.#call('GET', '/api/daemon', DaemonInfoSchema);
	}

	/** A single-use code that lets a browser in, for an address the command opens. */
	entryCode(): Promise<Result<EntryCodeResponse, ApiError>> {
		return this.#call('POST', '/api/entry', EntryCodeSchema);
	}

	/**
	 * Asks diff delver to open a Delve (or the list of them) in the person's own
	 * browser, in a window that may write their drafts; what became of asking.
	 */
	openReviewWindow(diff: ReportId | null): Promise<Result<ReviewWindow, ApiError>> {
		return this.#call('POST', '/api/review-window', ReviewWindowSchema, { diff });
	}

	/** How to have a coding agent sort this Delve: what to copy, for this daemon and this Delve. */
	agentSorting(id: ReportId): Promise<Result<AgentSorting, ApiError>> {
		return this.#call('GET', `/api/diffs/${id}/agent`, AgentSortingSchema);
	}

	/** Asks the daemon to stop, saying why, for its log. */
	stopDaemon(request: StopRequest): Promise<Result<Stopping, ApiError>> {
		return this.#call('POST', '/api/daemon/stop', StoppingSchema, request);
	}
}
