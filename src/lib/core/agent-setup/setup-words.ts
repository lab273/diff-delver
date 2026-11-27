/**
 * What `diff-delver setup` did, and what `diff-delver setup --undo` did, in
 * plain words for the terminal (DESIGN 3): for each coding agent, whether it
 * was found, what became of its MCP server entry and of the skill, and, for
 * one not found, how to set it up by hand.
 *
 * Setup never asks. An entry named `diff-delver` that runs something else is
 * replaced, since the name is diff delver's and the person asked for this
 * copy, and what it ran is said in full, so it can be put back by hand. A
 * skill file setup did not write is never replaced, since it may hold the
 * person's own words, and cannot be shown in a line.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import {
	claudeCodeCommand,
	codexConfigEntry,
	plainServerCommand,
	setupCommand,
	type AgentServerSetup
} from './agent-server.ts';
import { folderInWords } from './shell-words.ts';

export type AgentKind = 'claudeCode' | 'codex';

export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = {
	claudeCode: 'Claude Code',
	codex: 'Codex'
};

/** What setup did to an agent's MCP server entry. */
export type ServerSetUp =
	| { readonly kind: 'added' }
	| { readonly kind: 'unchanged' }
	/**
	 * It ran something else: `before` is the whole entry as it was. Claude Code's
	 * is replaced whole; Codex's keeps every setting but what it runs.
	 */
	| { readonly kind: 'replaced'; readonly before: string }
	/** Codex's file names diff delver in a form setup cannot change safely. */
	| { readonly kind: 'elsewhere' }
	/** With `before` when an entry that ran something else was removed and ours could not be added. */
	| { readonly kind: 'failed'; readonly detail: string; readonly before?: string };

export type SkillSetUp =
	| { readonly kind: 'added' | 'unchanged' | 'updated' | 'theirs' }
	| { readonly kind: 'failed'; readonly detail: string };

/** What undoing did to an agent's MCP server entry. */
export type ServerUndone =
	| { readonly kind: 'removed' | 'none' | 'elsewhere' }
	/** An entry that runs something else, which setup of this copy did not add: left. */
	| { readonly kind: 'other'; readonly before: string }
	| { readonly kind: 'failed'; readonly detail: string };

export type SkillUndone =
	| { readonly kind: 'removed' | 'none' | 'theirs' }
	| { readonly kind: 'failed'; readonly detail: string };

/** One agent, as setup or its undo found it. */
export type AgentResult<Server, Skill> =
	/** Not found: `configFile` is where its MCP servers would be. */
	| { readonly agent: AgentKind; readonly found: false; readonly configFile: AbsolutePath }
	| {
			readonly agent: AgentKind;
			readonly found: true;
			/** The file that holds its MCP servers. */
			readonly configFile: AbsolutePath;
			readonly skillFile: AbsolutePath;
			readonly server: Server;
			readonly skill: Skill;
	  };

export type SetupResult = AgentResult<ServerSetUp, SkillSetUp>;
export type UndoResult = AgentResult<ServerUndone, SkillUndone>;

/** Where each agent is looked for, said when it was not found. */
function lookedFor(result: SetupResult | UndoResult, setup: AgentServerSetup): string {
	switch (result.agent) {
		case 'claudeCode':
			return 'there is no claude command';
		case 'codex': {
			const file = folderInWords(result.configFile, setup.home);
			// Codex's folder: its config file is always config.toml in it.
			const folder = file.slice(0, file.length - '/config.toml'.length);
			return `there is no codex command and no ${folder} folder`;
		}
	}
}

/** Text to copy, on lines of its own, set in by `by` spaces. */
function indented(text: string, by = 6): string[] {
	return text.split('\n').map((line) => `${' '.repeat(by)}${line}`);
}

function failed(result: { readonly kind: string }): boolean {
	return result.kind === 'failed';
}

function serverSetUpLines(
	result: SetupResult & { found: true },
	setup: AgentServerSetup
): string[] {
	const file = folderInWords(result.configFile, setup.home);
	const name = AGENT_NAMES[result.agent];
	const server = result.server;
	switch (server.kind) {
		case 'added':
			return [
				`  - Added the MCP server diff-delver, in ${file}, for every folder you start ${name} in.`
			];
		case 'unchanged':
			return ['  - The MCP server diff-delver was already set up the same way. Nothing changed.'];
		case 'replaced':
			switch (result.agent) {
				case 'claudeCode':
					return [
						`  - Replaced the MCP server diff-delver, in ${file}, which ran something else. It was:`,
						...indented(server.before)
					];
				case 'codex':
					return [
						`  - Changed what the MCP server diff-delver runs, in ${file}, to this copy of diff delver; its other settings are kept. It was:`,
						...indented(server.before)
					];
			}
			break;
		case 'elsewhere':
			return [
				`  - ${file} already names diff-delver, in a form setup does not change, so it is left as it is. To have setup's, take diff-delver out of it and run setup again, or make its entry this:`,
				...indented(codexConfigEntry(setup))
			];
		case 'failed':
			return [
				`  - The MCP server could not be added: ${server.detail}`,
				...(server.before === undefined
					? []
					: [
							'    The MCP server diff-delver that ran something else was removed first. It was:',
							...indented(server.before)
						]),
				...(result.agent === 'claudeCode'
					? [
							'    To add it yourself, run this in a terminal:',
							...indented(claudeCodeCommand(setup))
						]
					: [`    To add it yourself, add this to ${file}:`, ...indented(codexConfigEntry(setup))])
			];
	}
}

function skillSetUpLines(result: SetupResult & { found: true }, setup: AgentServerSetup): string[] {
	const file = folderInWords(result.skillFile, setup.home);
	switch (result.skill.kind) {
		case 'added':
			return [`  - Added the skill, ${file}.`];
		case 'unchanged':
			return [`  - The skill, ${file}, was already there. Nothing changed.`];
		case 'updated':
			return [`  - Updated the skill, ${file}, to this version of diff delver's.`];
		case 'theirs':
			return [
				`  - ${file} is there already, with other words, and setup did not put it there, so it is left as it is. To have this version's, delete it and run setup again.`
			];
		case 'failed':
			return [`  - The skill could not be saved as ${file}: ${result.skill.detail}`];
	}
}

/** By hand, for an agent setup did not find. */
function byHand(result: SetupResult, setup: AgentServerSetup): string[] {
	const file = folderInWords(result.configFile, setup.home);
	switch (result.agent) {
		case 'claudeCode':
			return [
				'  To set it up by hand once it is installed, run setup again, or run this in a terminal:',
				...indented(claudeCodeCommand(setup))
			];
		case 'codex':
			return [
				`  To set it up by hand once it is installed, run setup again, or add this to ${file}:`,
				...indented(codexConfigEntry(setup))
			];
	}
}

/** What `diff-delver setup` prints. */
export function describeSetup(results: readonly SetupResult[], setup: AgentServerSetup): string[] {
	const lines: string[] = [];
	const found = results.filter((r) => r.found);
	if (found.length === 0) {
		return [
			`diff delver found no coding agent to set up on this machine: ${results.map((r) => `${AGENT_NAMES[r.agent]} not found, since ${lookedFor(r, setup)}`).join('; ')}. Nothing was changed.`,
			'Install one and run setup again. For any other agent, add an MCP server that runs this command:',
			...indented(plainServerCommand(setup), 2)
		];
	}
	for (const result of results) {
		const name = AGENT_NAMES[result.agent];
		if (!result.found) {
			lines.push(
				`${name}: not found, since ${lookedFor(result, setup)}. Nothing was changed for it.`
			);
			lines.push(...byHand(result, setup));
			continue;
		}
		lines.push(`${name}:`);
		lines.push(...serverSetUpLines(result, setup), ...skillSetUpLines(result, setup));
	}
	const changed = found.some(
		(r) =>
			r.server.kind === 'added' ||
			r.server.kind === 'replaced' ||
			r.skill.kind === 'added' ||
			r.skill.kind === 'updated'
	);
	if (changed) {
		const names = found.map((r) => AGENT_NAMES[r.agent]).join(' or ');
		lines.push(
			`If ${names} is running, start it again so it loads diff delver. Then, in your repository, ask it: Sort my changes for review with diff delver.`
		);
	}
	lines.push(`To take this out again, run: ${setupCommand(setup, true)}`);
	return lines;
}

function serverUndoneLines(
	result: UndoResult & { found: true },
	setup: AgentServerSetup
): string[] {
	const file = folderInWords(result.configFile, setup.home);
	const server = result.server;
	switch (server.kind) {
		case 'removed':
			return [`  - Removed the MCP server diff-delver, from ${file}.`];
		case 'none':
			return ['  - There was no MCP server diff-delver to remove.'];
		case 'other':
			return [
				`  - The MCP server diff-delver, in ${file}, runs something other than this copy of diff delver, so setup did not add it here and it is left as it is. It runs:`,
				...indented(server.before)
			];
		case 'elsewhere':
			return [
				`  - ${file} names diff-delver in a form setup does not change, so it is left as it is. Take it out of the file yourself if you want it gone.`
			];
		case 'failed':
			return [`  - The MCP server could not be removed: ${server.detail}`];
	}
}

function skillUndoneLines(result: UndoResult & { found: true }, setup: AgentServerSetup): string[] {
	const file = folderInWords(result.skillFile, setup.home);
	switch (result.skill.kind) {
		case 'removed':
			return [`  - Removed the skill, ${file}.`];
		case 'none':
			return ['  - There was no skill to remove.'];
		case 'theirs':
			return [
				`  - ${file} was not put there by setup, so it is left as it is. Delete it yourself if you want it gone.`
			];
		case 'failed':
			return [`  - The skill could not be removed: ${result.skill.detail}`];
	}
}

/** What `diff-delver setup --undo` prints. */
export function describeUndo(results: readonly UndoResult[], setup: AgentServerSetup): string[] {
	const lines: string[] = [];
	for (const result of results) {
		const name = AGENT_NAMES[result.agent];
		if (!result.found) {
			lines.push(`${name}: not found, so there was nothing to take out.`);
			continue;
		}
		lines.push(`${name}:`);
		lines.push(...serverUndoneLines(result, setup), ...skillUndoneLines(result, setup));
	}
	const removed = results.some(
		(r) => r.found && (r.server.kind === 'removed' || r.skill.kind === 'removed')
	);
	if (removed) lines.push('If an agent is running, start it again so it lets diff delver go.');
	return lines;
}

/** Whether anything setup or its undo tried went wrong, for the command's exit status. */
export function anyFailed(results: readonly (SetupResult | UndoResult)[]): boolean {
	return results.some((r) => r.found && (failed(r.server) || failed(r.skill)));
}
