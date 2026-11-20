/**
 * The daemon's HTTP API: one Zod schema for each request and each response,
 * written once. The routes parse what they are sent with the request schemas and
 * build values of the response types; the client (`client.ts`) parses what it
 * receives with the response schemas, so the page and any test get the same
 * domain values, tiny types included, that the route sent.
 *
 * Optional values are `null` in JSON, never left out, so a value and its JSON
 * have the same keys.
 */
import { z } from 'zod';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { parseCodeVersion } from '#lib/core/code-version.tiny.ts';
import { parseFileCount } from '#lib/core/file-count.tiny.ts';
import { parseEntryCode } from '#lib/core/entry-code.tiny.ts';
import { parseLineCount } from '#lib/core/line-count.tiny.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import { parseEscapedPath } from '#lib/core/path-bytes.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { ok, err, type Result } from '#lib/core/result.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseSectionTitle } from '#lib/core/section-title.tiny.ts';
import type { GitSourceText } from '#lib/core/sources/git-source-text.tiny.ts';
import { formatGitSourceSpec, parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { parseUnitCount } from '#lib/core/unit-count.tiny.ts';

/** A value made by a tiny type's parse function. */
function parsed<I, T>(base: z.ZodType<I>, parse: (value: I) => Result<T, unknown>): z.ZodType<T> {
	return base.transform((value, context) => {
		const result = parse(value);
		if (result.ok) return result.value;
		context.addIssue({ code: 'custom', message: `${JSON.stringify(value)} is not valid here` });
		return z.NEVER;
	});
}

function sourceText(text: string): Result<GitSourceText, unknown> {
	const spec = parseGitSourceSpec(text);
	return spec.ok ? ok(formatGitSourceSpec(spec.value)) : err(spec.error);
}

const message = z.string().transform(reviewerMessage);
const reportId = parsed(z.string(), parseReportId);
const timestamp = parsed(z.number(), parseTimestamp);
const fileCount = parsed(z.number(), parseFileCount);
const lineCount = parsed(z.number(), parseLineCount);
const unitCount = parsed(z.number(), parseUnitCount);
/** A version of a diff, as the page numbers them: 1 for the first, 2 after the first update. */
const version = parsed(z.number(), parseRevisionNumber);
const escapedPath = parsed(z.string(), parseEscapedPath);
const absolutePath: z.ZodType<AbsolutePath> = parsed(z.string(), parseAbsolutePath);
/** A source in its one written form (`formatGitSourceSpec`), such as `working-tree` or `main...feature`. */
const source = parsed(z.string(), sourceText);

// ── Shared parts ─────────────────────────────────────────────────────────────

export const DiffSummarySchema = z.object({
	id: reportId,
	/** The source in plain words: "Uncommitted changes". */
	title: message,
	/** The repository's folder name. */
	repository: message,
	state: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('open') }),
		z.object({ kind: z.literal('closed'), reason: message })
	]),
	lastActivityAt: timestamp,
	size: z.object({ files: fileCount, added: lineCount, removed: lineCount }),
	/** In words: "3 files changed, 40 lines added and 12 removed". */
	sizeText: message,
	progress: z.object({
		counted: unitCount,
		reviewed: unitCount,
		ignored: unitCount,
		uncategorised: unitCount
	}),
	/** In words: "12 of 42 changes reviewed". */
	progressText: message,
	/** How many files could not be included. */
	leftOut: fileCount,
	/** Which version of its files it shows. */
	version
});
export type DiffSummary = z.output<typeof DiffSummarySchema>;

/** What an update did, as a page or the command says it. */
export const UpdateViewSchema = z.object({
	/** The version it made. */
	version,
	filesChanged: fileCount,
	filesGone: fileCount,
	newToReview: unitCount,
	newIgnored: unitCount,
	gone: unitCount,
	reviewedBefore: unitCount,
	reviewedKept: unitCount,
	/** In words: "2 files changed: 14 changes new to review. …" */
	text: message
});
export type UpdateView = z.output<typeof UpdateViewSchema>;

/** Something to open, as a chooser offers it. */
export const CandidateSchema = z.object({
	source,
	/** In plain words, with its size: "Uncommitted changes (12 files)". */
	description: message
});
export type Candidate = z.output<typeof CandidateSchema>;

/** A source to offer instead, such as the commit the changes went into. */
export const NextSourceSchema = z.object({ source, offer: message });
export type NextSourceOffer = z.output<typeof NextSourceSchema>;

const OpenedSchema = z.object({
	kind: z.literal('opened'),
	diff: DiffSummarySchema,
	/** It was open already and has been resumed. */
	resumed: z.boolean(),
	/** Resumed and brought up to date with its files: what the update did. */
	update: UpdateViewSchema.nullable()
});

const NothingToReviewSchema = z.object({
	kind: z.literal('nothing'),
	/** The source in plain words, when one was asked for. */
	source: message.nullable(),
	/** Why there is nothing, and what to do instead. */
	reason: message,
	/** Files that could not be included, which may be why it looks empty. */
	leftOut: z.array(message),
	/** What to offer instead, when it can be told. */
	next: NextSourceSchema.nullable(),
	/** Other sources that could still be opened. */
	candidates: z.array(CandidateSchema)
});

// ── Requests and responses ───────────────────────────────────────────────────

/** GET /api/diffs: every diff, most recently active first. */
export const DiffListSchema = z.object({
	/** The daemon's time, for "5 minutes ago". */
	now: timestamp,
	diffs: z.array(
		z.discriminatedUnion('kind', [
			DiffSummarySchema.extend({ kind: z.literal('diff') }),
			z.object({
				kind: z.literal('damaged'),
				/** Null when even its id cannot be read; such an entry cannot be deleted from here. */
				id: reportId.nullable(),
				problem: message
			})
		])
	)
});
export type DiffList = z.output<typeof DiffListSchema>;
export type ListedDiff = DiffList['diffs'][number];

/** POST /api/start: what `diff-delver` with no arguments opens in a folder. */
export const StartRequestSchema = z.object({ directory: absolutePath });
export type StartRequest = z.input<typeof StartRequestSchema>;

export const StartResponseSchema = z.discriminatedUnion('kind', [
	OpenedSchema,
	/** What it would have opened could not be opened: `problem` says why. */
	z.object({
		kind: z.literal('failed'),
		source,
		/** The source in plain words. */
		description: message,
		problem: message,
		/** Other sources that could be opened instead. */
		candidates: z.array(CandidateSchema)
	}),
	z.object({
		kind: z.literal('choose'),
		repository: message,
		candidates: z.array(CandidateSchema)
	}),
	NothingToReviewSchema
]);
export type StartResponse = z.output<typeof StartResponseSchema>;

/** POST /api/open: one source in a folder. */
export const OpenRequestSchema = z.object({ directory: absolutePath, source: z.string() });
export type OpenRequest = z.input<typeof OpenRequestSchema>;

export const OpenResponseSchema = z.discriminatedUnion('kind', [
	OpenedSchema,
	NothingToReviewSchema
]);
export type OpenResponse = z.output<typeof OpenResponseSchema>;

/** GET /api/suggest?directory=…: what could be opened in a folder, without opening anything. */
export const SuggestResponseSchema = z.object({
	repository: message,
	/**
	 * The source that was asked for, when one was: `problem` says why it cannot be
	 * opened, or is null when it can, and then `changes` says whether it has
	 * anything to review.
	 */
	asked: z.object({ problem: message.nullable(), changes: z.boolean() }).nullable(),
	suggestion: z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('one'),
			candidate: CandidateSchema,
			others: z.array(CandidateSchema)
		}),
		z.object({ kind: z.literal('choose'), candidates: z.array(CandidateSchema) }),
		z.object({ kind: z.literal('nothing'), reason: message, candidates: z.array(CandidateSchema) })
	])
});
export type SuggestResponse = z.output<typeof SuggestResponseSchema>;

const IgnoreReasonSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('stated'), text: message }),
	/** The agent's own words, shown as the agent's and as text. */
	z.object({ kind: z.literal('agent'), reason: parsed(z.string(), parseAgentMarkdown) })
]);

const ListedFileSchema = z.object({
	path: escapedPath,
	/** How it changed, in plain words: "changed", "renamed from src/old.ts", "changed, made executable". */
	change: message,
	added: lineCount,
	removed: lineCount,
	ignored: z.array(IgnoreReasonSchema),
	/** Changes new to review since the previous version: 0 in a first version. */
	newChanges: unitCount
});
export type ListedFileView = z.output<typeof ListedFileSchema>;

/** GET /api/diffs/:id: a diff's page. */
export const DiffPageSchema = z.object({
	now: timestamp,
	summary: DiffSummarySchema,
	/** The folder the diff was opened in, to open what its changes became. Never shown. */
	directory: absolutePath,
	/** What the diff was opened from, to open it again. Never shown. */
	source,
	/** Files that could not be included, one sentence each. */
	leftOut: z.array(message),
	groups: z.array(
		z.object({
			group: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('section'), title: parsed(z.string(), parseSectionTitle) }),
				z.object({ kind: z.literal('ignored') }),
				z.object({ kind: z.literal('uncategorised') })
			]),
			files: z.array(ListedFileSchema)
		})
	),
	/** Whether any section exists, to explain "Not sorted yet". */
	sorted: z.boolean(),
	/** What the update that made this version did, and when; null for a first version. */
	update: UpdateViewSchema.extend({ at: timestamp }).nullable()
});
export type DiffPage = z.output<typeof DiffPageSchema>;

/**
 * GET /api/diffs/:id/changes?seen=N: whether the diff has a newer version than
 * the one a page shows, and if not, whether its source has moved on.
 */
export const ChangeCheckSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unchanged') }),
	/** An update is waiting; it would change this many files. */
	z.object({ kind: z.literal('changed'), files: fileCount }),
	/** The diff has a newer version than the page shows, made elsewhere, such as by the command. */
	z.object({ kind: z.literal('updated'), version }),
	z.object({ kind: z.literal('nothing-left'), reason: message, next: NextSourceSchema.nullable() }),
	z.object({ kind: z.literal('closed') })
]);
export type ChangeCheckResponse = z.output<typeof ChangeCheckSchema>;

/** POST /api/diffs/:id/update: brings a diff up to date with its files. */
export const UpdateResponseSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('updated'), diff: DiffSummarySchema, update: UpdateViewSchema }),
	z.object({ kind: z.literal('unchanged'), diff: DiffSummarySchema }),
	z.object({ kind: z.literal('nothing-left'), reason: message, next: NextSourceSchema.nullable() })
]);
export type UpdateResponse = z.output<typeof UpdateResponseSchema>;

// ── Changes made on what the page shows ──────────────────────────────────────
//
// Each request that changes a diff's sorting or marks names the version the page
// shows. When the diff has been updated since, nothing changes and the answer is
// 409 with a message saying to show the new version first, so a tick made on
// version 1 never marks what is new in version 2. The routes come with the
// diff viewer.

const sectionId = parsed(z.string(), parseSectionId);

/** A group of the page: a section, the tests of a section, Ignored or Not sorted yet. */
const GroupKeySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('section'), section: sectionId }),
	z.object({ kind: z.literal('tests'), section: sectionId }),
	z.object({ kind: z.literal('ignored') }),
	z.object({ kind: z.literal('uncategorised') })
]);

/** POST /api/diffs/:id/reviewed: marks a part of the shown version as reviewed, or not. */
export const MarkReviewedRequestSchema = z.object({
	version,
	target: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('slice'), group: GroupKeySchema, path: escapedPath }),
		z.object({ kind: z.literal('file'), path: escapedPath }),
		z.object({ kind: z.literal('group'), group: GroupKeySchema })
	]),
	reviewed: z.boolean(),
	view: z.enum(['sections', 'tests-separate'])
});
export type MarkReviewedRequest = z.input<typeof MarkReviewedRequestSchema>;

/** POST /api/diffs/:id/assign: the agent's `assign` items, on the version it read. */
export const AssignRequestSchema = z.object({
	version,
	items: z.array(
		z.object({
			file: z.string().optional(),
			glob: z.string().optional(),
			hunks: z.array(z.string()).optional(),
			lines: z.string().optional(),
			section: z.string().optional(),
			reason: z.string().optional(),
			role: z.string().optional()
		})
	)
});
export type AssignHttpRequest = z.input<typeof AssignRequestSchema>;

/** POST /api/diffs/:id/close and /reopen. */
export const StateChangeSchema = z.object({ diff: DiffSummarySchema });
export type StateChange = z.output<typeof StateChangeSchema>;

/** DELETE /api/diffs/:id. */
export const DeletedSchema = z.object({
	/** Set when the diff went but its space could not be freed yet; it is freed later by itself. */
	problem: message.nullable()
});
export type DeletedResponse = z.output<typeof DeletedSchema>;

/** GET /api/daemon: which build the daemon runs, and which process it is, so the command can tell it is the one its lockfile names. */
export const DaemonInfoSchema = z.object({
	version: parsed(z.string(), parseCodeVersion),
	pid: parsed(z.number(), parseProcessId)
});
export type DaemonInfo = z.output<typeof DaemonInfoSchema>;

/** POST /api/entry: a single-use code for the address the command opens. */
export const EntryCodeSchema = z.object({ code: parsed(z.string(), parseEntryCode) });
export type EntryCodeResponse = z.output<typeof EntryCodeSchema>;

/** POST /api/daemon/stop. */
export const StoppingSchema = z.object({ stopping: z.literal(true) });
export type Stopping = z.output<typeof StoppingSchema>;

/** What every refused request answers with: what happened and what to do next. */
export const ApiErrorBodySchema = z.object({
	error: z.object({
		/** The kind of error, such as `ReportNotFound`. */
		kind: z.string(),
		message
	})
});
export type ApiErrorBody = z.output<typeof ApiErrorBodySchema>;
