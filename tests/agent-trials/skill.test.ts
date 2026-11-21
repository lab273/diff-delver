/**
 * The skill that tells a coding agent how to sort a diff (DESIGN 7.3), and the
 * Claude Code plugin that packages it with the MCP configuration: well formed,
 * found where an agent looks, and starting the same server the README tells a
 * person to add.
 */
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = join(import.meta.dirname, '..', '..');

const AgentSurface = z.object({
	instructions: z.string(),
	tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() }))
});

/** Every property name in a JSON schema, however deep. */
function propertiesOf(schema: unknown): readonly string[] {
	if (Array.isArray(schema)) {
		const items: readonly unknown[] = schema;
		return items.flatMap(propertiesOf);
	}
	if (typeof schema !== 'object' || schema === null) return [];
	const entries: [string, unknown][] = Object.entries(schema);
	return entries.flatMap(([key, value]) => [
		...(key === 'properties' && typeof value === 'object' && value !== null
			? Object.keys(value)
			: []),
		...propertiesOf(value)
	]);
}

describe('the skill and the Claude Code plugin', () => {
	const plugin = join(ROOT, 'plugins', 'claude-code');

	it('has a skill with a name and a description of when to use it, linked from skills/', async () => {
		const skill = await readFile(join(plugin, 'skills', 'diff-delver', 'SKILL.md'), 'utf8');
		const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
		expect(front?.[1]).toBe('diff-delver');
		expect(front?.[2]).toMatch(/^Sort a diff .*Use when/);
		expect(await readlink(join(ROOT, 'skills', 'diff-delver'))).toBe(
			'../plugins/claude-code/skills/diff-delver'
		);
	});

	it('names only tools and arguments the MCP server has, and sorts in the order it gives', async () => {
		const skill = await readFile(join(plugin, 'skills', 'diff-delver', 'SKILL.md'), 'utf8');
		const surface = AgentSurface.parse(
			JSON.parse(
				await readFile(
					join(ROOT, 'src', 'lib', 'server', 'mcp', 'fixtures', 'agent-surface.json'),
					'utf8'
				)
			)
		);
		const tools = surface.tools.map((t) => t.name);
		const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1] ?? '');
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter((name) => !tools.includes(name))).toEqual([]);
		// Every argument the skill writes as JSON, `"role": "test"` or `{ "file" }`, is one a tool takes.
		const properties = new Set(surface.tools.flatMap((t) => propertiesOf(t.inputSchema)));
		const keys = [...skill.matchAll(/"([a-z_]+)"(?=\s*:|\s*\})/g)].map((m) => m[1] ?? '');
		expect(keys.length).toBeGreaterThan(0);
		expect(keys.filter((key) => !properties.has(key))).toEqual([]);
		// The server tells an agent to sort whole files first, then line ranges; so does the skill.
		expect(surface.instructions).toContain('whole files first');
		expect(skill).toContain('whole files first');
	});

	it('runs diff-delver mcp from the newest release, as the README says', async () => {
		const config: unknown = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
		expect(config).toEqual({
			mcpServers: {
				'diff-delver': {
					command: 'npx',
					args: [
						'--yes',
						'https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz',
						'mcp'
					]
				}
			}
		});
		const manifest: unknown = JSON.parse(
			await readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')
		);
		expect(manifest).toMatchObject({ name: 'diff-delver' });
		const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
		expect(readme).toContain(
			'npx --yes https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz mcp'
		);
	});
});
