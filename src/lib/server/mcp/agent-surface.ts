/**
 * What an agent sees of diff delver before it calls anything: the server's
 * name and instructions, and every tool's name, title, description, input
 * schema and hints, exactly as `initialize` and `tools/list` give them. It is
 * committed as `fixtures/agent-surface.json` and a test fails when it changes
 * without the file being written again (`pnpm mcp:surface`), so a change to
 * what agents read is reviewed in its commit like a changed screenshot.
 */
import { SERVER_INSTRUCTIONS } from './tools.ts';
import { listedTools } from './mcp-server.ts';

export const AGENT_SURFACE_FILE = new URL('./fixtures/agent-surface.json', import.meta.url);

/** The surface as the committed file holds it, ending in a newline. */
export function agentSurfaceText(): string {
	return `${JSON.stringify({ instructions: SERVER_INSTRUCTIONS, tools: listedTools() }, null, '\t')}\n`;
}
