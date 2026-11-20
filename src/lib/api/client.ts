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
	ChangeCheckSchema,
	DaemonInfoSchema,
	DeletedSchema,
	EntryCodeSchema,
	DiffListSchema,
	DiffPageSchema,
	OpenResponseSchema,
	StartResponseSchema,
	StateChangeSchema,
	StoppingSchema,
	SuggestResponseSchema,
	UpdateResponseSchema,
	type ChangeCheckResponse,
	type DaemonInfo,
	type DeletedResponse,
	type EntryCodeResponse,
	type DiffList,
	type DiffPage,
	type OpenRequest,
	type OpenResponse,
	type StartRequest,
	type StartResponse,
	type StateChange,
	type Stopping,
	type SuggestResponse,
	type UpdateResponse
} from './schemas.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';

export type ApiError =
	/** The daemon answered with an error: its message says what happened and what to do. */
	| {
			readonly kind: 'refused';
			readonly status: number;
			/** The kind of error, such as `ReportNotFound`. */
			readonly reason: string;
			readonly message: ReviewerMessage;
	  }
	/** No answer: the daemon is not running, or the connection failed. */
	| { readonly kind: 'unreachable'; readonly detail: string }
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
			return err({
				kind: 'unreachable',
				detail:
					error instanceof Error
						? error.cause instanceof Error
							? error.cause.message
							: error.message
						: String(error)
			});
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

	loadDiff(id: ReportId): Promise<Result<DiffPage, ApiError>> {
		return this.#call('GET', `/api/diffs/${id}`, DiffPageSchema);
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

	stopDaemon(): Promise<Result<Stopping, ApiError>> {
		return this.#call('POST', '/api/daemon/stop', StoppingSchema);
	}
}
