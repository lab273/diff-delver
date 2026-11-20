/**
 * What the command does once it has a daemon: asks it to open something in the
 * folder the command runs in, and works out what to print and which page to
 * open. The command (`main.ts`) and the journeys both use this, so a journey
 * follows the command exactly as a person's terminal would.
 */
import { describeApiError, type ApiClient } from '#lib/api/client.ts';
import type { OpenResponse, StartResponse } from '#lib/api/schemas.ts';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { formatGitSourceSpec, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';

export interface CommandOutcome {
	/** What to print, one plain sentence per line. */
	readonly lines: readonly string[];
	/** The page to open: a path of the daemon, such as `/diffs/r_1`. */
	readonly page: string;
	/** 0 when what was asked for was done or explained; 1 when something went wrong. */
	readonly exitCode: 0 | 1;
}

/** The page that explains a folder: the chooser, or why there is nothing, or not a repository. */
export function startPage(directory: AbsolutePath, asked?: GitSourceSpec): string {
	const query = new URLSearchParams({ directory });
	if (asked !== undefined) query.set('asked', formatGitSourceSpec(asked));
	return `/start?${query.toString()}`;
}

function described(
	response: StartResponse | OpenResponse,
	directory: AbsolutePath,
	asked: GitSourceSpec | undefined
): CommandOutcome {
	switch (response.kind) {
		case 'opened': {
			const { diff } = response;
			const { update } = response;
			const lines = [
				!response.resumed
					? `${diff.title} in ${diff.repository}: ${diff.sizeText.toLowerCase()}.`
					: update === null
						? `${diff.title} in ${diff.repository}, opened again where you left it (${diff.progressText.toLowerCase()}). Nothing has changed since.`
						: `${diff.title} in ${diff.repository}, updated to your files as they are now (version ${String(update.version)}). ${update.text}`
			];
			if (diff.leftOut > 0) {
				lines.push(
					`${diff.leftOut === 1 ? 'One file' : `${String(diff.leftOut)} files`} could not be included; the page says why.`
				);
			}
			return { lines, page: `/diffs/${diff.id}`, exitCode: 0 };
		}
		case 'choose':
			return {
				lines: [
					`Several changes could be reviewed in ${response.repository}; choose one in your browser.`
				],
				page: startPage(directory),
				exitCode: 0
			};
		case 'nothing':
			return {
				lines: [response.reason],
				page: startPage(directory, asked),
				exitCode: 0
			};
	}
}

/** `diff-delver` with no arguments. */
export async function startOutcome(
	client: ApiClient,
	directory: AbsolutePath
): Promise<CommandOutcome> {
	const started = await client.start({ directory });
	if (!started.ok) {
		return { lines: [describeApiError(started.error)], page: startPage(directory), exitCode: 1 };
	}
	return described(started.value, directory, undefined);
}

/** `diff-delver open <source>`. */
export async function openOutcome(
	client: ApiClient,
	directory: AbsolutePath,
	source: GitSourceSpec
): Promise<CommandOutcome> {
	const opened = await client.open({ directory, source: formatGitSourceSpec(source) });
	if (!opened.ok) {
		// The page says what was asked for and why it could not be opened, then what can be.
		return {
			lines: [describeApiError(opened.error)],
			page: startPage(directory, source),
			exitCode: 1
		};
	}
	return described(opened.value, directory, source);
}
