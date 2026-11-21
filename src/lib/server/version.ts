/**
 * Which build of diff delver this is (`CodeVersion`). The command's build
 * (`vite.cli.config.ts`) writes it in as `__DIFF_DELVER_VERSION__`: the release
 * (or the package version marked `-dev`) and a hash of the code. Run from
 * source, as tests do, it is the package version marked `-dev+source`.
 */
import { parseCodeVersion, type CodeVersion } from '#lib/core/code-version.tiny.ts';

/** The package version, which the command's build also writes in. */
const PACKAGE_VERSION = '0.0.1';

export function codeVersion(): CodeVersion {
	const built = typeof __DIFF_DELVER_VERSION__ === 'string' ? __DIFF_DELVER_VERSION__ : undefined;
	const parsed = parseCodeVersion(built ?? `${PACKAGE_VERSION}-dev+source`);
	if (!parsed.ok)
		throw new Error(`The build wrote in a version that is not one: ${parsed.error.value}`);
	return parsed.value;
}
