#!/usr/bin/env node
// The `diff-delver` command. Plain JavaScript that any Node can read, so an old
// Node gets a sentence saying what to do instead of a syntax error; the command
// itself is in the build (build/cli/diff-delver.js, from src/lib/server/cli/).
const NEEDED = 26;
const [major = '0'] = process.versions.node.split('.');
if (Number(major) < NEEDED) {
	process.stderr.write(
		`diff delver needs Node ${NEEDED} or newer; this is Node ${process.versions.node}. ` +
			'Install the current Node (https://nodejs.org lists how), then run diff-delver again.\n'
	);
	process.exit(1);
}

const built = new URL('../build/cli/diff-delver.js', import.meta.url);
import(built.href).catch((/** @type {unknown} */ error) => {
	const code = error instanceof Error && 'code' in error ? error.code : undefined;
	const message = error instanceof Error ? error.message : String(error);
	if (code === 'ERR_MODULE_NOT_FOUND' && message.includes(built.pathname)) {
		process.stderr.write(
			'diff delver has not been built yet. In its folder, run pnpm install, then pnpm build, ' +
				'then run diff-delver again.\n'
		);
	} else {
		process.stderr.write(`diff delver could not start: ${message}\n`);
	}
	process.exitCode = 1;
});
