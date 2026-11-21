/**
 * Replaying a recording (tests/agent-trials/README.md): its tool calls, in
 * order, sent again to a real daemon on the same fixture repository with the
 * trial's fixed clock and sequential ids, through any MCP session (the stdio
 * shim in the replay test, the journey's daemon over HTTP in a journey).
 *
 * A call accepted then must be accepted now, and one refused then refused now;
 * otherwise the tools have changed under the agent, and the replay fails,
 * naming the call. An answer worded differently from the recorded one does
 * not fail it: the recording is older than the current answers, which is said
 * so that someone can decide to record again.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpSession } from '../support/mcp-client.ts';
import {
	denormaliser,
	normaliseDeep,
	type Normaliser,
	type Recording,
	RecordingSchema
} from './recording.ts';
import { RECORDINGS_DIRECTORY } from './trial-world.ts';

/** Every committed recording, by file name. */
export async function committedRecordings(): Promise<
	readonly { readonly name: string; readonly recording: Recording }[]
> {
	const names = (await readdir(RECORDINGS_DIRECTORY)).filter((n) => n.endsWith('.json')).sort();
	return Promise.all(
		names.map(async (name) => ({
			name,
			recording: RecordingSchema.parse(
				JSON.parse(await readFile(join(RECORDINGS_DIRECTORY, name), 'utf8'))
			)
		}))
	);
}

/** One committed recording by its file name, such as `shop.claude.json`. */
export async function committedRecording(name: string): Promise<Recording> {
	return RecordingSchema.parse(
		JSON.parse(await readFile(join(RECORDINGS_DIRECTORY, name), 'utf8'))
	);
}

export interface ReplayOutcome {
	/** Calls the tools now accept or refuse differently: the replay fails on any. */
	readonly changed: readonly string[];
	/** Calls whose answer is worded differently now: the recording is older than the answers. */
	readonly reworded: readonly number[];
}

/**
 * Sends the recorded calls through `session`. `paths` are the replay's own
 * folders, put where the recording has placeholders; `normalise` turns the
 * replay's answers into the recording's form to compare them.
 */
export async function replay(
	recording: Recording,
	session: McpSession,
	paths: { readonly repository: string; readonly data: string; readonly trial: string },
	normalise: Normaliser
): Promise<ReplayOutcome> {
	const denormalise = denormaliser(paths);
	const changed: string[] = [];
	const reworded: number[] = [];
	for (const [i, call] of recording.calls.entries()) {
		const args = normaliseDeep(call.arguments, denormalise);
		const answer = await session.call(
			call.tool,
			typeof args === 'object' && args !== null ? { ...args } : {}
		);
		const recorded = call.answer;
		if (recorded === undefined) continue;
		const number = i + 1;
		if (answer.refused !== recorded.refused) {
			changed.push(
				`Call ${String(number)} (${call.tool}) was ${recorded.refused ? 'refused' : 'accepted'} when recorded and is ${answer.refused ? 'refused' : 'accepted'} now: ${answer.text.slice(0, 400)}`
			);
		} else if (normalise(answer.text) !== recorded.text) {
			reworded.push(number);
		}
	}
	return { changed, reworded };
}
