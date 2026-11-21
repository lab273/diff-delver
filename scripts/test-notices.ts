/**
 * The notices tests recorded (tests/support/test-notices.ts), read from the
 * Vitest JSON report: things a person should know that never fail the run.
 * Pure: `scripts/verify.ts` reads the file and prints what this returns.
 */

/** One notice, with the test file that recorded it, relative to the repository. */
export interface TestNotice {
	readonly file: string;
	readonly text: string;
}

function fields(value: unknown): ReadonlyMap<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const entries: [string, unknown][] = Object.entries(value);
	return new Map(entries);
}

function items(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Every notice in a Vitest JSON report, in the report's order. Anything unreadable is left out. */
export function vitestNotices(report: unknown, root: string): readonly TestNotice[] {
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return items(fields(report)?.get('testResults')).flatMap((file) => {
		const name = fields(file)?.get('name');
		const path =
			typeof name === 'string' && name.startsWith(prefix)
				? name.slice(prefix.length)
				: String(name);
		return items(fields(file)?.get('assertionResults')).flatMap((test) =>
			items(fields(fields(test)?.get('meta'))?.get('notices')).flatMap((notice) =>
				typeof notice === 'string' ? [{ file: path, text: notice }] : []
			)
		);
	});
}
