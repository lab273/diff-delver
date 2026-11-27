/**
 * What a daemon remembers of the agents that reached it, so a page can say
 * whether one is connected and whether one is sorting a Delve: for each folder
 * an agent's server was started in, when it last sent a message, and for each
 * report a tool call named, when the last one did.
 *
 * Kept in memory only, by the daemon's clock, and bounded: the folders and
 * reports heard from longest ago are forgotten. `/mcp` keeps no session, so a
 * daemon never knows that an agent is connected now, only when it last heard
 * from one, and that is all the words here say.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import type { Clock } from '../clock.ts';
import type { ReportId } from '../report-id.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { describeTimeAgo } from '../time-ago.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { folderInWords } from '../agent-setup/shell-words.ts';

/** How many folders, and how many reports, a daemon remembers hearing about. */
export const AGENT_ACTIVITY_KEPT = 50;

/** A message from an agent's server. */
export interface AgentHeard {
	/** The folder the server was started in; null from a client that speaks HTTP MCP itself. */
	readonly directory: AbsolutePath | null;
	/** That folder with symbolic links resolved, which is what is compared with a Delve's. */
	readonly real: AbsolutePath | null;
	readonly at: Timestamp;
}

export interface AgentActivity {
	/**
	 * A message came from a server started in `directory`, which is `real`
	 * with symbolic links resolved (the same folder when it has none).
	 */
	heard(directory: AbsolutePath | undefined, real?: AbsolutePath): void;
	/** A tool call named `report`. */
	worked(report: ReportId): void;
	/**
	 * The agent to tell the person about for a Delve of the repository in
	 * `folder`, given with symbolic links resolved: the one last heard from in
	 * that folder or inside it, and otherwise the one last heard from anywhere.
	 */
	lastHeard(folder: AbsolutePath): AgentHeard | undefined;
	/** When a tool call last named `report`. */
	lastWorked(report: ReportId): Timestamp | undefined;
}

/**
 * Whether `directory` is `folder` or inside it, by their text alone: give both
 * with symbolic links resolved, or a link to the folder is taken for another.
 */
export function isInFolder(directory: AbsolutePath | null, folder: AbsolutePath): boolean {
	if (directory === null) return false;
	const base = folder.endsWith('/') ? folder.slice(0, -1) : folder;
	return directory === base || directory === folder || directory.startsWith(`${base}/`);
}

/** Sets `key` as the newest entry and forgets the oldest past the bound. */
function remember<K, V>(kept: Map<K, V>, key: K, value: V): void {
	kept.delete(key);
	kept.set(key, value);
	for (const oldest of kept.keys()) {
		if (kept.size <= AGENT_ACTIVITY_KEPT) break;
		kept.delete(oldest);
	}
}

export function agentActivity(clock: Clock): AgentActivity {
	// Each in the order heard, oldest first.
	const folders = new Map<
		AbsolutePath | null,
		{ readonly real: AbsolutePath | null; readonly at: Timestamp }
	>();
	const reports = new Map<ReportId, Timestamp>();
	return {
		heard(directory, real) {
			remember(folders, directory ?? null, { real: real ?? directory ?? null, at: clock.now() });
		},
		worked(report) {
			remember(reports, report, clock.now());
		},
		lastHeard(folder) {
			let here: AgentHeard | undefined;
			let anywhere: AgentHeard | undefined;
			for (const [directory, { real, at }] of folders) {
				anywhere = { directory, real, at };
				if (isInFolder(real, folder)) here = anywhere;
			}
			return here ?? anywhere;
		},
		lastWorked(report) {
			return reports.get(report);
		}
	};
}

/** "just now" reads oddly after a verb in the past; the rest reads as it is. */
function when(then: Timestamp, now: Timestamp): string {
	const ago = describeTimeAgo(then, now);
	return ago === 'just now' ? 'a moment ago' : ago;
}

/**
 * The agent last heard from, in words: when, and the folder it was started
 * in. Said as something that happened, never as something that is so now.
 */
export function describeAgentHeard(
	heard: Pick<AgentHeard, 'directory' | 'at'>,
	now: Timestamp,
	home: AbsolutePath | undefined
): ReviewerMessage {
	const where =
		heard.directory === null ? '' : `, started in ${folderInWords(heard.directory, home)}`;
	return reviewerMessage(`An agent connected to this diff delver ${when(heard.at, now)}${where}.`);
}

/** When an agent last called a tool on a Delve, in words. */
export function describeAgentWorked(at: Timestamp, now: Timestamp): ReviewerMessage {
	return reviewerMessage(`An agent last worked on this Delve ${when(at, now)}.`);
}

/**
 * How long after its last `wait_for_requests` call ended an agent still counts
 * as connected to a Delve: long enough to answer a request and call again.
 */
export const LISTENING_LINGERS_MS = 2 * 60_000;

/**
 * Which Delves an agent is listening to (DESIGN 7.2): one whose
 * `wait_for_requests` call is open, or ended less than `LISTENING_LINGERS_MS`
 * ago, by the daemon's clock. In memory only and bounded, as the rest is.
 */
export interface AgentListening {
	/** A `wait_for_requests` call on `report` began. */
	began(report: ReportId): void;
	/** It ended, answered or timed out. */
	ended(report: ReportId): void;
	/** Whether an agent counts as connected to `report` now. */
	listening(report: ReportId): boolean;
}

export function agentListening(clock: Clock): AgentListening {
	const open = new Map<ReportId, number>();
	const lastEnded = new Map<ReportId, Timestamp>();
	return {
		began(report) {
			remember(open, report, (open.get(report) ?? 0) + 1);
		},
		ended(report) {
			const left = (open.get(report) ?? 1) - 1;
			if (left > 0) open.set(report, left);
			else open.delete(report);
			remember(lastEnded, report, clock.now());
		},
		listening(report) {
			if ((open.get(report) ?? 0) > 0) return true;
			const ended = lastEnded.get(report);
			return ended !== undefined && clock.now() - ended < LISTENING_LINGERS_MS;
		}
	};
}
