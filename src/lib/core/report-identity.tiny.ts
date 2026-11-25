import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * What makes two sources the same source (DESIGN 6.1), as one string: at most one
 * report per identity is open. Written as a JSON array of strings whose first is
 * the kind of source, such as `["git","<store>","working-tree","/work/tree"]`.
 * Made by `reports/report-identity.ts`, which says what counts as the same.
 */
export type ReportIdentity = Tiny<string, 'ReportIdentity'>;

export interface InvalidReportIdentity {
	readonly kind: 'InvalidReportIdentity';
	readonly value: string;
}

/** The kinds of source a report can follow. */
const KINDS: ReadonlySet<string> = new Set(['git', 'github']);

/** Accepts the written form: a JSON array of at least two strings, the first a known kind. */
export function parseReportIdentity(value: string): Result<ReportIdentity, InvalidReportIdentity> {
	let parts: unknown;
	try {
		parts = JSON.parse(value);
	} catch {
		return err({ kind: 'InvalidReportIdentity', value });
	}
	const valid =
		Array.isArray(parts) &&
		parts.length >= 2 &&
		parts.every((part) => typeof part === 'string') &&
		KINDS.has(String(parts[0])) &&
		JSON.stringify(parts) === value;
	return valid ? ok(value as ReportIdentity) : err({ kind: 'InvalidReportIdentity', value });
}
