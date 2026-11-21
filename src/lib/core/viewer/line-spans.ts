/**
 * Sets of lines of one side of a file as runs, `first` to `last`, and their
 * one written form in an address, `1-20,40-60`, for asking the daemon for
 * the colours of the lines a part shows.
 */
import { lineNumberOf, parseLineNumber, type LineNumber } from '../line-number.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import type { LineSpan } from './part-lines.ts';

/** Most runs one address may name. */
export const MOST_SPANS = 500;

/** The runs of the given lines, in order, each run as long as it can be. */
export function spansOf(lines: Iterable<LineNumber>): readonly LineSpan[] {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	const spans: LineSpan[] = [];
	for (const n of sorted) {
		const last = spans.at(-1);
		if (last !== undefined && last.last + 1 === n) {
			spans[spans.length - 1] = { first: last.first, last: n };
		} else spans.push({ first: n, last: n });
	}
	return spans;
}

/** Runs as an address writes them: `1-20,40-60`, and `7` for one line; nothing for none. */
export function writeSpans(spans: readonly LineSpan[]): string {
	return spans
		.map((s) => (s.first === s.last ? String(s.first) : `${String(s.first)}-${String(s.last)}`))
		.join(',');
}

export interface InvalidSpans {
	readonly kind: 'InvalidSpans';
	readonly text: string;
}

/** Runs read back from `writeSpans`'s form: in order, not overlapping, at most `MOST_SPANS`. */
export function readSpans(text: string): Result<readonly LineSpan[], InvalidSpans> {
	if (text === '') return ok([]);
	const parts = text.split(',');
	if (parts.length > MOST_SPANS) return err({ kind: 'InvalidSpans', text });
	const spans: LineSpan[] = [];
	for (const part of parts) {
		const found = /^([0-9]{1,9})(?:-([0-9]{1,9}))?$/.exec(part);
		const first = parseLineNumber(Number(found?.[1]));
		const last = parseLineNumber(Number(found?.[2] ?? found?.[1]));
		if (!first.ok || !last.ok || last.value < first.value)
			return err({ kind: 'InvalidSpans', text });
		const before = spans.at(-1);
		if (before !== undefined && first.value <= before.last)
			return err({ kind: 'InvalidSpans', text });
		spans.push({ first: first.value, last: last.value });
	}
	return ok(spans);
}

/** Every line of the runs. */
export function* linesIn(spans: readonly LineSpan[]): Generator<LineNumber> {
	for (const span of spans) {
		for (let n: number = span.first; n <= span.last; n += 1) yield lineNumberOf(n);
	}
}
