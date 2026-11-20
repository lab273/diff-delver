/**
 * How long the tests took, read from the Vitest and Playwright JSON reports, and
 * which of them went over the time guidance for their type (README, "Testing").
 * Pure: `scripts/verify.ts` reads the files and prints what this returns.
 */
import {
	millisecondsOf,
	parseMilliseconds,
	type Milliseconds
} from '../src/lib/core/milliseconds.tiny.ts';
import { CORE_TEST_DIRECTORY, type TestLayer, type TimeLimit } from './test-time-limits.ts';

/** A time a test measured itself (tests/support/measured-time.ts). */
export interface Measurement {
	readonly what: string;
	readonly ms: Milliseconds;
	readonly guidance: Milliseconds;
}

/** One test and how long it took. */
export interface TestTiming {
	readonly layer: TestLayer;
	/** The test file, relative to the repository. */
	readonly file: string;
	/** The test's describe blocks and title, joined with " > ". */
	readonly name: string;
	readonly ms: Milliseconds;
	readonly measurements: readonly Measurement[];
}

/** Something that took longer than it should have. A warning, never a failure. */
export type TimeWarning =
	| {
			readonly kind: 'TestOverGuidance';
			readonly test: TestTiming;
			readonly guidance: Milliseconds;
	  }
	| {
			readonly kind: 'MeasurementOverGuidance';
			readonly test: TestTiming;
			readonly measurement: Measurement;
	  }
	| {
			readonly kind: 'RunOverGuidance';
			readonly ms: Milliseconds;
			readonly guidance: Milliseconds;
	  };

// --- Reading the reports ----------------------------------------------------------

/** A JSON object's fields. */
type Json = ReadonlyMap<string, unknown>;

function asRecord(value: unknown): Json | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const fields: [string, unknown][] = Object.entries(value);
	return new Map(fields);
}

function records(value: unknown): readonly Json[] {
	if (!Array.isArray(value)) return [];
	const items: readonly unknown[] = value;
	return items.flatMap((item) => asRecord(item) ?? []);
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function duration(value: unknown): Milliseconds {
	const parsed = parseMilliseconds(typeof value === 'number' ? value : 0);
	return parsed.ok ? parsed.value : millisecondsOf(0);
}

function relative(file: string, root: string): string {
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function measurements(meta: unknown): readonly Measurement[] {
	return records(asRecord(meta)?.get('measuredTimes')).flatMap((m) => {
		const ms = m.get('ms');
		const guidance = m.get('guidance');
		if (typeof ms !== 'number' || typeof guidance !== 'number') return [];
		const parsedMs = parseMilliseconds(ms);
		const parsedGuidance = parseMilliseconds(guidance);
		if (!parsedMs.ok || !parsedGuidance.ok) return [];
		return [{ what: text(m.get('what')), ms: parsedMs.value, guidance: parsedGuidance.value }];
	});
}

/** The tests in a Vitest JSON report. Anything unreadable is left out. */
export function vitestTimings(report: unknown, root: string): readonly TestTiming[] {
	return records(asRecord(report)?.get('testResults')).flatMap((file) => {
		const path = relative(text(file.get('name')), root);
		const layer: TestLayer = path.startsWith(CORE_TEST_DIRECTORY) ? 'core' : 'integration';
		return records(file.get('assertionResults')).map((test) => ({
			layer,
			file: path,
			name: text(test.get('fullName')),
			ms: duration(test.get('duration')),
			measurements: measurements(test.get('meta'))
		}));
	});
}

/** The journeys in a Playwright JSON report, one entry per test, its attempts added up. */
export function playwrightTimings(report: unknown, root: string): readonly TestTiming[] {
	const config = asRecord(asRecord(report)?.get('config'));
	const testDir = text(config?.get('rootDir'));
	const timings: TestTiming[] = [];
	const visit = (suite: Json, titles: readonly string[]): void => {
		const here = [...titles, text(suite.get('title'))].filter((t) => t !== '');
		for (const spec of records(suite.get('specs'))) {
			for (const test of records(spec.get('tests'))) {
				const ms = records(test.get('results')).reduce(
					(sum, r) => sum + duration(r.get('duration')),
					0
				);
				timings.push({
					layer: 'journey',
					file: relative(
						testDir === '' ? text(spec.get('file')) : `${testDir}/${text(spec.get('file'))}`,
						root
					),
					// The first title is the file's, already given by `file`.
					name: [...here.slice(1), text(spec.get('title'))].join(' > '),
					ms: millisecondsOf(ms),
					measurements: []
				});
			}
		}
		for (const child of records(suite.get('suites'))) visit(child, here);
	};
	for (const suite of records(asRecord(report)?.get('suites'))) visit(suite, []);
	return timings;
}

// --- Judging them -------------------------------------------------------------------

/**
 * Every test over the guidance for its type, every measurement over its own, and
 * the whole run if it went over `runGuidance`. Empty when everything is within
 * guidance, so nothing is printed then.
 */
export function timeWarnings(
	tests: readonly TestTiming[],
	limits: Readonly<Record<TestLayer, TimeLimit>>,
	run: { readonly ms: Milliseconds; readonly guidance: Milliseconds }
): readonly TimeWarning[] {
	const warnings: TimeWarning[] = [];
	for (const test of tests) {
		const guidance = limits[test.layer].guidance;
		if (test.ms > guidance) warnings.push({ kind: 'TestOverGuidance', test, guidance });
		for (const measurement of test.measurements) {
			if (measurement.ms > measurement.guidance) {
				warnings.push({ kind: 'MeasurementOverGuidance', test, measurement });
			}
		}
	}
	if (run.ms > run.guidance) warnings.push({ kind: 'RunOverGuidance', ...run });
	return warnings;
}

/** The slowest `count` tests, slowest first. */
export function slowest(tests: readonly TestTiming[], count: number): readonly TestTiming[] {
	return [...tests].sort((a, b) => b.ms - a.ms).slice(0, count);
}

// --- Saying so ---------------------------------------------------------------------

export function formatMs(ms: Milliseconds): string {
	return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
}

export function formatSeconds(ms: Milliseconds): string {
	return `${(ms / 1000).toFixed(1)} s`;
}

const LAYER_NAMES: Readonly<Record<TestLayer, string>> = {
	core: 'core test',
	integration: 'integration test',
	journey: 'journey'
};

/** One line for a person: which test, how long, and the guidance. */
export function describeTimeWarning(warning: TimeWarning): string {
	switch (warning.kind) {
		case 'TestOverGuidance':
			return (
				`${warning.test.file} > ${warning.test.name} took ${formatMs(warning.test.ms)}, ` +
				`over the ${formatMs(warning.guidance)} guidance for a ${LAYER_NAMES[warning.test.layer]}.`
			);
		case 'MeasurementOverGuidance':
			return (
				`${warning.test.file} > ${warning.test.name}: ${warning.measurement.what} took ` +
				`${formatMs(warning.measurement.ms)}, over its ${formatMs(warning.measurement.guidance)} guidance.`
			);
		case 'RunOverGuidance':
			return (
				`The whole check took ${formatSeconds(warning.ms)}, over the ${formatSeconds(warning.guidance)} ` +
				'at which it counts as unreasonably long. Find the slow step in "Time per step" above.'
			);
		default: {
			const unknown: never = warning;
			return unknown;
		}
	}
}

/** The file a warning is about, for a CI annotation, if it is about one. */
export function warningFile(warning: TimeWarning): string | undefined {
	switch (warning.kind) {
		case 'TestOverGuidance':
		case 'MeasurementOverGuidance':
			return warning.test.file;
		case 'RunOverGuidance':
			return undefined;
		default: {
			const unknown: never = warning;
			return unknown;
		}
	}
}
