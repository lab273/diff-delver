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
import { GITHUB_REVIEW_KINDS } from '#lib/core/github/github-review.ts';
import { parseGitHubReviewAddress } from '#lib/core/github/github-review-address.tiny.ts';
import { z } from 'zod';
import { IMAGE_FORMATS, NOT_IMAGE_KINDS } from '#lib/core/image/image-format.ts';
import { FILE_PAGE_LINES, FILE_QUERY_LENGTH } from '#lib/core/viewer/file-reader.ts';
import { MAX_COMMENT_LENGTH } from '#lib/core/review/draft-comment.ts';
import { NOTE_LABELS } from '#lib/core/review/agent-note.ts';
import { parseAgentNoteId } from '#lib/core/agent-note-id.tiny.ts';
import { parseAgentRequestId } from '#lib/core/agent-request-id.tiny.ts';
import { MAX_QUESTION_LENGTH } from '#lib/core/review/agent-request.ts';
import { MAX_OVERALL_REVIEW_LENGTH } from '#lib/core/review/overall-review.ts';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { textToCopy } from '#lib/core/agent-setup/text-to-copy.tiny.ts';
import { parseCodeVersion } from '#lib/core/code-version.tiny.ts';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { parseAuthorName } from '#lib/core/history/author-name.tiny.ts';
import { parseBranchCount } from '#lib/core/history/branch-count.tiny.ts';
import { parseBranchRef } from '#lib/core/history/branch-ref.tiny.ts';
import { parseCommitCount } from '#lib/core/history/commit-count.tiny.ts';
import { parseRemoteName } from '#lib/core/history/remote-name.tiny.ts';
import { parseSubjectLine } from '#lib/core/history/subject-line.tiny.ts';
import { parseFileCount } from '#lib/core/file-count.tiny.ts';
import { parseFileMode } from '#lib/core/file-mode.tiny.ts';
import { parseDraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import { parseThreadId } from '#lib/core/thread-id.tiny.ts';
import { textForAgent } from '#lib/core/text-for-agent.tiny.ts';
import { parseCommentCount } from '#lib/core/comment-count.tiny.ts';
import { parseReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseHandoverCount } from '#lib/core/handover-count.tiny.ts';
import { parseEditCount } from '#lib/core/edit-count.tiny.ts';
import { parseEntryCode } from '#lib/core/entry-code.tiny.ts';
import { parseByteSize } from '#lib/core/byte-size.tiny.ts';
import { parseLineCount } from '#lib/core/line-count.tiny.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { parseLineText } from '#lib/core/line-text.tiny.ts';
import { parsePartPosition } from '#lib/core/part-position.tiny.ts';
import { parseSliceCount } from '#lib/core/slice-count.tiny.ts';
import { parseOrderStep } from '#lib/core/order-step.tiny.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import { parseEscapedPath } from '#lib/core/path-bytes.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { ok, err, type Result } from '#lib/core/result.ts';
import { parseGroupText } from '#lib/core/viewer/group-text.ts';
import { readSpans } from '#lib/core/viewer/line-spans.ts';
import { parseCharacterCount } from '#lib/core/character-count.tiny.ts';
import { TOKEN_KINDS } from '#lib/core/highlight/colour-run.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseSectionTitle } from '#lib/core/section-title.tiny.ts';
import type { SourceText } from '#lib/core/sources/source-text.tiny.ts';
import { formatSourceSpec, parseSourceSpec } from '#lib/core/sources/source-spec.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { parseSearchText } from '#lib/core/search/search-text.tiny.ts';
import { parseMatchCount } from '#lib/core/search/match-count.tiny.ts';
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

function sourceText(text: string): Result<SourceText, unknown> {
	const spec = parseSourceSpec(text);
	return spec.ok ? ok(formatSourceSpec(spec.value)) : err(spec.error);
}

const message = z.string().transform(reviewerMessage);
const reportId = parsed(z.string(), parseReportId);
const toCopy = z.string().transform(textToCopy);
const timestamp = parsed(z.number(), parseTimestamp);
const fileCount = parsed(z.number(), parseFileCount);
const lineCount = parsed(z.number(), parseLineCount);
const unitCount = parsed(z.number(), parseUnitCount);
const lineNumber = parsed(z.number(), parseLineNumber);
const byteSize = parsed(z.number(), parseByteSize);
/** A version of a diff, as the page numbers them: 1 for the first, 2 after the first update. */
const version = parsed(z.number(), parseRevisionNumber);
const escapedPath = parsed(z.string(), parseEscapedPath);
const absolutePath: z.ZodType<AbsolutePath> = parsed(z.string(), parseAbsolutePath);
/** A source in its one written form (`formatSourceSpec`), such as `working-tree`, `main...feature` or a pull request's address. */
const source = parsed(z.string(), sourceText);

// ── Shared parts ─────────────────────────────────────────────────────────────

const lines = z.object({ added: lineCount, removed: lineCount });

/**
 * A diff's size: its files, every line it adds and removes, and of those the
 * lines that are tests, which a page shows apart (`core/reports/diff-size.ts`).
 */
export const DiffSizeSchema = z.object({
	files: fileCount,
	added: lineCount,
	removed: lineCount,
	tests: lines
});
export type DiffSizeView = z.output<typeof DiffSizeSchema>;

/** A diff's binary files and their sizes in bytes. */
export const BinaryFilesSchema = z.object({
	added: z.object({ files: fileCount, bytes: byteSize }),
	removed: z.object({ files: fileCount, bytes: byteSize }),
	changed: z.object({ files: fileCount, before: byteSize, after: byteSize })
});

export const DiffSummarySchema = z.object({
	id: reportId,
	/** The source in plain words: "Uncommitted changes". */
	title: message,
	/** The repository's folder name. */
	repository: message,
	/** The folder the diff was opened in, to open something else of its repository. */
	directory: absolutePath,
	state: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('open') }),
		z.object({ kind: z.literal('closed'), reason: message })
	]),
	lastActivityAt: timestamp,
	size: DiffSizeSchema,
	/** In words, tests apart: "3 files changed, 40 lines added and 12 removed, plus 6 added in tests". */
	sizeText: message,
	/** Its binary files, or null when they could not be counted. */
	binary: BinaryFilesSchema.nullable(),
	/** In words, "1 binary file added (12 KB)"; null when there are none or they are not known. */
	binaryText: message.nullable(),
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
	version,
	/**
	 * What it takes on disk (DESIGN 9.1), estimates, once measured, on the list
	 * of Delves and the Storage page; null until then and everywhere else.
	 */
	disk: z
		.object({
			/** What deleting it frees. */
			own: byteSize,
			/** What it shares with other Delves of its repository. */
			shared: byteSize,
			/** "About 40 MB on disk". */
			text: message,
			/** Both figures in a sentence, for hovering over `text`. */
			inFull: message,
			/** What deleting it frees, and when: "Deleting it frees about 40 MB on disk within about an hour." */
			deleting: message
		})
		.nullable()
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

/** Something to open, as the start page's choice offers it. */
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
	),
	/**
	 * The repositories of the diffs listed, each once, in the list's order: where
	 * "Choose commits or a branch" can open something new without a terminal.
	 */
	repositories: z.array(
		z.object({
			/** The repository's folder name. */
			repository: message,
			directory: absolutePath,
			/** Another repository listed has the same folder name. */
			sameName: z.boolean(),
			/** Its folder is still there. */
			there: z.boolean()
		})
	)
});
export type DiffList = z.output<typeof DiffListSchema>;

/** GET /api/storage: what diff delver takes on disk (DESIGN 9.1), as last measured. */
export const StorageSchema = z.object({
	/** The database's size on disk, exactly, with when: "1.2 MB on disk, measured just now", or "Not measured yet". */
	databaseText: message,
	/** Each repository's store, the largest first, then those not measured yet. */
	stores: z.array(
		z.object({
			/** The repository it holds, by its folder name. */
			repository: message,
			/** Its size on disk, exactly, with when it was measured, or "Not measured yet". */
			sizeText: message,
			/** Its Delves, with what each takes in it; those that free most first. */
			delves: z.array(DiffSummarySchema)
		})
	)
});
export type Storage = z.output<typeof StorageSchema>;
export type ListedDiff = DiffList['diffs'][number];
export type ListedRepository = DiffList['repositories'][number];

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

const sectionId = parsed(z.string(), parseSectionId);

/** A group of the page: a section, the tests of a section, Ignored or Not sorted yet. */
export const GroupKeySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('section'), section: sectionId }),
	z.object({ kind: z.literal('tests'), section: sectionId }),
	z.object({ kind: z.literal('ignored') }),
	z.object({ kind: z.literal('uncategorised') })
]);
export type GroupKeyView = z.output<typeof GroupKeySchema>;

/** A step of a section's reading order (DESIGN 4.3.1), counted from 1. */
export const OrderStepSchema = parsed(z.number(), parseOrderStep);
const orderStep = OrderStepSchema;

/** Where a change is read: a group, and in a section with a reading order its step, or null after the steps. */
const PlaceSchema = z.object({ group: GroupKeySchema, step: orderStep.nullable() });
export type PlaceView = z.output<typeof PlaceSchema>;

/** How the page groups the diff: by section with tests in them (the only view so far), or tests apart. */
const ViewSchema = z.enum(['sections', 'tests-separate']);
export type ViewName = z.output<typeof ViewSchema>;

/**
 * How far a part, a file or a group has got. A change is one added line, one
 * removed line, or one change to a file itself (DESIGN 8.5).
 */
const TallySchema = z.object({
	units: unitCount,
	reviewed: unitCount,
	/** Of them, new since the previous version. */
	fresh: unitCount,
	/** Of them, unmarked by the last update because lines close to them changed. */
	unmarked: unitCount
});
export type TallyView = z.output<typeof TallySchema>;

/** One file's part within one group, as the page lists it before its lines are drawn. */
const PartSchema = z.object({
	group: GroupKeySchema,
	path: escapedPath,
	/** In a section with a reading order, the step this part is; null after the steps or with none. */
	step: orderStep.nullable(),
	/** How many steps its section's reading order has; 0 with none. */
	steps: parsed(z.number(), parseSliceCount),
	/** The agent's note on its step, to be drawn as agent text. */
	note: parsed(z.string(), parseAgentMarkdown).nullable(),
	/** How the file changed, saying only what is in this part: "changed", "renamed from src/old.ts". */
	change: message,
	added: lineCount,
	removed: lineCount,
	/** What the change to the file itself stands for, when it is in this part: "made executable". */
	fileUnit: message.nullable(),
	/** A change to the file's mode or kind, when it is in this part: 100644 to 100755, "made executable". */
	modeChange: z
		.object({
			from: parsed(z.string(), parseFileMode),
			to: parsed(z.string(), parseFileMode),
			words: message
		})
		.nullable(),
	ignored: z.array(IgnoreReasonSchema),
	tally: TallySchema,
	/** How many rows its lines take when drawn, hidden lines aside. */
	rows: lineCount,
	/** Part 2 of 3. */
	position: parsed(z.number(), parsePartPosition),
	of: parsed(z.number(), parseSliceCount),
	/** The other groups the file's parts are in, each once, in reading order. */
	others: z.array(GroupKeySchema),
	/** What the file holds: text, or no lines to show. */
	content: z.enum(['text', 'binary', 'submodule'])
});
export type PartView = z.output<typeof PartSchema>;

/** A file of the by-file view: every file once. */
const FileSchema = z.object({
	path: escapedPath,
	/** How the whole file changed: "changed, renamed from src/old.ts". */
	change: message,
	added: lineCount,
	removed: lineCount,
	/** Its parts outside Ignored. */
	tally: TallySchema,
	/** Its changes in Ignored. */
	ignored: unitCount,
	/** Where its parts are, in reading order. */
	parts: z.array(GroupKeySchema)
});
export type FileView = z.output<typeof FileSchema>;

const agentNoteId = parsed(z.number(), parseAgentNoteId);

/**
 * One agent note of the version shown (DESIGN 5): its label, its lines, the
 * agent's words, to be drawn as agent text, and whether it was dismissed. A
 * promoted note is not sent: it is a comment of the draft by then.
 */
export const AgentNoteSchema = z.strictObject({
	id: agentNoteId,
	label: z.enum(NOTE_LABELS),
	anchor: z.strictObject({
		path: escapedPath,
		side: z.enum(['old', 'new']),
		first: lineNumber,
		last: lineNumber
	}),
	text: parsed(z.string(), parseAgentMarkdown),
	dismissed: z.boolean()
});
export type AgentNoteView = z.output<typeof AgentNoteSchema>;

const agentRequestId = parsed(z.number(), parseAgentRequestId);
const side = z.enum(['old', 'new']);

/**
 * One of the reviewer's questions for the agent (DESIGN 7.2), on any version:
 * what it is about and in words, its status, the prompt to copy while it
 * waits, and the agent's answers, drawn as agent text, with the code each
 * pointed at as the daemon read it from the snapshot.
 */
export const AgentRequestSchema = z.strictObject({
	id: agentRequestId,
	version,
	anchor: z.discriminatedUnion('kind', [
		z.strictObject({
			kind: z.literal('lines'),
			path: escapedPath,
			side,
			first: lineNumber,
			last: lineNumber
		}),
		z.strictObject({ kind: z.literal('file'), path: escapedPath }),
		z.strictObject({
			kind: z.literal('section'),
			section: sectionId,
			title: parsed(z.string(), parseSectionTitle)
		})
	]),
	/** What it is about, in words: "After, lines 3–5", "the whole file". */
	about: message,
	question: z.string(),
	status: z.enum(['waiting', 'delivered', 'answered', 'cancelled']),
	promoted: z.boolean(),
	/** Whether it can be promoted into the draft: answered, and about lines. */
	promotable: z.boolean(),
	/** While no agent has answered it, the prompt "Copy as prompt" gives; null otherwise. */
	prompt: toCopy.nullable(),
	answers: z.array(
		z.strictObject({
			body: parsed(z.string(), parseAgentMarkdown),
			excerpts: z.array(
				z.strictObject({
					path: escapedPath,
					side,
					first: lineNumber,
					last: lineNumber,
					lines: z.array(parsed(z.string(), parseLineText)),
					/** How many lines of the range are not drawn. */
					more: z.number().int().min(0)
				})
			)
		})
	)
});
export type AgentRequestView = z.output<typeof AgentRequestSchema>;

const threadId = parsed(z.number(), parseThreadId);
const threadAnchor = z.strictObject({
	path: escapedPath,
	side,
	first: lineNumber,
	last: lineNumber
});

/**
 * A thread of an earlier review (DESIGN 6.3) as the version shown has it: its
 * status there, its lines there (null when they are gone), its messages,
 * each with the review it was finished in, and the code its first message
 * was on.
 */
export const EarlierThreadSchema = z.strictObject({
	id: threadId,
	kind: z.enum(['comment', 'flag']),
	status: z.enum(['open', 'changed', 'resolved']),
	at: threadAnchor.nullable(),
	messages: z.array(
		z.strictObject({
			review: parsed(z.number(), parseReviewNumber),
			kind: z.enum(['comment', 'flag']),
			version,
			anchor: threadAnchor,
			body: z.string(),
			writtenAt: timestamp
		})
	),
	quoted: z.array(parsed(z.string(), parseLineText))
});
export type EarlierThreadView = z.output<typeof EarlierThreadSchema>;

/** GET /api/diffs/:id: a diff's page, without the code, which comes a part at a time. */
const frameStamp = z.string().min(1).max(256);
export const DiffPageSchema = z.object({
	now: timestamp,
	/**
	 * The finished review this page shows the Delve as of (DESIGN 6.4),
	 * read-only: its version, with the marks it copied; null for the Delve as it is.
	 */
	asOf: z
		.strictObject({ review: parsed(z.number(), parseReviewNumber), submittedAt: timestamp })
		.nullable(),
	/** The Delve's latest finished review, so the page offers its history; null before the first, and for a browser that may not read reviews. */
	latestReview: parsed(z.number(), parseReviewNumber).nullable(),
	summary: DiffSummarySchema,
	overview: parsed(z.string(), parseAgentMarkdown).nullable(),
	/** Whether the reviewer has read the overview, as this version has it; false when there is none. */
	overviewRead: z.boolean(),
	/** The agent's notes on this version, in the order they were added. */
	notes: z.array(AgentNoteSchema),
	/** On a version with no notes, what to say of the notes an earlier version has; null otherwise. */
	earlierNotes: message.nullable(),
	/** The reviewer's questions for the agent, on every version, cancelled ones left out. */
	requests: z.array(AgentRequestSchema),
	/** Whether an agent is listening for this Delve's questions now (DESIGN 7.2). */
	agentConnected: z.boolean(),
	/**
	 * The threads of earlier reviews this version has, in the order they were
	 * started; null for a browser that may not read the reviews.
	 */
	threads: z.array(EarlierThreadSchema).nullable(),
	/** Identifies the frame of this version and view for a conditional read. */
	frame: frameStamp,
	/** The sorting the reviewer saw when deciding to tick a slice or group. */
	sorting: frameStamp,
	/** The assignment generation used by part reads and search. */
	assignments: frameStamp,
	/** What the diff was opened from, to open it again. Never shown. */
	source,
	/** Files that could not be included, one sentence each. */
	leftOut: z.array(message),
	view: ViewSchema,
	/** The groups in reading order, each with its parts; empty ones left out, except sections. */
	groups: z.array(
		z.object({
			key: GroupKeySchema,
			/** A section's title, as the agent wrote it; null for the other groups. */
			title: parsed(z.string(), parseSectionTitle).nullable(),
			summary: parsed(z.string(), parseAgentMarkdown).nullable(),
			/** Whether the reviewer has read its section's summary, as this version has it. */
			summaryRead: z.boolean(),
			parts: z.array(PartSchema)
		})
	),
	/** Every file once, in path order. */
	files: z.array(FileSchema),
	/** Whether any section exists, to explain "Not sorted yet". */
	sorted: z.boolean(),
	/** What the update that made this version did, and when; null for a first version. */
	update: UpdateViewSchema.extend({ at: timestamp }).nullable()
});
export type DiffPage = z.output<typeof DiffPageSchema>;
/** A conditional read returns null when the frame is current. */
export const DiffRefreshSchema = DiffPageSchema.nullable();
export type DiffPageGroup = DiffPage['groups'][number];

/** A number written in an address, such as `?version=2`. */
function inQuery<T>(parse: (value: number) => Result<T, unknown>): z.ZodType<T> {
	return parsed(
		z
			.string()
			.regex(/^[0-9]+$/, 'is not a whole number')
			.transform(Number),
		parse
	);
}

/**
 * GET /api/diffs/:id?view=V&version=N: which view to give the page in, and of
 * which version: the newest, or the one a page shows, to bring its ticks up to
 * date with what another page marked.
 */
export const PageQuerySchema = z
	.object({
		view: ViewSchema.default('sections'),
		version: inQuery(parseRevisionNumber).optional(),
		/** The finished review to show the Delve as of, read-only; its version is the one shown. */
		review: inQuery(parseReviewNumber).optional(),
		since: frameStamp.optional()
	})
	.refine(
		(query) => query.since === undefined || query.version !== undefined,
		'Refreshing requires the version shown'
	);
export type PageQuery = z.input<typeof PageQuerySchema>;

/** GET /api/diffs/:id/part: which part, of the version the page shows. */
export const PartQuerySchema = z.object({
	version: inQuery(parseRevisionNumber),
	assignments: frameStamp,
	view: ViewSchema,
	/** The group as `groupKeyId` writes it: `uncategorised`, `section:auth`. */
	group: parsed(z.string(), parseGroupText),
	path: escapedPath,
	/** The part's step in its section's reading order; left out for a part after the steps. */
	step: inQuery(parseOrderStep).optional()
});
export type PartQuery = z.output<typeof PartQuerySchema>;

/** GET /api/diffs/:id/lines: which lines of which side of a file, of the version the page shows. */
export const LinesQuerySchema = z
	.object({
		version: inQuery(parseRevisionNumber),
		side: z.enum(['old', 'new']),
		path: escapedPath,
		first: inQuery(parseLineNumber),
		last: inQuery(parseLineNumber)
	})
	.refine((q) => q.first <= q.last, 'the first line comes after the last');
export type LinesQuery = z.output<typeof LinesQuerySchema>;

const LineSpanSchema = z.object({ first: lineNumber, last: lineNumber });

/**
 * One side of a file shown as an image: a picture, with its format and size;
 * one too large to show, with the same; or a side that is no picture (a file
 * that is not an image, or a link), with its size when it has one.
 */
const ImageSideSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('image'), format: z.enum(IMAGE_FORMATS), size: byteSize }),
	z.object({ kind: z.literal('too-large'), format: z.enum(IMAGE_FORMATS), size: byteSize }),
	z.object({ kind: z.literal('other'), what: z.enum(NOT_IMAGE_KINDS), size: byteSize })
]);
export type ImageSideView = z.output<typeof ImageSideSchema>;
export type PartImageView = NonNullable<z.output<typeof PartLinesSchema>['image']>;

/** GET /api/diffs/:id/image: one side of an image of the version the page shows, by its path in the diff. */
export const ImageQuerySchema = z.object({
	version: inQuery(parseRevisionNumber),
	side: z.enum(['old', 'new']),
	path: escapedPath
});
export type ImageQuery = z.output<typeof ImageQuerySchema>;

/** Where a changed line of a part belongs: here (and whether it is new), or in another group. */
const LineHomeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('here'), fresh: z.boolean() }),
	z.object({ kind: z.literal('elsewhere'), group: GroupKeySchema, step: orderStep.nullable() })
]);

const lineText = parsed(z.string(), parseLineText);

const ShownLineSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('context'),
		old: lineNumber,
		new: lineNumber,
		text: lineText,
		noNewlineAtEnd: z.boolean()
	}),
	z.object({
		kind: z.literal('deleted'),
		old: lineNumber,
		text: lineText,
		noNewlineAtEnd: z.boolean(),
		home: LineHomeSchema
	}),
	z.object({
		kind: z.literal('added'),
		new: lineNumber,
		text: lineText,
		noNewlineAtEnd: z.boolean(),
		home: LineHomeSchema
	})
]);
export type ShownLineView = z.output<typeof ShownLineSchema>;

/**
 * GET /api/diffs/:id/part?version=N&view=V&group=G&path=P: one part's lines,
 * of the version the page shows.
 */
export const PartLinesSchema = z.object({
	blocks: z.array(
		z.discriminatedUnion('kind', [
			/** Unchanged lines not shown, the same on both sides. */
			z.object({ kind: z.literal('hidden'), old: LineSpanSchema, new: LineSpanSchema }),
			z.object({ kind: z.literal('hunk'), heading: lineText, lines: z.array(ShownLineSchema) }),
			/** A hunk with none of this part's changes: where they are. */
			z.object({
				kind: z.literal('elsewhere'),
				places: z.array(PlaceSchema),
				lines: z.array(ShownLineSchema)
			})
		])
	),
	/** For a binary file, its size on each side it has. */
	sizes: z.object({ old: byteSize.nullable(), new: byteSize.nullable() }).nullable(),
	/**
	 * For a file one side of which is an image the page shows as a picture
	 * (DESIGN 8.4), read from `GET /api/diffs/:id/image`: each side the file
	 * has, null for a side it does not have, and whether its bytes are the same
	 * on both, as when only its name or mode changed; and, for a binary file
	 * every side of which is an image, how it changed in the words its part's
	 * header uses then ("changed, image"), in place of the frame's ("changed,
	 * binary file"), which are said before its bytes are read. Null for any
	 * other file.
	 */
	image: z
		.object({
			old: ImageSideSchema.nullable(),
			new: ImageSideSchema.nullable(),
			sameBytes: z.boolean(),
			change: message.nullable()
		})
		.nullable()
});
export type PartLines = z.output<typeof PartLinesSchema>;
export type PartBlockView = PartLines['blocks'][number];

/**
 * GET /api/diffs/:id/lines?version=N&side=S&path=P&first=A&last=B: lines of a
 * file of the version the page shows, from diff delver's copy of it.
 */
export const LinesSchema = z.object({
	lines: z.array(z.object({ number: lineNumber, text: lineText })),
	/** How many lines the file has. */
	lineCount
});
export type LinesView = z.output<typeof LinesSchema>;

/** Filename matches in the pinned snapshot. */
export const FileSearchQuerySchema = z.object({
	version: inQuery(parseRevisionNumber),
	name: z.string().max(FILE_QUERY_LENGTH)
});
export const FileMatchesSchema = z.array(
	z.object({
		path: escapedPath,
		side: z.enum(['old', 'new']),
		changed: z.boolean()
	})
);
export type FileMatch = z.output<typeof FileMatchesSchema>[number];

export const FileReaderQuerySchema = LinesQuerySchema.refine(
	(q) => q.last - q.first < FILE_PAGE_LINES,
	'too many lines for one page'
);
export const FileReaderSchema = z.object({
	kind: z.enum(['text', 'symlink', 'binary', 'large', 'submodule']),
	otherPath: escapedPath.nullable(),
	diffPath: escapedPath.nullable(),
	nonUtf8: z.boolean(),
	lineCount,
	lines: z.array(z.object({ number: lineNumber, text: lineText, changed: z.boolean() }))
});
export type FileReaderView = z.output<typeof FileReaderSchema>;

/** Text a person searches for, as typed (`search-text.tiny.ts`). */
const searchText = parsed(z.string(), parseSearchText);
const matchCount = parsed(z.number(), parseMatchCount);
/** A yes-or-no option written in an address: `true` or `false`. */
const flagInQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * GET /api/diffs/:id/search?version=N&view=V&text=T&matchCase=B&changedOnly=B:
 * a search of the version the page shows, part by part (DESIGN 8.3).
 */
export const DiffSearchQuerySchema = z.object({
	version: inQuery(parseRevisionNumber),
	assignments: frameStamp,
	view: ViewSchema,
	text: searchText,
	matchCase: flagInQuery,
	changedOnly: flagInQuery
});
export type DiffSearchQuery = z.output<typeof DiffSearchQuerySchema>;

/**
 * What a search of the diff found: each part with any match, in reading order,
 * with how many it has in its path and its hunks' lines
 * (`core/search/diff-search.ts`). One entry per part, never one per match: the
 * page finds where each is in the part's lines when it has them.
 */
export const DiffSearchSchema = z.object({
	parts: z.array(
		z.object({
			group: GroupKeySchema,
			path: escapedPath,
			step: orderStep.nullable(),
			matches: matchCount
		})
	)
});
export type DiffSearchView = z.output<typeof DiffSearchSchema>;

/** GET and POST /api/settings: how the person likes diffs shown (`core/settings.ts`). */
const LayoutSchema = z.enum(['unified', 'side-by-side']);
export const SettingsSchema = z.object({
	colours: z.boolean(),
	layout: LayoutSchema,
	hideWhiteSpace: z.boolean(),
	searchMatchCase: z.boolean(),
	searchChangedOnly: z.boolean(),
	searchSkipClosed: z.boolean(),
	overallReviewOpen: z.boolean(),
	agentNotes: z.boolean()
});
export type SettingsView = z.output<typeof SettingsSchema>;

/** POST /api/settings: one setting changed. */
export const SettingChangeSchema = z.discriminatedUnion('name', [
	z.object({ name: z.literal('colours'), value: z.boolean() }),
	z.object({ name: z.literal('layout'), value: LayoutSchema }),
	z.object({ name: z.literal('hide-white-space'), value: z.boolean() }),
	z.object({ name: z.literal('search-match-case'), value: z.boolean() }),
	z.object({ name: z.literal('search-changed-only'), value: z.boolean() }),
	z.object({ name: z.literal('search-skip-closed'), value: z.boolean() }),
	z.object({ name: z.literal('overall-review-open'), value: z.boolean() }),
	z.object({ name: z.literal('agent-notes'), value: z.boolean() })
]);
export type SettingChangeRequest = z.output<typeof SettingChangeSchema>;

/** Runs of lines as an address writes them: `1-20,40-60` (`line-spans.ts`). */
const spansInQuery = parsed(z.string(), readSpans);

/**
 * GET /api/diffs/:id/colours?version=N&path=P&old=1-20&new=1-3,9: the colours
 * of lines of each side of a file, of the version the page shows (DESIGN 8.3).
 */
export const ColoursQuerySchema = z.object({
	version: inQuery(parseRevisionNumber),
	path: escapedPath,
	old: spansInQuery.default([]),
	new: spansInQuery.default([]),
	exact: z.literal('1').optional()
});
export type ColoursQuery = z.output<typeof ColoursQuerySchema>;

const characters = parsed(z.number(), parseCharacterCount);

const SideColoursSchema = z
	.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('coloured'),
			/** The lines asked for that have any colour, each with its runs: start, length and kind. */
			lines: z.array(
				z.object({
					number: lineNumber,
					runs: z.array(
						z.object({ start: characters, length: characters, kind: z.enum(TOKEN_KINDS) })
					)
				})
			)
		}),
		/** Shown plain, and why: a language diff delver does not colour, too large, minified, binary, or failed. */
		z.object({
			kind: z.literal('plain'),
			reason: z.enum(['language', 'large', 'minified', 'binary', 'failed'])
		})
	])
	.nullable();
export type SideColoursView = z.output<typeof SideColoursSchema>;

export const ColoursSchema = z.object({ old: SideColoursSchema, new: SideColoursSchema });
export type ColoursView = z.output<typeof ColoursSchema>;

/**
 * GET /api/diffs/:id/changes?seen=N: whether the diff has a newer version than
 * the one a page shows, and if not, whether its source has moved on.
 */
export const ChangeCheckSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unchanged') }),
	/** An update is waiting; it would change this many files. `reason` says what changed. */
	z.object({ kind: z.literal('changed'), files: fileCount, reason: message }),
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
// version 1 never marks what is new in version 2.

/** POST /api/diffs/:id/reviewed: marks a part of the shown version as reviewed, or not. */
export const MarkReviewedRequestSchema = z.object({
	version,
	target: z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('slice'),
			group: GroupKeySchema,
			path: escapedPath,
			/** The part's step in its section's reading order; null or left out after the steps. */
			step: orderStep.nullish(),
			sorting: frameStamp
		}),
		z.object({ kind: z.literal('file'), path: escapedPath }),
		z.object({ kind: z.literal('group'), group: GroupKeySchema, sorting: frameStamp })
	]),
	reviewed: z.boolean(),
	view: ViewSchema
});
export type MarkReviewedRequest = z.input<typeof MarkReviewedRequestSchema>;

/**
 * POST /api/diffs/:id/read: the reviewer has read the agent's overview, or a
 * section's summary, as the version the page shows has it (DESIGN 8.1).
 */
export const SummaryReadRequestSchema = z.object({
	version,
	place: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('overview') }),
		z.object({ kind: z.literal('section'), section: sectionId })
	])
});
export type SummaryReadRequest = z.input<typeof SummaryReadRequestSchema>;

/** Whether the version had that text to read. */
export const SummaryReadSchema = z.object({ read: z.boolean() });
export type SummaryRead = z.output<typeof SummaryReadSchema>;

/**
 * What marking changed: the diff's summary with its progress, and the parts
 * and files of every file it touched, which the page puts in place of its own;
 * the groups' figures are their parts' sums.
 */
export const MarkedSchema = z.object({
	summary: DiffSummarySchema,
	sorting: frameStamp,
	parts: z.array(PartSchema),
	files: z.array(FileSchema),
	/**
	 * Every group's changes and how many are reviewed, as stored: a page whose
	 * own sums differ was behind another page's ticks, and fetches its frame again.
	 */
	groups: z.array(z.object({ key: GroupKeySchema, units: unitCount, reviewed: unitCount }))
});
export type Marked = z.output<typeof MarkedSchema>;

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

/**
 * GET /api/daemon: which build the daemon runs, and which process it is, so the command can tell it is the one its lockfile names.
 *
 * An older copy of the command reads this from a newer daemon, to find that it
 * is newer and use it, and to stop it (`launcher.ts`), so it never changes
 * between releases: only fields may be added. The same holds for stopping
 * (POST /api/daemon/stop), whose answer the command does not read. What else
 * the command asks a newer daemon (start, open, an entry code) may change: an
 * answer it cannot read is then said as this copy being too old.
 */
export const DaemonInfoSchema = z.object({
	version: parsed(z.string(), parseCodeVersion),
	pid: parsed(z.number(), parseProcessId)
});
export type DaemonInfo = z.output<typeof DaemonInfoSchema>;

/** POST /api/entry: a single-use code for the address the command opens. */
export const EntryCodeSchema = z.object({ code: parsed(z.string(), parseEntryCode) });
export type EntryCodeResponse = z.output<typeof EntryCodeSchema>;

/**
 * POST /api/review-window: asks diff delver to open a Delve, or the list of
 * Delves, in the person's own browser, in a window that may write their drafts.
 */
export const ReviewWindowRequestSchema = z.strictObject({ diff: reportId.nullable() });
export type ReviewWindowRequest = z.output<typeof ReviewWindowRequestSchema>;

/**
 * What became of asking: a browser was asked to open it, there is none to ask,
 * or one was asked for too short a while ago. Never the address: that goes to
 * the browser alone.
 */
export const ReviewWindowSchema = z.strictObject({
	outcome: z.enum(['opened', 'no-browser', 'too-soon'])
});
export type ReviewWindow = z.output<typeof ReviewWindowSchema>;

/**
 * POST /api/daemon/stop: why, for the daemon's log. A command older than this
 * sends no body, and a daemon older than this reads none.
 */
export const StopRequestSchema = z.object({
	by: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('command') }),
		z.object({ kind: z.literal('replacement'), version: parsed(z.string(), parseCodeVersion) })
	])
});
export type StopRequest = z.output<typeof StopRequestSchema>;

/** POST /api/daemon/stop. */
export const StoppingSchema = z.object({ stopping: z.literal(true) });
export type Stopping = z.output<typeof StoppingSchema>;

// ── The choose page: commits or a branch ─────────────────────────────────────

const commitId = parsed(z.string(), parseCommitId);
const branchRef = parsed(z.string(), parseBranchRef);
const remoteName = parsed(z.string(), parseRemoteName);
const commitCount = parsed(z.number(), parseCommitCount);

/** GET /api/history?directory=…&find=…: a repository's branches, and when it last fetched. */
export const HistoryQuerySchema = z.object({
	directory: absolutePath,
	/** Only branches whose name holds this, in any case. */
	find: z.string().default('')
});
export type HistoryQuery = z.output<typeof HistoryQuerySchema>;

export const HistorySchema = z.object({
	/** The daemon's time, for "2 days ago". */
	now: timestamp,
	repository: message,
	/** The branch the others are compared with; null when none can be told. */
	main: branchRef.nullable(),
	/** The branches to show: the checked-out one first, then the most recently changed. */
	branches: z.array(
		z.object({
			ref: branchRef,
			/** When its newest commit was made; null when git cannot read a time from it. */
			committedAt: timestamp.nullable(),
			current: z.boolean(),
			main: z.boolean(),
			/** Commits the main branch lacks; null with no main branch. */
			ahead: commitCount.nullable()
		})
	),
	/** How many branches match, shown or not. */
	matching: parsed(z.number(), parseBranchCount),
	/** The repository has no commits yet: no branch, and nothing checked out. */
	noCommits: z.boolean(),
	remotes: z.array(remoteName),
	/** Its remote on GitHub, whose pull requests the page offers to list; null for none. */
	gitHub: z.object({ remote: remoteName, repository: z.string() }).nullable(),
	lastFetch: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('no-remote') }),
		z.object({ kind: z.literal('never'), remotes: z.array(remoteName) }),
		z.object({ kind: z.literal('fetched'), at: timestamp, remotes: z.array(remoteName) })
	])
});
export type HistoryView = z.output<typeof HistorySchema>;
export type BranchView = HistoryView['branches'][number];

/**
 * GET /api/history/commits?directory=…&branch=…&from=…&onMain=…: a page of a
 * branch's commits. `from` and `onMain` are the `next` of the page before.
 */
export const CommitsQuerySchema = z.object({
	directory: absolutePath,
	branch: branchRef,
	/** Where the page starts; the branch's newest commit when absent. */
	from: commitId.optional(),
	/** Whether the main branch has `from`, as the page before said: then it has all that follow. */
	onMain: flagInQuery.optional()
});
export type CommitsQuery = z.output<typeof CommitsQuerySchema>;

/** A commit's or a run's size, its tests told by their paths. */
const CommitSizeSchema = DiffSizeSchema;

export const CommitsSchema = z.object({
	commits: z.array(
		z.object({
			commit: commitId,
			parent: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('commit'), commit: commitId }),
				z.object({ kind: z.literal('none') }),
				z.object({ kind: z.literal('not-downloaded') })
			]),
			merge: z.boolean(),
			subject: parsed(z.string(), parseSubjectLine),
			author: parsed(z.string(), parseAuthorName),
			/** When it was made; null when git cannot read a time from it. */
			committedAt: timestamp.nullable(),
			/** Against its first parent; null when it could not be measured without downloading. */
			size: CommitSizeSchema.nullable(),
			/** Whether the main branch has it too. */
			onMain: z.boolean()
		})
	),
	/** Where the next page starts, and whether the main branch has that commit; null after the last. */
	next: z.object({ commit: commitId, onMain: z.boolean() }).nullable()
});
export type CommitsView = z.output<typeof CommitsSchema>;
export type CommitView = CommitsView['commits'][number];

/** GET /api/history/size?directory=…&from=…&to=…: the size of a run of commits, `from` absent for nothing before. */
export const RunSizeQuerySchema = z.object({
	directory: absolutePath,
	from: commitId.optional(),
	to: commitId
});
export type RunSizeQuery = z.output<typeof RunSizeQuerySchema>;

export const RunSizeSchema = z.object({ size: CommitSizeSchema.nullable() });
export type RunSizeView = z.output<typeof RunSizeSchema>;

/** POST /api/history/check: asks the repository's remotes what they have. Only when the person asks. */
export const RemoteCheckRequestSchema = z.object({ directory: absolutePath });
export type RemoteCheckRequest = z.input<typeof RemoteCheckRequestSchema>;

export const RemoteCheckSchema = z.object({
	remotes: z.array(
		z.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('compared'),
				remote: remoteName,
				/** Branches, by their name on the remote, with commits this copy has not fetched. */
				changed: z.array(z.string()),
				/** Branches on the remote this copy has never fetched. */
				added: z.array(z.string())
			}),
			z.object({ kind: z.literal('failed'), remote: remoteName, problem: message })
		])
	)
});
export type RemoteCheckView = z.output<typeof RemoteCheckSchema>;

/**
 * POST /api/history/pull-requests: the repository's open pull requests on
 * GitHub, a network call made only when the person opens the list.
 */
export const PullRequestsRequestSchema = z.object({ directory: absolutePath });
export type PullRequestsRequest = z.input<typeof PullRequestsRequestSchema>;

export const PullRequestsSchema = z.object({
	/** The repository on GitHub, as GitHub names it: `owner/name`. */
	repository: z.string(),
	/** What the list says of itself: how many, in which repository, and what to do. */
	summary: message,
	pulls: z.array(
		z.object({
			/** Its address, which opens it. */
			source,
			number: z.number().int().positive(),
			/** `#12 Add a discount rate`, with what cannot be seen written out. */
			title: message,
			/** Who opened it, from which branch into which, and when it was updated. */
			details: message,
			draft: z.boolean()
		})
	),
	/** Whether GitHub has more than were listed. */
	more: z.boolean()
});
export type PullRequestsView = z.output<typeof PullRequestsSchema>;
export type PullRequestView = PullRequestsView['pulls'][number];

/** What every refused request answers with: what happened and what to do next. */
export const ApiErrorBodySchema = z.object({
	error: z.object({
		/** The kind of error, such as `ReportNotFound`. */
		kind: z.string(),
		message
	})
});
export type ApiErrorBody = z.output<typeof ApiErrorBodySchema>;

const editCount = parsed(z.number(), parseEditCount);

const commentRange = z.strictObject({
	path: escapedPath,
	side: z.enum(['old', 'new']),
	first: lineNumber,
	last: lineNumber
});
/** A comment's words, or a flag's; only a flag's may be empty, which the report service checks. */
const commentBody = z.string().max(MAX_COMMENT_LENGTH, 'the comment is too long');

/** A comment, the reviewer's words on lines, or a flag, their "look at this again", whose words are optional. */
const threadKind = z.enum(['comment', 'flag']);

/** What a comment or a flag is: its kind, the version its lines are in, its lines and its words. */
const draftThread = z.strictObject({
	kind: threadKind,
	version,
	anchor: commentRange,
	body: commentBody
});

/** POST /api/diffs/[id]/comments: a new comment, or a flag, on lines of the version the page shows. */
export const AddDraftCommentSchema = draftThread.refine(
	({ kind, body }) => kind === 'flag' || body.trim() !== '',
	{ message: 'write a comment before saving', path: ['body'] }
);
export type AddDraftComment = z.infer<typeof AddDraftCommentSchema>;

/** POST /api/diffs/[id]/comments/[comment]: a comment's or a flag's new words, from a page that shows `version`. */
export const EditDraftCommentSchema = z.strictObject({
	version,
	/** How many times the comment's words had been changed when the page read them. */
	edits: editCount,
	body: commentBody
});
export type EditDraftComment = z.infer<typeof EditDraftCommentSchema>;

/** DELETE /api/diffs/[id]/comments/[comment], from a page that shows `version`. */
export const DeleteDraftCommentSchema = z.strictObject({ version, edits: editCount });
export type DeleteDraftComment = z.infer<typeof DeleteDraftCommentSchema>;

const draftCommentId = parsed(z.number(), parseDraftCommentId);

/** One saved comment or flag: the version its lines are in, its words, and when they were written. */
export const DraftCommentSchema = draftThread.extend({
	id: draftCommentId,
	/** The thread of an earlier review it replies to, or null for a comment of the draft's own. */
	replyTo: threadId.nullable(),
	writtenAt: timestamp,
	/** When its words were last changed, or null while they are as first written. */
	editedAt: timestamp.nullable(),
	/** How many times its words have been changed: sent back with a change or a deletion. */
	edits: editCount
});
export type DraftCommentView = z.infer<typeof DraftCommentSchema>;

/** The draft's overall review: its words ('' for none), when they last changed, and how many times. */
export const OverallReviewSchema = z.strictObject({
	body: z.string(),
	/** When its words last changed, or null when they never have. */
	changedAt: timestamp.nullable(),
	/** How many times its words have been changed: sent back with a change, and to finish. */
	edits: editCount
});
export type OverallReviewView = z.infer<typeof OverallReviewSchema>;

/** POST /api/diffs/[id]/overall: the overall review's new words, on the words the page read. */
export const SaveOverallReviewSchema = z.strictObject({
	edits: editCount,
	/** Exactly as typed; only white space empties it. */
	body: z.string().max(MAX_OVERALL_REVIEW_LENGTH, 'the overall review is too long')
});
export type SaveOverallReview = z.infer<typeof SaveOverallReviewSchema>;

/** A thread of an earlier review the draft resolves, or opens again. */
const shownResolution = z.strictObject({ thread: threadId, resolved: z.boolean() });

/** GET /api/diffs/[id]/comments: the whole draft, with the daemon's time to say how long ago. */
export const DraftCommentsSchema = z.strictObject({
	now: timestamp,
	comments: z.array(DraftCommentSchema),
	overall: OverallReviewSchema,
	/** The threads of earlier reviews it resolves or opens again. */
	resolutions: z.array(shownResolution)
});
export type DraftCommentsView = z.infer<typeof DraftCommentsSchema>;

/**
 * POST /api/diffs/[id]/notes, from a page that shows `version`, the current
 * one: dismisses a note, promotes one into the draft, or brings back every
 * note dismissed on the version.
 */
export const NoteActionSchema = z.discriminatedUnion('action', [
	z.strictObject({ action: z.literal('dismiss'), version, note: agentNoteId }),
	z.strictObject({ action: z.literal('promote'), version, note: agentNoteId }),
	z.strictObject({ action: z.literal('bring-back'), version })
]);
export type NoteAction = z.infer<typeof NoteActionSchema>;

/** What a note action left: the version's notes, and the comment a promoted note became. */
export const NotesChangedSchema = z.strictObject({
	notes: z.array(AgentNoteSchema),
	comment: DraftCommentSchema.nullable()
});
export type NotesChangedView = z.infer<typeof NotesChangedSchema>;

/**
 * POST /api/diffs/[id]/requests, from a page that shows `version`, the
 * current one: asks the agent about lines, a file or a section, cancels a
 * question, or promotes an answered one into the draft.
 */
export const RequestActionSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('ask'),
		version,
		about: z.discriminatedUnion('kind', [
			z.strictObject({
				kind: z.literal('lines'),
				path: escapedPath,
				side,
				first: lineNumber,
				last: lineNumber
			}),
			z.strictObject({ kind: z.literal('file'), path: escapedPath }),
			z.strictObject({ kind: z.literal('section'), section: sectionId })
		]),
		question: z.string().max(MAX_QUESTION_LENGTH * 2)
	}),
	z.strictObject({ action: z.literal('cancel'), version, request: agentRequestId }),
	z.strictObject({ action: z.literal('promote'), version, request: agentRequestId })
]);
export type RequestAction = z.infer<typeof RequestActionSchema>;

/** What a request action left: the Delve's questions, the one just asked, and the comment a promoted one became. */
export const RequestsChangedSchema = z.strictObject({
	requests: z.array(AgentRequestSchema),
	asked: agentRequestId.nullable(),
	comment: DraftCommentSchema.nullable()
});
export type RequestsChangedView = z.infer<typeof RequestsChangedSchema>;

/**
 * POST /api/diffs/[id]/threads, from a page that shows `version`, the current
 * one: replies to a thread of an earlier review, resolves it, opens it again,
 * or takes back what the draft did to it.
 */
export const ThreadActionSchema = z.discriminatedUnion('action', [
	z.strictObject({ action: z.literal('reply'), version, thread: threadId, body: commentBody }),
	z.strictObject({ action: z.literal('resolve'), version, thread: threadId }),
	z.strictObject({ action: z.literal('reopen'), version, thread: threadId }),
	z.strictObject({ action: z.literal('undo'), version, thread: threadId })
]);
export type ThreadAction = z.infer<typeof ThreadActionSchema>;

/** What a thread action left: the draft's resolutions, and the reply just saved. */
export const ThreadsChangedSchema = z.strictObject({
	resolutions: z.array(shownResolution),
	comment: DraftCommentSchema.nullable()
});
export type ThreadsChangedView = z.infer<typeof ThreadsChangedSchema>;

/** A comment's id in an address, where it is text. */
export const DraftCommentIdInAddressSchema = parsed(
	z.string().regex(/^[1-9][0-9]{0,15}$/),
	(text) => parseDraftCommentId(Number(text))
);

/** A finished review's number in an address, where it is text. */
export const ReviewNumberInAddressSchema = parsed(z.string().regex(/^[1-9][0-9]{0,8}$/), (text) =>
	parseReviewNumber(Number(text))
);

// ── Finishing a review ───────────────────────────────────────────────────────

const reviewNumber = parsed(z.number(), parseReviewNumber);
const reviewText = z.string().transform(textForAgent);

/** A comment of the draft as the page showed it, so nothing else is handed over unseen. */
const shownComment = z.strictObject({ id: draftCommentId, edits: editCount });

/** GET /api/diffs/[id]/reviews/preview?version=N: from a page that shows `version`. */
export const ReviewPreviewQuerySchema = z.object({ version: inQuery(parseRevisionNumber) });

/** What finishing the draft now would hand over, numbered as the next review. */
export const ReviewPreviewSchema = z.strictObject({
	number: reviewNumber,
	text: reviewText,
	/** The draft's comments it holds: sent back to finish it. */
	comments: z.array(shownComment),
	/** How many times the overall review it holds had been changed: sent back to finish it. */
	overall: editCount,
	/** The threads of earlier reviews it resolves or opens again: sent back to finish it. */
	resolutions: z.array(shownResolution),
	/**
	 * For a pull request's Delve, what posting it would put on GitHub: the
	 * review's text as posted, without the hidden mark made then, and which
	 * comments go on their lines; the rest go in the text. Null for others.
	 */
	github: z.strictObject({ body: z.string(), onLines: z.array(draftCommentId) }).nullable()
});
export type ReviewPreviewView = z.infer<typeof ReviewPreviewSchema>;

/** POST /api/diffs/[id]/reviews: finish the draft the page showed, on the version it shows. */
export const FinishReviewSchema = z.strictObject({
	version,
	comments: z.array(shownComment).max(100_000),
	/** How many times the overall review had been changed when the page showed it. */
	overall: editCount,
	/** The threads of earlier reviews it resolved or opened again when the page showed it; left out, none. */
	resolutions: z.array(shownResolution).max(100_000).optional(),
	/**
	 * For a pull request's Delve, to post it to GitHub as one review too:
	 * published as `kind`, or, with `draft`, left a draft there, `kind` set aside.
	 */
	github: z.strictObject({ kind: z.enum(GITHUB_REVIEW_KINDS), draft: z.boolean() }).optional(),
	/**
	 * To finish and copy only without looking on GitHub for an earlier post of
	 * the review that went unanswered, which may then be on GitHub too: the
	 * reviewer's choice once GitHub could not be asked (`EarlierPostUnchecked`).
	 */
	forgetEarlierPost: z.literal(true).optional()
});
export type FinishReview = z.infer<typeof FinishReviewSchema>;

/** One way a review was handed over, again and again: how many times, the first and the latest. */
const handover = z.strictObject({
	times: parsed(z.number(), parseHandoverCount),
	first: timestamp,
	last: timestamp
});

/** A finished review: its number, the version it was finished on, and the text handed over. */
export const FinishedReviewSchema = z.strictObject({
	number: reviewNumber,
	version,
	submittedAt: timestamp,
	comments: parsed(z.number(), parseCommentCount),
	/** How many lines it flagged to look at again. */
	flags: parsed(z.number(), parseCommentCount),
	/** Whether it holds an overall review. */
	overall: z.boolean(),
	progress: z.strictObject({
		counted: unitCount,
		reviewed: unitCount,
		ignored: unitCount,
		uncategorised: unitCount
	}),
	text: reviewText,
	/** Where it was posted on GitHub, when it was. */
	posted: z
		.strictObject({
			as: z.enum(['comment', 'approve', 'request-changes', 'draft']),
			/** The review on GitHub, or for a draft, the pull request's changes, where it is submitted. */
			address: parsed(z.string(), parseGitHubReviewAddress),
			/** How many comments went in the review's text, since GitHub shows no lines for them. */
			inText: parsed(z.number(), parseCommentCount),
			at: timestamp
		})
		.nullable(),
	/** When it was copied from a page: at its finish or later; null when that was never noted. */
	copied: handover.nullable(),
	/** When an agent read it from its start with get_review; null when none has. */
	read: handover.nullable()
});
export type FinishedReviewView = z.infer<typeof FinishedReviewSchema>;

/**
 * POST /api/diffs/[id]/reviews's answer: the review just finished, and, when
 * it is one an earlier post had put on GitHub whose answer never came, found
 * there and finished as it was posted then, whether anything added or
 * changed since is still in the draft.
 */
export const JustFinishedSchema = FinishedReviewSchema.extend({
	earlier: z.strictObject({ draftKept: z.boolean() }).nullable()
});
export type JustFinishedView = z.infer<typeof JustFinishedSchema>;

/** GET /api/diffs/[id]/reviews: every finished review, oldest first, with the daemon's time. */
export const FinishedReviewsSchema = z.strictObject({
	now: timestamp,
	reviews: z.array(FinishedReviewSchema)
});
export type FinishedReviewsView = z.infer<typeof FinishedReviewsSchema>;

// ── A Delve's history (DESIGN 6.4) ───────────────────────────────────────────

const threadStatus = z.enum(['open', 'changed', 'resolved']);

/**
 * GET /api/diffs/[id]/history: the Delve's versions and finished reviews in
 * the order they happened, each in words, with the daemon's time.
 */
export const DelveHistorySchema = z.strictObject({
	now: timestamp,
	/** The Delve's title, as its page has it. */
	title: message,
	/** Its current version. */
	version,
	entries: z.array(
		z.discriminatedUnion('kind', [
			z.strictObject({
				kind: z.literal('version'),
				version,
				arrivedAt: timestamp,
				/** What it brought: "The first version." or what its update did. */
				text: message
			}),
			z.strictObject({
				kind: z.literal('review'),
				/** Without its text, which its own page gives. */
				review: FinishedReviewSchema.omit({ text: true }),
				/** What it held: "1 comment and 1 earlier comment resolved or reopened". */
				held: message,
				/** How it was handed over, one sentence for each way. */
				deliveries: z.array(message),
				/** Where its comments stand today, "Today: 1 open, 1 resolved"; null when it has none. */
				today: message.nullable()
			})
		])
	)
});
export type DelveHistoryView = z.infer<typeof DelveHistorySchema>;

/**
 * GET /api/diffs/[id]/reviews/[review]: one finished review, read-only: the
 * text handed over, how it was handed over, and each thing it held against
 * the version it was written on, with its thread's status today.
 */
export const PastReviewSchema = z.strictObject({
	now: timestamp,
	title: message,
	/** The Delve's current version, against which "today" is said. */
	current: version,
	/** The Delve's latest review, to go to the one before or after. */
	latest: reviewNumber,
	review: FinishedReviewSchema,
	/** What it held: "1 comment and 1 earlier comment resolved or reopened". */
	held: message,
	deliveries: z.array(message),
	items: z.array(
		z.strictObject({
			/** "Comment", "Flag", "Reply to review 1". */
			kind: message,
			version,
			anchor: threadAnchor,
			body: z.string(),
			status: threadStatus
		})
	),
	resolutions: z.array(
		z.strictObject({
			resolved: z.boolean(),
			from: reviewNumber.nullable(),
			anchor: threadAnchor.nullable(),
			status: threadStatus
		})
	)
});
export type PastReviewView = z.infer<typeof PastReviewSchema>;

/** POST /api/diffs/[id]/reviews/[review]/copied's answer: noted. */
export const HandoverNotedSchema = z.strictObject({ noted: z.literal(true) });
export type HandoverNoted = z.infer<typeof HandoverNotedSchema>;

// ── Having an agent sort a Delve ─────────────────────────────────────────────

/**
 * GET /api/diffs/:id/agent: how to have a coding agent sort this Delve, asked
 * for when a person opens the instructions on its page. Everything to copy is
 * for the daemon that answers (its copy of diff delver and its data folder)
 * and for this Delve.
 */
export const AgentSortingSchema = z.strictObject({
	/** Step 1: what gives an agent this diff delver as its MCP server. */
	connect: z.strictObject({
		/** For a terminal: `diff-delver setup` for this copy, which connects every agent it finds. */
		setup: toCopy,
		/** For a terminal: Claude Code's command that adds it. */
		claudeCode: toCopy,
		/** For Codex's `config.toml`: its entry. */
		codex: toCopy,
		/** For any other agent's MCP server entry: the command it runs. */
		other: toCopy
	}),
	/** Step 2: the folder to start the agent in, the Delve's repository. */
	folder: z.strictObject({
		/** The folder as a sentence names it. */
		shown: message,
		/** For a terminal: the command that goes there. */
		command: toCopy,
		/** Whether the folder is still there. */
		there: z.boolean()
	}),
	/** Step 3: what to paste to the agent, which names this Delve. */
	request: toCopy,
	/** The agent this daemon last heard from, if any: when, and where it was started. */
	heard: z
		.strictObject({
			text: message,
			/** It was started in this Delve's repository. */
			here: z.boolean()
		})
		.nullable(),
	/** When an agent last called a tool on this Delve, in words, if one has since the daemon started. */
	worked: message.nullable()
});
export type AgentSorting = z.output<typeof AgentSortingSchema>;
