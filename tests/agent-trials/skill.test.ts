/**
 * The skill that tells a coding agent how to sort a diff (DESIGN 7.3), and the
 * Claude Code plugin that packages it with the MCP configuration: well formed,
 * found where an agent looks, and starting the same server the README tells a
 * person to add.
 */
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

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
