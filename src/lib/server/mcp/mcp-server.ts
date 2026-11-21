/**
 * MCP over streamable HTTP at `/mcp` (DESIGN 3, 7.1), served by the daemon
 * behind the request gate, which lets in only a request that brings the
 * daemon's token in `Authorization`. Stateless: every request gets a server of
 * its own, so nothing about a session lives in the daemon, and an agent's shim
 * whose daemon was replaced carries on with the new one without the agent
 * seeing it. Answers are plain JSON, not a stream.
 *
 * The stdio shim says two things about the agent's side in headers:
 * `X-Diff-Delver-Directory`, the folder it was started in (percent-encoded,
 * since a header is ASCII), which `create_report` opens when not told another;
 * and `X-Diff-Delver-Open-Browser: yes`, when a report it makes is to be
 * opened in the person's browser. A client that speaks HTTP MCP itself sends
 * neither, and gives `create_report` a directory.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool as ListedTool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import type { ReportService } from '../reports/index.ts';
import { SERVER_INSTRUCTIONS, TOOLS, unknownTool, type ToolContext } from './tools.ts';

export const DIRECTORY_HEADER = 'x-diff-delver-directory';
export const OPEN_BROWSER_HEADER = 'x-diff-delver-open-browser';

export interface McpOptions {
	readonly service: ReportService;
	readonly version: CodeVersion;
	readonly entryAddress: (page: string) => string;
	readonly open: (address: string) => Promise<boolean>;
}

/** The tools as `tools/list` gives them: each one's input schema is its Zod schema as JSON schema. */
export function listedTools(): readonly ListedTool[] {
	return TOOLS.map((t) => ({
		name: t.name,
		title: t.title,
		description: t.description,
		inputSchema: inputSchemaOf(t.schema),
		annotations: {
			title: t.title,
			readOnlyHint: t.readOnly,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}));
}

/** The shape `tools/list` needs an input schema in, which a Zod object's JSON schema has. */
const InputSchemaSchema = z
	.object({
		type: z.literal('object'),
		properties: z.record(z.string(), z.looseObject({})).optional(),
		required: z.array(z.string()).optional()
	})
	.loose();

function inputSchemaOf(schema: z.ZodObject): ListedTool['inputSchema'] {
	const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
	// The schema's dialect is MCP's own default; it is left out, as tools/list examples do.
	return InputSchemaSchema.parse(
		Object.fromEntries(Object.entries(json).filter(([name]) => name !== '$schema'))
	);
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function directoryOf(req: IncomingMessage): AbsolutePath | undefined {
	const raw = header(req, DIRECTORY_HEADER);
	if (raw === undefined) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return undefined;
	}
	const path = parseAbsolutePath(decoded);
	return path.ok ? path.value : undefined;
}

/**
 * A server with diff delver's tools. The SDK's high-level tool registration
 * would check arguments itself and answer with Zod's own messages, so the
 * tools are served on its protocol server directly: `tools/list` from each
 * tool's schema, and `tools/call` with the tool's own check of its arguments.
 */
function serverFor(context: ToolContext, version: CodeVersion): McpServer {
	const mcp = new McpServer(
		{ name: 'diff-delver', title: 'diff delver', version },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
	);
	const server = mcp.server;
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...listedTools()] }));
	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		const found = TOOLS.find((t) => t.name === request.params.name);
		if (found === undefined) {
			return { content: [{ type: 'text', text: unknownTool(request.params.name) }], isError: true };
		}
		const answer = await found.call(request.params.arguments, context);
		return {
			content: [{ type: 'text', text: answer.text }],
			...(answer.refused ? { isError: true } : {})
		};
	});
	return mcp;
}

/** Answers one request to `/mcp`, which the gate has let in. */
export function mcpHandler(
	options: McpOptions
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		const context: ToolContext = {
			service: options.service,
			directory: directoryOf(req),
			openBrowser: header(req, OPEN_BROWSER_HEADER) === 'yes',
			entryAddress: options.entryAddress,
			open: options.open
		};
		const server = serverFor(context, options.version);
		// No session id: stateless, as above.
		const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
		res.on('close', () => {
			void transport.close();
			void server.close();
		});
		await server.connect(transport);
		await transport.handleRequest(req, res);
	};
}
