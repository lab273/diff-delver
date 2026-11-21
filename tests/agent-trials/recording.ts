/**
 * A trial's recording (tests/agent-trials/README.md): what one agent did with
 * one fixture, as committed in `recordings/`. The schema is the one place its
 * shape is written down; `run.ts` writes recordings, the replay reads them.
 *
 * Recordings are public, so everything that varies by machine or run is
 * written as a placeholder (`normaliser`): the trial's folders as
 * `<repository>`, `<data>` and `<trial>`, and as a CLI names a folder after
 * one, with every character but letters and digits a dash
 * (`-tmp-diff-delver-trial-c429n9-work-shop`, written `<repository-dashed>`);
 * the daemon's port and entry codes; the login shell a CLI ran commands in
 * (`<shell> -lc`); and the machine's home folder and user name. A replay puts
 * the real values back where the agent sent them.
 */
import { z } from 'zod';

export const AGENTS = ['claude', 'codex', 'scripted'] as const;
export type AgentName = (typeof AGENTS)[number];

const Answer = z.object({ text: z.string(), refused: z.boolean() });

export const RecordedCallSchema = z.object({
	tool: z.string(),
	arguments: z.record(z.string(), z.unknown()),
	/** Undefined when the run ended before the server answered. */
	answer: Answer.optional()
});
export type RecordedCall = z.output<typeof RecordedCallSchema>;

export const SortedReportSchema = z.object({
	id: z.string(),
	source: z.string(),
	version: z.number(),
	overview: z.string().nullable(),
	sections: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				summary: z.string().nullable(),
				references: z.array(z.string()).readonly()
			})
		)
		.readonly(),
	placements: z.array(z.string()).readonly()
});

export const OUTCOMES = ['finished', 'time-limit', 'turn-limit', 'failed'] as const;

export const RecordingSchema = z.object({
	format: z.literal(1),
	fixture: z.string(),
	agent: z.object({
		cli: z.enum(AGENTS),
		/** As the CLI printed it with --version. */
		cliVersion: z.string(),
		/** As the CLI reported the model it used, or as it was asked for when it reports none. */
		model: z.string()
	}),
	/** The day it was recorded, YYYY-MM-DD. */
	recordedOn: z.string(),
	prompt: z.string(),
	skill: z.boolean(),
	/** SHA-256 of what the agent was given, so a recording can be told apart from the current tools. */
	hashes: z.object({ agentSurface: z.string(), skill: z.string() }),
	bounds: z.object({ timeLimitSeconds: z.number(), turnLimit: z.number().nullable() }),
	outcome: z.enum(OUTCOMES),
	/** Why, for anything but `finished`. */
	outcomeDetail: z.string().nullable(),
	/**
	 * What the agent's session loaded, as the CLI reported it: the evidence that
	 * it had our MCP server and skill and none of the person's own.
	 */
	session: z.object({
		mcpServers: z.array(z.string()),
		tools: z.array(z.string()),
		skills: z.array(z.string()),
		plugins: z.array(z.string()),
		instructions: z.array(z.string())
	}),
	/** Every MCP message, in the order the proxy saw it, by what it was. */
	messages: z.array(z.string()).readonly(),
	calls: z.array(RecordedCallSchema).readonly(),
	/** The agent's last message to the person. */
	finalMessage: z.string(),
	finalState: z.array(SortedReportSchema).readonly(),
	summary: z.object({
		fullCoverage: z.boolean(),
		sections: z.number(),
		callsByTool: z.record(z.string(), z.number()),
		refusals: z.array(z.object({ call: z.number(), tool: z.string(), text: z.string() })),
		/** What the agent did that the skill forbids, in words. */
		forbidden: z.array(z.string()),
		/** Commands the agent ran outside our tools, as it reported them. */
		commands: z.array(z.string()),
		wallSeconds: z.number(),
		turns: z.number().nullable(),
		tokens: z
			.object({
				input: z.number(),
				output: z.number(),
				cacheRead: z.number(),
				cacheWrite: z.number()
			})
			.nullable()
	})
});
export type Recording = z.output<typeof RecordingSchema>;

/** The file a recording is kept in: `shop.claude.json`, `shop.codex.no-skill.json`. */
export function recordingName(fixture: string, agent: AgentName, skill: boolean): string {
	return `${fixture}.${agent}${skill ? '' : '.no-skill'}.json`;
}

/** The values a recording writes as placeholders, longest first so a folder inside another is caught first. */
export interface Placeholders {
	readonly repository: string;
	readonly data: string;
	readonly trial: string;
	/** The machine's home folder and user name, which must never reach a recording. */
	readonly home?: string;
	readonly user?: string;
}

export type Normaliser = (text: string) => string;

const ADDRESS = /http:\/\/(?:127\.0\.0\.1|localhost):\d+/g;
const ENTRY_CODE = /([?&](?:code|entry)=)[A-Za-z0-9_-]+/g;
/**
 * A trial's folder as a CLI names a folder after it, which the exact values
 * miss in a recording made before they were written as placeholders: the
 * dashed path of a folder `mkdtemp` made, `diff-delver-trial-` and six
 * letters or digits.
 */
const DASHED_TRIAL =
	/(?<=^|[/"'\s])-[A-Za-z0-9-]*?diff-delver-trial-[A-Za-z0-9]{6}(?![A-Za-z0-9])/g;
/** The login shell a CLI runs a command in, which is the machine's: `/usr/bin/zsh -lc`. */
const LOGIN_SHELL = /(?<=^|[\s"'(:])(?:\/[\w.+-]+)+\/(?:zsh|bash|fish|dash|ksh|sh)(?= -l?c )/g;

/** A path as a CLI names a folder after it: every character but letters and digits a dash. */
export function dashed(path: string): string {
	return path.replace(/[^A-Za-z0-9]/g, '-');
}

export function normaliser(values: Placeholders): Normaliser {
	const pairs: [string, string][] = [
		[values.repository, '<repository>'],
		[values.data, '<data>'],
		[values.trial, '<trial>']
	];
	for (const [name, path] of [
		['repository', values.repository],
		['data', values.data],
		['trial', values.trial]
	] as const) {
		if (path.startsWith('/') && path.length > 4) pairs.push([dashed(path), `<${name}-dashed>`]);
	}
	if (values.home !== undefined && values.home.length > 1) pairs.push([values.home, '<home>']);
	pairs.sort((a, b) => b[0].length - a[0].length);
	const user =
		values.user !== undefined && values.user.length >= 3
			? new RegExp(`\\b${values.user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
			: undefined;
	return (text) => {
		let out = text;
		for (const [from, to] of pairs) out = out.split(from).join(to);
		out = out
			.replace(DASHED_TRIAL, '<trial-dashed>')
			.replace(LOGIN_SHELL, '<shell>')
			.replace(ADDRESS, 'http://127.0.0.1:<port>')
			.replace(ENTRY_CODE, '$1<code>');
		return user === undefined ? out : out.replace(user, '<user>');
	};
}

/** Applies `normalise` to every string in a JSON value. */
export function normaliseDeep(value: unknown, normalise: Normaliser): unknown {
	if (typeof value === 'string') return normalise(value);
	if (Array.isArray(value)) {
		const items: readonly unknown[] = value;
		return items.map((item) => normaliseDeep(item, normalise));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, normaliseDeep(child, normalise)])
		);
	}
	return value;
}

/** Puts the real values back into what the agent sent, for a replay. */
export function denormaliser(values: {
	readonly repository: string;
	readonly data: string;
	readonly trial: string;
}): Normaliser {
	return (text) =>
		text
			.split('<repository>')
			.join(values.repository)
			.split('<data>')
			.join(values.data)
			.split('<trial>')
			.join(values.trial);
}

// --- From the proxy's log ------------------------------------------------------

const LogLine = z.object({
	seq: z.number(),
	from: z.enum(['agent', 'server']),
	message: z.unknown().optional(),
	text: z.string().optional()
});

const Message = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().optional(),
	params: z.unknown().optional(),
	result: z.unknown().optional(),
	error: z.unknown().optional()
});

const ToolCallParams = z.object({
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()).optional()
});

const ToolResult = z.object({
	content: z.array(z.unknown()),
	isError: z.boolean().optional()
});

const TextContent = z.object({ type: z.literal('text'), text: z.string() });

export interface ProxyLog {
	/** Every message, by what it was: `agent → initialize`, `server ← tools/call #4`. */
	readonly messages: readonly string[];
	readonly calls: readonly RecordedCall[];
}

/** Reads the proxy's log: every message in order, and each tool call with its answer. */
export function readProxyLog(jsonl: string): ProxyLog {
	const messages: string[] = [];
	const calls: {
		tool: string;
		arguments: Record<string, unknown>;
		answer?: z.output<typeof Answer>;
	}[] = [];
	const pending = new Map<string, number>();
	const methods = new Map<string, string>();
	for (const line of jsonl.split('\n')) {
		if (line.trim() === '') continue;
		const entry = LogLine.parse(JSON.parse(line));
		if (entry.text !== undefined) {
			messages.push(`${entry.from}: not JSON`);
			continue;
		}
		const message = Message.parse(entry.message);
		const id = message.id === undefined ? undefined : String(message.id);
		if (message.method !== undefined) {
			messages.push(`${entry.from} → ${message.method}${id === undefined ? '' : ` #${id}`}`);
			if (id !== undefined) methods.set(`${entry.from}:${id}`, message.method);
			if (message.method === 'tools/call' && entry.from === 'agent' && id !== undefined) {
				const params = ToolCallParams.parse(message.params);
				pending.set(id, calls.length);
				calls.push({ tool: params.name, arguments: params.arguments ?? {} });
			}
			continue;
		}
		const asker = entry.from === 'server' ? 'agent' : 'server';
		const method = id === undefined ? undefined : methods.get(`${asker}:${id}`);
		messages.push(
			`${entry.from} ← ${method ?? 'answer'}${id === undefined ? '' : ` #${id}`}${message.error === undefined ? '' : ' (error)'}`
		);
		const index = id === undefined || entry.from !== 'server' ? undefined : pending.get(id);
		const call = index === undefined ? undefined : calls[index];
		if (call === undefined || method !== 'tools/call') continue;
		if (message.error !== undefined) {
			call.answer = { text: `Protocol error: ${JSON.stringify(message.error)}`, refused: true };
			continue;
		}
		const result = ToolResult.parse(message.result);
		const texts = result.content.map((c) => {
			const parsed = TextContent.safeParse(c);
			return parsed.success ? parsed.data.text : JSON.stringify(c);
		});
		call.answer = { text: texts.join('\n'), refused: result.isError === true };
	}
	return { messages, calls };
}

// --- What the skill forbids ------------------------------------------------------

/** Text the agent wrote for the person: titles, summaries, the overview, ignore reasons. */
function writtenTexts(calls: readonly RecordedCall[]): readonly { where: string; text: string }[] {
	const out: { where: string; text: string }[] = [];
	calls.forEach((call, i) => {
		const args = call.arguments;
		if (call.tool === 'set_overview' && typeof args['markdown'] === 'string') {
			out.push({ where: `call ${String(i + 1)} (set_overview)`, text: args['markdown'] });
		}
		if (call.tool === 'upsert_sections' && Array.isArray(args['sections'])) {
			const sections: readonly unknown[] = args['sections'];
			for (const section of sections) {
				const parsed = z
					.object({ id: z.unknown(), title: z.unknown(), summary: z.unknown() })
					.partial()
					.safeParse(section);
				if (!parsed.success) continue;
				for (const field of ['title', 'summary'] as const) {
					const value = parsed.data[field];
					if (typeof value === 'string') {
						out.push({
							where: `call ${String(i + 1)} (upsert_sections, ${String(parsed.data.id)} ${field})`,
							text: value
						});
					}
				}
			}
		}
		if (call.tool === 'assign' && Array.isArray(args['items'])) {
			const items: readonly unknown[] = args['items'];
			for (const item of items) {
				const parsed = z.object({ reason: z.string() }).safeParse(item);
				if (parsed.success) {
					out.push({ where: `call ${String(i + 1)} (assign reason)`, text: parsed.data.reason });
				}
			}
		}
	});
	return out;
}

/** The shortest line of code that counts as pasted when an agent's text holds it. */
const PASTED_LINE_LENGTH = 30;

/**
 * What the agent did that the skill forbids and a recording can show: code
 * pasted into what it wrote (a fenced block, or a line of the repository's code
 * of some length, word for word), and a change to the repository.
 */
export function forbiddenIn(
	calls: readonly RecordedCall[],
	codeLines: ReadonlySet<string>,
	repositoryChanges: readonly string[]
): readonly string[] {
	const found: string[] = [];
	for (const { where, text } of writtenTexts(calls)) {
		if (/^\s*```/m.test(text)) found.push(`a fenced code block in ${where}`);
		for (const line of codeLines) {
			if (line.length >= PASTED_LINE_LENGTH && text.includes(line)) {
				found.push(`a line of code pasted into ${where}: ${JSON.stringify(line.slice(0, 80))}`);
				break;
			}
		}
	}
	for (const change of repositoryChanges) found.push(`the repository changed: ${change}`);
	return found;
}
