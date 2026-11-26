/**
 * The command's entry in the build: runs `main` with the process's arguments
 * and exits with its status. An unexpected failure is said in one line, with
 * where to report it, not as a stack trace; in a daemon's log, with its time.
 */
import { daemonLog } from '../daemon/daemon-log.ts';
import { systemClock } from '../system.ts';
import { main } from './main.ts';

const entry = process.argv[1] ?? '';
main(process.argv.slice(2), process.cwd(), entry).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		const message = `diff delver failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. Please report this as a bug.`;
		// A daemon the command started in the background writes to its log, with the time.
		if (process.send === undefined) process.stderr.write(`${message}\n`);
		else daemonLog(systemClock)(message);
		process.exitCode = 1;
	}
);
