/**
 * The default data directory on the machine diff delver is running on: the
 * pure rule in `#lib/core/data-directory.ts`, applied to this process's
 * platform, home directory and environment, read here at the edge.
 */
import { homedir } from 'node:os';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { defaultDataDirectory, type NoDataDirectory } from '#lib/core/data-directory.ts';
import type { Result } from '#lib/core/result.ts';

/** Where diff delver keeps its data on this machine unless told otherwise. */
export function machineDataDirectory(): Result<AbsolutePath, NoDataDirectory> {
	let home: string | undefined;
	try {
		home = homedir();
	} catch {
		home = undefined;
	}
	return defaultDataDirectory({ platform: process.platform, home, variables: process.env });
}
