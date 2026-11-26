/**
 * Where the daemon writes what a person or a bug report may need later: its
 * standard error, which is `daemon.log` in the data folder when the command
 * started it in the background (`launcher.ts`). Every line starts with when it
 * was written, by the daemon's clock (`core/daemon/log-line.ts`).
 */
import { formatWithOptions } from 'node:util';
import type { Clock } from '#lib/core/clock.ts';
import { logEntry } from '#lib/core/daemon/log-line.ts';

/** Writes one entry: its parts as `console.error` would join them, an error with its stack. */
export type DaemonLog = (...parts: readonly unknown[]) => void;

export function daemonLog(
	clock: Clock,
	write: (text: string) => void = (text) => {
		process.stderr.write(text);
	}
): DaemonLog {
	return (...parts) => {
		write(logEntry(clock.now(), formatWithOptions({ colors: false }, ...parts)));
	};
}
