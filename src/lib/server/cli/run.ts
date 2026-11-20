/**
 * The command's entry in the build: runs `main` with the process's arguments
 * and exits with its status. An unexpected failure is said in one line, with
 * where to report it, not as a stack trace.
 */
import { main } from './main.ts';

const entry = process.argv[1] ?? '';
main(process.argv.slice(2), process.cwd(), entry).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(
			`diff delver failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. Please report this as a bug.\n`
		);
		process.exitCode = 1;
	}
);
