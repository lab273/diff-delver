/**
 * What the command does once it has a daemon: asks it to open something in the
 * folder the command runs in, and works out what to print and which page to
 * open. The command (`main.ts`) and the journeys both use this, so a journey
 * follows the command exactly as a person's terminal would.
 */
import { describeApiError, type ApiClient, type ApiError } from '#lib/api/client.ts';
import type { OpenResponse, StartResponse } from '#lib/api/schemas.ts';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { describeTooOldForDaemon } from '#lib/core/cli/replaced-daemon.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import type { ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { FoundDaemon } from '../daemon/launcher.ts';
import {
	formatGitSourceSpec,
	parseGitSourceSpec,
	type GitSourceSpec
} from '#lib/core/sources/git-source-spec.ts';

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

/** A source as the API sends it, which it formatted from a valid one. */
function parsedSource(text: string): GitSourceSpec | undefined {
	const spec = parseGitSourceSpec(text);
	return spec.ok ? spec.value : undefined;
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
		case 'failed':
			// The page says what could not be opened and why, then what can be.
			return {
				lines: [response.problem],
				page: startPage(directory, parsedSource(response.source)),
				exitCode: 1
			};
	}
}

/** How the command words an error from the daemon; `describeApiError` unless it says more, as for a newer daemon. */
export type DescribeApiError = (error: ApiError) => ReviewerMessage;

/**
 * Whether an error means the daemon and this command do not understand each
 * other: an answer the command cannot read, or a request the daemon could not.
 */
function misunderstood(error: ApiError): boolean {
	switch (error.kind) {
		case 'unreadable':
			return true;
		case 'refused':
			return error.reason === 'BadRequest';
		case 'unreachable':
		case 'interrupted':
			return false;
	}
}

/**
 * How the command words errors from the daemon it found. A newer daemon may
 * answer in a way this older copy cannot read, or not read what it sends:
 * then this copy is too old, and the message says how to upgrade.
 */
export function describerFor(
	found: FoundDaemon,
	mine: CodeVersion,
	commandPath: string
): DescribeApiError {
	switch (found.kind) {
		case 'own':
		case 'replaced':
			return describeApiError;
		case 'newer':
			return (error) =>
				misunderstood(error)
					? describeTooOldForDaemon(found.version, mine, commandPath)
					: describeApiError(error);
	}
}

/** `diff-delver` with no arguments. */
export async function startOutcome(
	client: ApiClient,
	directory: AbsolutePath,
	describe: DescribeApiError = describeApiError
): Promise<CommandOutcome> {
	const started = await client.start({ directory });
	if (!started.ok) {
		return { lines: [describe(started.error)], page: startPage(directory), exitCode: 1 };
	}
	return described(started.value, directory, undefined);
}

/** `diff-delver open <source>`. */
export async function openOutcome(
	client: ApiClient,
	directory: AbsolutePath,
	source: GitSourceSpec,
	describe: DescribeApiError = describeApiError
): Promise<CommandOutcome> {
	const opened = await client.open({ directory, source: formatGitSourceSpec(source) });
	if (!opened.ok) {
		// The page says what was asked for and why it could not be opened, then what can be.
		return {
			lines: [describe(opened.error)],
			page: startPage(directory, source),
			exitCode: 1
		};
	}
	return described(opened.value, directory, source);
}
