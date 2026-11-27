/**
 * The `agent_requests`, `request_answers` and `request_answer_excerpts`
 * tables: the reviewer's questions to the agent (DESIGN 5 `request`, 7.2) and
 * its answers, with the code each answer pointed at. Kept apart from the
 * draft, so nothing that reads a review reads them. The only code that sees
 * their rows.
 */
import { z } from 'zod';
import { parseAgentMarkdown, type AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { parseAgentRequestId, type AgentRequestId } from '#lib/core/agent-request-id.tiny.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { parseLineText } from '#lib/core/line-text.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { andThen, map, ok, type Result } from '#lib/core/result.ts';
import {
	MAX_EXCERPT_LINES,
	type AgentRequest,
	type RequestAnchor,
	type RequestAnswer,
	type RequestExcerpt,
	type RequestStatus
} from '#lib/core/review/agent-request.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseSectionTitle } from '#lib/core/section-title.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { nullable, parseRow, parseRows, repoPath, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const STATUSES = ['waiting', 'delivered', 'answered', 'cancelled'] as const;

const requestColumns = z.object({
	id: whole(parseAgentRequestId),
	version: whole(parseRevisionNumber),
	about: z.enum(['lines', 'file', 'section']),
	path: nullable(repoPath),
	side: nullable(z.enum(['old', 'new'])),
	first: nullable(whole(parseLineNumber)),
	last: nullable(whole(parseLineNumber)),
	section: nullable(text(parseSectionId)),
	title: nullable(text(parseSectionTitle)),
	question: z.string().min(1),
	askedAt: timestamp,
	status: z.enum(STATUSES),
	promoted: z.union([z.literal(0), z.literal(1)])
});

type RequestColumns = z.output<typeof requestColumns>;

const requestRow = requestColumns.transform((r, context): RequestRow => {
	const anchor = anchorOf(r);
	if (anchor === undefined) {
		context.addIssue({ code: 'custom', message: 'its anchor does not fit what it is about' });
		return z.NEVER;
	}
	return {
		id: r.id,
		version: r.version,
		anchor,
		question: r.question,
		askedAt: r.askedAt,
		status: r.status,
		promoted: r.promoted === 1
	};
});

type RequestRow = Omit<AgentRequest, 'answers'>;

function anchorOf(r: RequestColumns): RequestAnchor | undefined {
	switch (r.about) {
		case 'lines':
			return r.path === undefined ||
				r.side === undefined ||
				r.first === undefined ||
				r.last === undefined ||
				r.last < r.first
				? undefined
				: { kind: 'lines', path: r.path, side: r.side, first: r.first, last: r.last };
		case 'file':
			return r.path === undefined ? undefined : { kind: 'file', path: r.path };
		case 'section':
			return r.section === undefined || r.title === undefined
				? undefined
				: { kind: 'section', section: r.section, title: r.title };
	}
}

const reportColumn = z.object({ report: text(parseReportId) }).transform(({ report }) => report);

const answerRow = z.object({
	id: z.number().int(),
	request: whole(parseAgentRequestId),
	version: whole(parseRevisionNumber),
	body: text(parseAgentMarkdown),
	answeredAt: timestamp
});

const excerptRow = z
	.object({
		answer: z.number().int(),
		path: repoPath,
		side: z.enum(['old', 'new']),
		first: whole(parseLineNumber),
		last: whole(parseLineNumber),
		lines: z.string().transform((value, context) => {
			const parsed = z.array(text(parseLineText)).max(MAX_EXCERPT_LINES).safeParse(safeJson(value));
			if (parsed.success) return parsed.data;
			context.addIssue({ code: 'custom', message: 'its lines are not a list of lines' });
			return z.NEVER;
		})
	})
	.refine(({ first, last }) => last >= first);

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

const COLUMNS = `a.id, r.number AS version, a.about, a.path, a.side, a.first_line AS first,
	a.last_line AS last, a.section_id AS section, a.section_title AS title, a.question,
	a.asked_at AS askedAt, a.status, a.promoted`;

/** Answers and their excerpts for the requests of the rows given. */
function withAnswers(
	q: Queries,
	rows: readonly RequestRow[],
	where: string,
	param: string | number
): Result<readonly AgentRequest[], StoredRowInvalid> {
	if (rows.length === 0) return ok([]);
	return andThen(
		parseRows(
			'agent_requests',
			answerRow,
			q.all(
				`SELECT n.id, n.request_id AS request, r.number AS version, n.body, n.answered_at AS answeredAt
				 FROM request_answers n JOIN revisions r ON r.id = n.revision_id
				 JOIN agent_requests a ON a.id = n.request_id JOIN revisions ar ON ar.id = a.revision_id
				 WHERE ${where} ORDER BY n.id`,
				param
			)
		),
		(answers) =>
			andThen(
				parseRows(
					'agent_requests',
					excerptRow,
					q.all(
						`SELECT x.answer_id AS answer, x.path, x.side, x.first_line AS first,
							x.last_line AS last, x.lines
						 FROM request_answer_excerpts x JOIN request_answers n ON n.id = x.answer_id
						 JOIN agent_requests a ON a.id = n.request_id JOIN revisions ar ON ar.id = a.revision_id
						 WHERE ${where} ORDER BY x.answer_id, x.position`,
						param
					)
				),
				(excerpts) => {
					const byAnswer = new Map<number, RequestExcerpt[]>();
					for (const { answer, ...excerpt } of excerpts) {
						const list = byAnswer.get(answer) ?? [];
						list.push(excerpt);
						byAnswer.set(answer, list);
					}
					const byRequest = new Map<AgentRequestId, RequestAnswer[]>();
					for (const answer of answers) {
						const list = byRequest.get(answer.request) ?? [];
						list.push({
							body: answer.body,
							answeredAt: answer.answeredAt,
							version: answer.version,
							excerpts: byAnswer.get(answer.id) ?? []
						});
						byRequest.set(answer.request, list);
					}
					return ok(rows.map((row) => ({ ...row, answers: byRequest.get(row.id) ?? [] })));
				}
			)
	);
}

/** Every request of a report, on every version, in the order asked, with their answers. */
export function agentRequestsOf(
	q: Queries,
	report: ReportId
): Result<readonly AgentRequest[], StoredRowInvalid> {
	return andThen(
		parseRows(
			'agent_requests',
			requestRow,
			q.all(
				`SELECT ${COLUMNS} FROM revisions r JOIN agent_requests a ON r.id = a.revision_id
				 WHERE r.report_id = ? ORDER BY a.id`,
				report
			)
		),
		(rows) => withAnswers(q, rows, 'ar.report_id = ?', report)
	);
}

/** One request, with the report it belongs to, or undefined when there is none with that id. */
export function agentRequestOf(
	q: Queries,
	id: AgentRequestId
): Result<
	{ readonly report: ReportId; readonly request: AgentRequest } | undefined,
	StoredRowInvalid
> {
	const found = q.get(
		`SELECT ${COLUMNS}, r.report_id AS report FROM revisions r
		 JOIN agent_requests a ON r.id = a.revision_id WHERE a.id = ?`,
		id
	);
	if (found === undefined) return ok(undefined);
	const report = parseRow('agent_requests', reportColumn, found);
	if (!report.ok) return report;
	return andThen(parseRow('agent_requests', requestRow, found), (row) =>
		andThen(withAnswers(q, [row], 'a.id = ?', id), ([request]) =>
			ok(request === undefined ? undefined : { report: report.value, request })
		)
	);
}

/**
 * The requests of a report no agent has answered or the reviewer cancelled,
 * waiting or delivered, oldest first; an open request has no answers yet.
 */
export function openAgentRequestsOf(
	q: Queries,
	report: ReportId
): Result<readonly AgentRequest[], StoredRowInvalid> {
	return map(
		parseRows(
			'agent_requests',
			requestRow,
			q.all(
				`SELECT ${COLUMNS} FROM revisions r JOIN agent_requests a ON r.id = a.revision_id
				 WHERE r.report_id = ? AND a.status IN ('waiting', 'delivered') ORDER BY a.id`,
				report
			)
		),
		(rows) => rows.map((row) => ({ ...row, answers: [] }))
	);
}

export function insertAgentRequest(
	q: Queries,
	revision: RevisionId,
	anchor: RequestAnchor,
	question: string,
	now: Timestamp
): AgentRequestId | undefined {
	const lines = anchor.kind === 'lines' ? anchor : undefined;
	const saved = q.get(
		`INSERT INTO agent_requests (revision_id, about, path, side, first_line, last_line,
			section_id, section_title, question, asked_at, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting') RETURNING id`,
		revision,
		anchor.kind,
		anchor.kind === 'section' ? null : repoPathBytes(anchor.path),
		lines?.side ?? null,
		lines?.first ?? null,
		lines?.last ?? null,
		anchor.kind === 'section' ? anchor.section : null,
		anchor.kind === 'section' ? anchor.title : null,
		question,
		now
	);
	const id = parseAgentRequestId(Number(saved?.['id']));
	return id.ok ? id.value : undefined;
}

export function setRequestStatus(q: Queries, id: AgentRequestId, status: RequestStatus): void {
	q.run('UPDATE agent_requests SET status = ? WHERE id = ?', status, id);
}

export function setRequestPromoted(q: Queries, id: AgentRequestId): void {
	q.run('UPDATE agent_requests SET promoted = 1 WHERE id = ?', id);
}

export function insertRequestAnswer(
	q: Queries,
	request: AgentRequestId,
	revision: RevisionId,
	body: AgentMarkdown,
	excerpts: readonly RequestExcerpt[],
	now: Timestamp
): void {
	const saved = q.get(
		`INSERT INTO request_answers (request_id, revision_id, body, answered_at)
		 VALUES (?, ?, ?, ?) RETURNING id`,
		request,
		revision,
		body,
		now
	);
	const answer = Number(saved?.['id']);
	excerpts.forEach((excerpt, position) => {
		q.run(
			`INSERT INTO request_answer_excerpts (answer_id, position, path, side, first_line, last_line, lines)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			answer,
			position,
			repoPathBytes(excerpt.path),
			excerpt.side,
			excerpt.first,
			excerpt.last,
			JSON.stringify(excerpt.lines.slice(0, MAX_EXCERPT_LINES))
		);
	});
	setRequestStatus(q, request, 'answered');
}
