/**
 * Where diff delver keeps its data on a person's machine by default (DESIGN 9):
 * the platform's place for application data, in a `diff-delver` folder.
 *
 * - Linux and other Unix systems: `$XDG_DATA_HOME/diff-delver`, or
 *   `~/.local/share/diff-delver` when that is unset or not absolute (the XDG
 *   Base Directory specification).
 * - macOS: `~/Library/Application Support/diff-delver`.
 * - Windows: `%LOCALAPPDATA%\diff-delver`, since snapshots are large and belong
 *   to the machine, not a roaming profile.
 *
 * Pure: the environment is passed in, so the server reads it once at the edge.
 */
import { parseAbsolutePath, type AbsolutePath } from './absolute-path.tiny.ts';
import { err, ok, type Result } from './result.ts';
import { reviewerMessage, type ReviewerMessage } from './reviewer-message.tiny.ts';

export interface PlatformEnvironment {
	/** As Node's `process.platform` names it: `linux`, `darwin`, `win32`, ... */
	readonly platform: string;
	/** The home directory, if one is known. */
	readonly home: string | undefined;
	/** Environment variables. */
	readonly variables: Readonly<Record<string, string | undefined>>;
}

/** No default could be worked out: the variable or home directory it needs is missing. */
export interface NoDataDirectory {
	readonly kind: 'NoDataDirectory';
	/** What was missing, as the reviewer would set it: `HOME`, `LOCALAPPDATA`. */
	readonly missing: string;
}

export const APP_FOLDER = 'diff-delver';

function absolute(path: string | undefined): AbsolutePath | undefined {
	if (path === undefined || path === '') return undefined;
	const parsed = parseAbsolutePath(path);
	return parsed.ok ? parsed.value : undefined;
}

function under(base: AbsolutePath, separator: '/' | '\\', ...parts: string[]): AbsolutePath {
	const trimmed = base.endsWith(separator) ? base.slice(0, -1) : base;
	const joined = parseAbsolutePath([trimmed, ...parts].join(separator));
	if (!joined.ok) throw new Error(`Not absolute: ${trimmed}`);
	return joined.value;
}

/** The default data directory for this platform and environment. */
export function defaultDataDirectory(
	env: PlatformEnvironment
): Result<AbsolutePath, NoDataDirectory> {
	const home = absolute(env.home);
	switch (env.platform) {
		case 'win32': {
			const local =
				absolute(env.variables['LOCALAPPDATA']) ??
				(home === undefined ? undefined : under(home, '\\', 'AppData', 'Local'));
			return local === undefined
				? err({ kind: 'NoDataDirectory', missing: 'LOCALAPPDATA' })
				: ok(under(local, '\\', APP_FOLDER));
		}
		case 'darwin':
			return home === undefined
				? err({ kind: 'NoDataDirectory', missing: 'HOME' })
				: ok(under(home, '/', 'Library', 'Application Support', APP_FOLDER));
		default: {
			const xdg = absolute(env.variables['XDG_DATA_HOME']);
			if (xdg !== undefined) return ok(under(xdg, '/', APP_FOLDER));
			return home === undefined
				? err({ kind: 'NoDataDirectory', missing: 'HOME' })
				: ok(under(home, '/', '.local', 'share', APP_FOLDER));
		}
	}
}

/** What happened and what to do next, for the reviewer. */
export function describeNoDataDirectory(error: NoDataDirectory): ReviewerMessage {
	return reviewerMessage(
		`diff delver could not work out where to keep its data, because ${error.missing} is not set. Set ${error.missing} to your home folder's path (or pass a data folder), then try again.`
	);
}
