/**
 * The daemon context `pnpm dev` uses, made on first use: a report service for
 * the data folder in DIFF_DELVER_DATA_DIRECTORY, or this machine's default, with
 * the real clock and ids. Only for working on the pages; `vite dev` checks the
 * host itself and there is no token.
 */
import { DATA_DIRECTORY_VARIABLE } from '#lib/core/cli/command-line.ts';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { ReportService, describeReportError, randomIds, systemClock } from '../reports/index.ts';
import { machineDataDirectory } from '../store/index.ts';
import { randomEntryCode } from '../system.ts';
import { codeVersion } from '../version.ts';
import type { DaemonContext } from './context.ts';

let made: Promise<DaemonContext> | undefined;

async function make(): Promise<DaemonContext> {
	const given = process.env[DATA_DIRECTORY_VARIABLE];
	const parsed = given === undefined ? undefined : parseAbsolutePath(given);
	const machine = machineDataDirectory();
	const dataDirectory = parsed?.ok === true ? parsed.value : machine.ok ? machine.value : undefined;
	if (dataDirectory === undefined) throw new Error(`Set ${DATA_DIRECTORY_VARIABLE} to a folder.`);
	const service = await ReportService.open({ dataDirectory, clock: systemClock, ids: randomIds });
	if (!service.ok) throw new Error(describeReportError(service.error));
	return {
		service: service.value,
		isReviewBrowser: () => true,
		isCommand: () => true,
		clock: systemClock,
		version: codeVersion(),
		// `pnpm dev` has no gate, so the code lets nothing in that was not let in already.
		entryCode: randomEntryCode,
		openForReview: () => Promise.resolve('no-browser'),
		requestStop: () => undefined
	};
}

export function developmentDaemon(): Promise<DaemonContext> {
	made ??= make();
	return made;
}
