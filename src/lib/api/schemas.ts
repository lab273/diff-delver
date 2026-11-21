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
import { parseByteSize } from '#lib/core/byte-size.tiny.ts';
import { parseLineCount } from '#lib/core/line-count.tiny.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { parseLineText } from '#lib/core/line-text.tiny.ts';
import { parsePartPosition } from '#lib/core/part-position.tiny.ts';
import { parseSliceCount } from '#lib/core/slice-count.tiny.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import { parseEscapedPath } from '#lib/core/path-bytes.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { ok, err, type Result } from '#lib/core/result.ts';
import { parseGroupText } from '#lib/core/viewer/group-text.ts';
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
const lineNumber = parsed(z.number(), parseLineNumber);
const byteSize = parsed(z.number(), parseByteSize);
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

const sectionId = parsed(z.string(), parseSectionId);

/** A group of the page: a section, the tests of a section, Ignored or Not sorted yet. */
export const GroupKeySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('section'), section: sectionId }),
	z.object({ kind: z.literal('tests'), section: sectionId }),
	z.object({ kind: z.literal('ignored') }),
	z.object({ kind: z.literal('uncategorised') })
]);
export type GroupKeyView = z.output<typeof GroupKeySchema>;

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
	/** How the file changed, saying only what is in this part: "changed", "renamed from src/old.ts". */
	change: message,
	added: lineCount,
	removed: lineCount,
	/** What the change to the file itself stands for, when it is in this part: "made executable". */
	fileUnit: message.nullable(),
	ignored: z.array(IgnoreReasonSchema),
	tally: TallySchema,
	/** How many rows its lines take when drawn, hidden lines aside. */
	rows: lineCount,
	/** Part 2 of 3. */
	position: parsed(z.number(), parsePartPosition),
	of: parsed(z.number(), parseSliceCount),
	/** The groups the file's other parts are in, in reading order. */
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

/** GET /api/diffs/:id: a diff's page, without the code, which comes a part at a time. */
export const DiffPageSchema = z.object({
	now: timestamp,
	summary: DiffSummarySchema,
	/** The folder the diff was opened in, to open what its changes became. Never shown. */
	directory: absolutePath,
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
export const PageQuerySchema = z.object({
	view: ViewSchema.default('sections'),
	version: inQuery(parseRevisionNumber).optional()
});
export type PageQuery = z.input<typeof PageQuerySchema>;

/** GET /api/diffs/:id/part: which part, of the version the page shows. */
export const PartQuerySchema = z.object({
	version: inQuery(parseRevisionNumber),
	view: ViewSchema,
	/** The group as `groupKeyId` writes it: `uncategorised`, `section:auth`. */
	group: parsed(z.string(), parseGroupText),
	path: escapedPath
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

/** Where a changed line of a part belongs: here (and whether it is new), or in another group. */
const LineHomeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('here'), fresh: z.boolean() }),
	z.object({ kind: z.literal('elsewhere'), group: GroupKeySchema })
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
				groups: z.array(GroupKeySchema),
				lines: z.array(ShownLineSchema)
			})
		])
	),
	/** For a binary file, its size on each side it has. */
	sizes: z.object({ old: byteSize.nullable(), new: byteSize.nullable() }).nullable()
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
// version 1 never marks what is new in version 2.

/** POST /api/diffs/:id/reviewed: marks a part of the shown version as reviewed, or not. */
export const MarkReviewedRequestSchema = z.object({
	version,
	target: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('slice'), group: GroupKeySchema, path: escapedPath }),
		z.object({ kind: z.literal('file'), path: escapedPath }),
		z.object({ kind: z.literal('group'), group: GroupKeySchema })
	]),
	reviewed: z.boolean(),
	view: ViewSchema
});
export type MarkReviewedRequest = z.input<typeof MarkReviewedRequestSchema>;

/**
 * What marking changed: the diff's summary with its progress, and the parts
 * and files of every file it touched, which the page puts in place of its own;
 * the groups' figures are their parts' sums.
 */
export const MarkedSchema = z.object({
	summary: DiffSummarySchema,
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
