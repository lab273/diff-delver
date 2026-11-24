/**
 * How to have a coding agent sort a Delve, as its page shows it: the command
 * that gives an agent this daemon, the folder to start the agent in with
 * whether it is still there, the sentence that names the Delve, and what the
 * daemon has heard from agents. The rules and words are core's
 * (`#lib/core/agent-setup/`, `agent-activity.ts`).
 */
import { stat } from 'node:fs/promises';
import type { AgentSorting } from '#lib/api/schemas.ts';
import {
	claudeCodeCommand,
	codexConfigEntry,
	plainServerCommand
} from '#lib/core/agent-setup/agent-server.ts';
import { folderInWords } from '#lib/core/agent-setup/shell-words.ts';
import { goToFolderCommand, sortRequest } from '#lib/core/agent-setup/sort-request.ts';
import {
	describeAgentHeard,
	describeAgentWorked,
	isInFolder
} from '#lib/core/daemon/agent-activity.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { DaemonContext } from '../daemon/context.ts';
import type { ReportSummary } from '../reports/index.ts';

async function folderThere(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function agentSortingView(
	daemon: Pick<DaemonContext, 'agentSetup' | 'agents' | 'clock'>,
	report: ReportSummary
): Promise<AgentSorting> {
	const setup = daemon.agentSetup;
	const folder = report.repositoryPath;
	const now = daemon.clock.now();
	const heard = daemon.agents.lastHeard(folder);
	const worked = daemon.agents.lastWorked(report.id);
	return {
		connect: {
			claudeCode: claudeCodeCommand(setup),
			codex: codexConfigEntry(setup),
			other: plainServerCommand(setup)
		},
		folder: {
			shown: reviewerMessage(folderInWords(folder, setup.home)),
			command: goToFolderCommand(folder, setup.home),
			there: await folderThere(folder)
		},
		request: sortRequest(report),
		heard:
			heard === undefined
				? null
				: {
						text: describeAgentHeard(heard, now, setup.home),
						here: isInFolder(heard.directory, folder)
					},
		worked: worked === undefined ? null : describeAgentWorked(worked, now)
	};
}
