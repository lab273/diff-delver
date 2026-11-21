/**
 * MCP clients for tests, from the official SDK, as an agent connects: through
 * the real stdio shim (`diff-delver mcp`, from the build, with a data folder of
 * the test's own and `--no-open`), or straight to a daemon's `/mcp` over HTTP
 * with its token, as a client that speaks HTTP MCP does. Each is closed when the
 * test finishes. `call` gives a tool's answer as the agent reads it: its text,
 * and whether it was a refusal.
 *
 * Nothing here is tied to Vitest but `onTestFinished`, which a caller can do
 * without by closing the client itself (`close`), so a journey can run the
 * same calls against the journey's own daemon.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { BUILT_COMMAND } from './build.ts';

/** A tool's answer as an agent reads it. */
export interface ToolAnswer {
	readonly text: string;
	/** Whether the server answered with `isError`: the call was refused or failed. */
	readonly refused: boolean;
}

export interface McpSession {
	readonly client: Client;
	/** Calls a tool and gives its answer; a protocol error throws. */
	call(name: string, args?: Readonly<Record<string, unknown>>): Promise<ToolAnswer>;
	/** What the shim wrote to standard error so far: for a person, never the protocol. */
	readonly stderr: () => string;
	close(): Promise<void>;
}

const TextContent = z.object({ type: z.literal('text'), text: z.string() });
const CallResult = z.object({
	content: z.array(z.unknown()),
	isError: z.boolean().optional()
});

function session(client: Client, stderr: () => string): McpSession {
	return {
		client,
		stderr,
		async call(name, args = {}) {
			const result = CallResult.parse(await client.callTool({ name, arguments: { ...args } }));
			const texts = result.content.map((c) => TextContent.parse(c).text);
			return { text: texts.join('\n'), refused: result.isError === true };
		},
		close: () => client.close()
	};
}

export interface ShimOptions {
	/** The folder the shim runs in, as an agent starts it in its project. */
	readonly cwd: string;
	readonly dataDirectory: string;
	/** The environment, such as the test's own git setup. No display, so no browser could open. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Extra arguments after `mcp`; `--no-open` is always given. */
	readonly args?: readonly string[];
}

/** An MCP client connected through the real stdio shim, which finds or starts the daemon itself. */
export async function mcpThroughShim(options: ShimOptions): Promise<McpSession> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.env)) {
		if (value !== undefined && name !== 'DISPLAY' && name !== 'WAYLAND_DISPLAY') env[name] = value;
	}
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			BUILT_COMMAND,
			'mcp',
			'--data-directory',
			options.dataDirectory,
			'--no-open',
			...(options.args ?? [])
		],
		cwd: options.cwd,
		env,
		stderr: 'pipe'
	});
	let written = '';
	transport.stderr?.on('data', (chunk: Buffer) => {
		written += chunk.toString('utf8');
	});
	const client = new Client({ name: 'diff-delver-tests', version: '1.0.0' });
	await client.connect(transport);
	return session(client, () => written);
}

export interface HttpOptions {
	readonly origin: string;
	readonly token: string;
	/** The folder the agent works in, as the shim would say it. */
	readonly directory?: string;
	/** Asks for a report `create_report` makes to be opened in the browser, as the shim does without `--no-open`. */
	readonly openBrowser?: boolean;
}

/** An MCP client connected straight to a daemon's `/mcp`, with its token. */
export async function mcpOverHttp(options: HttpOptions): Promise<McpSession> {
	const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
	if (options.directory !== undefined) {
		headers['x-diff-delver-directory'] = encodeURIComponent(options.directory);
	}
	if (options.openBrowser === true) headers['x-diff-delver-open-browser'] = 'yes';
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', options.origin), {
		requestInit: { headers }
	});
	const client = new Client({ name: 'diff-delver-tests', version: '1.0.0' });
	await client.connect(transport);
	return session(client, () => '');
}

/** The version a reading tool's answer is of, from its first line: "..., version 2.". */
export function versionIn(answer: ToolAnswer): number {
	const match = /^Report r_[0-9a-z]+: .*, version (\d+)\.$/m.exec(answer.text.split('\n')[0] ?? '');
	if (match?.[1] === undefined) throw new Error(`No version in: ${answer.text.slice(0, 300)}`);
	return Number(match[1]);
}

/** The report id an answer names first. */
export function reportIn(answer: ToolAnswer): string {
	const match = /Report (r_[0-9a-z]+)/.exec(answer.text);
	if (match?.[1] === undefined) throw new Error(`No report in: ${answer.text.slice(0, 300)}`);
	return match[1];
}

/** The cursor a paged answer gives for its next page, or undefined on the last. */
export function cursorIn(answer: ToolAnswer): string | undefined {
	return /"cursor": "(v\d+-f\d+-l\d+-k[0-9a-z]+)"/.exec(answer.text)?.[1];
}
