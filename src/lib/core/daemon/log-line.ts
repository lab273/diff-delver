/**
 * How the daemon writes a line of its log (`daemon.log` in the data folder,
 * when the command started it in the background): each line starts with when
 * it was written, in UTC to the second, so a person can tell the order of
 * starts, replacements and refusals.
 */
import type { Timestamp } from '../timestamp.tiny.ts';

/** A moment in ISO 8601, in UTC, to the second: "2026-11-26T21:49:22Z". */
export function logTime(at: Timestamp): string {
	const date = new Date(at);
	const two = (n: number): string => String(n).padStart(2, '0');
	const year = String(date.getUTCFullYear()).padStart(4, '0');
	return `${year}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}T${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}Z`;
}

/**
 * `text` as the log has it: every line of it, as with a stack trace, starting
 * with the time it was written, and ended with a line break.
 */
export function logEntry(at: Timestamp, text: string): string {
	const time = logTime(at);
	return text
		.replace(/\n+$/, '')
		.split('\n')
		.map((line) => `${time} ${line}\n`)
		.join('');
}
