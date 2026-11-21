/**
 * `pnpm mcp:surface`: writes what an agent sees of diff delver's MCP server
 * (`src/lib/server/mcp/agent-surface.ts`) into its committed fixture, after an
 * intended change to a tool's name, description or schema, or to the server's
 * instructions. Look at the change and commit it with the change that made it.
 */
import { writeFileSync } from 'node:fs';
import { AGENT_SURFACE_FILE, agentSurfaceText } from '#lib/server/mcp/agent-surface.ts';

writeFileSync(AGENT_SURFACE_FILE, agentSurfaceText());
console.log(`Wrote ${AGENT_SURFACE_FILE.pathname}.`);
