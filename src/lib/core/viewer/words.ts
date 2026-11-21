/**
 * The viewer's numbers in words (DESIGN 8.5): counts with their thousands
 * separated, changes and their progress, file sizes. One "change" is one added
 * line, one removed line, or one change to a file itself (its name, its mode,
 * its kind, or the whole of a file with no lines), so the counts here are the
 * counts of the list of diffs and the command.
 *
 * Written out by hand, not with the locale's formatting, so they read the same
 * on every machine.
 */
import type { ByteSize } from '../byte-size.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { PartTally } from './parts.ts';

/** A whole number with its thousands separated by commas: 200,000. */
export function formatCount(count: number): string {
	const digits = String(Math.trunc(Math.abs(count)));
	const sign = count < 0 ? '−' : '';
	let out = '';
	for (let i = 0; i < digits.length; i += 1) {
		if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
		out += digits.charAt(i);
	}
	return sign + out;
}

/** "1 change", "1,234 changes"; with `what`, "1 file", "3 files". */
export function countOf(count: number, one: string, many: string): string {
	return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** "1 change", "12 changes". */
export function describeChanges(count: number): ReviewerMessage {
	return reviewerMessage(countOf(count, 'change', 'changes'));
}

/**
 * How far a part, a file or a group has got, briefly: "Reviewed", "2 of 5
 * changes reviewed", "5 changes".
 */
export function describeTally(tally: PartTally): ReviewerMessage {
	if (tally.units === 0) return reviewerMessage('Nothing to review');
	if (tally.reviewed === tally.units) return reviewerMessage('Reviewed');
	if (tally.reviewed === 0) return describeChanges(tally.units);
	return reviewerMessage(
		`${formatCount(tally.reviewed)} of ${countOf(tally.units, 'change', 'changes')} reviewed`
	);
}

/** A file's size: "0 bytes", "512 bytes", "1.5 KB", "12 MB", in units of 1,024. */
export function describeByteSize(size: ByteSize): ReviewerMessage {
	if (size < 1024) return reviewerMessage(countOf(size, 'byte', 'bytes'));
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = size / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	// One decimal below 10, as GitHub shows sizes; none from 10 up.
	const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	const text = Number.isInteger(shown) ? formatCount(shown) : shown.toFixed(1);
	return reviewerMessage(`${text} ${units[unit] ?? 'TB'}`);
}
