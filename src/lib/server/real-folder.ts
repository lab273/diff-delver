/**
 * A folder with its symbolic links resolved, so two names for one folder
 * compare as the same (`isInFolder` in `#lib/core/daemon/agent-activity.ts`).
 * A folder that cannot be resolved, such as one no longer there, is kept as it
 * was given.
 */
import { realpath } from 'node:fs/promises';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';

export async function realFolder(folder: AbsolutePath): Promise<AbsolutePath> {
	try {
		const real = parseAbsolutePath(await realpath(folder));
		return real.ok ? real.value : folder;
	} catch {
		return folder;
	}
}
