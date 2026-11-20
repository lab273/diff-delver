/**
 * Reading test times from the Vitest and Playwright JSON reports, and warning
 * only about what went over its guidance (scripts/test-timings.ts).
 */
import { measurementName } from '../src/lib/core/measurement-name.tiny.ts';
import { testFile } from '../src/lib/core/test-file.tiny.ts';
import { testName } from '../src/lib/core/test-name.tiny.ts';
import { describe, expect, it } from 'vitest';
import { millisecondsOf } from '../src/lib/core/milliseconds.tiny.ts';
import { TIME_LIMITS } from './test-time-limits.ts';
import {
	describeTimeWarning,
	playwrightTimings,
	slowest,
	timeWarnings,
	vitestTimings,
	warningFile,
	type TestTiming
} from './test-timings.ts';

const ROOT = '/repo';
const ms = millisecondsOf;

function vitestReport(
	files: readonly { name: string; tests: readonly Record<string, unknown>[] }[]
): unknown {
	return {
		testResults: files.map((f) => ({ name: `${ROOT}/${f.name}`, assertionResults: f.tests }))
	};
}

const quickRun = { ms: ms(10_000), guidance: ms(120_000) };

function timing(overrides: Partial<TestTiming>): TestTiming {
	return {
		layer: 'core',
		file: testFile('src/lib/core/a.test.ts'),
		name: testName('a works'),
		ms: ms(1),
		measurements: [],
		...overrides
	};
}

describe('vitestTimings', () => {
	it('reads each test with its file, layer and duration', () => {
		const report = vitestReport([
			{ name: 'src/lib/core/glob.test.ts', tests: [{ fullName: 'glob matches', duration: 12.5 }] },
			{ name: 'scripts/x.test.ts', tests: [{ fullName: 'x runs', duration: 900 }] }
		]);
		expect(vitestTimings(report, ROOT)).toEqual([
			{
				layer: 'core',
				file: 'src/lib/core/glob.test.ts',
				name: 'glob matches',
				ms: 12.5,
				measurements: []
			},
			{ layer: 'integration', file: 'scripts/x.test.ts', name: 'x runs', ms: 900, measurements: [] }
		]);
	});

	it('reads the times a test measured itself from its meta', () => {
		const report = vitestReport([
			{
				name: 'src/lib/scale.test.ts',
				tests: [
					{
						fullName: 'scale',
						duration: 300,
						meta: {
							measuredTimes: [{ what: measurementName('covering'), ms: 180, guidance: 1000 }]
						}
					}
				]
			}
		]);
		expect(vitestTimings(report, ROOT)[0]?.measurements).toEqual([
			{ what: measurementName('covering'), ms: 180, guidance: 1000 }
		]);
	});

	it('leaves out what it cannot read, and counts a missing duration as zero', () => {
		const report = vitestReport([
			{
				name: 'src/lib/core/a.test.ts',
				tests: [
					{
						fullName: 'a',
						duration: null,
						meta: {
							measuredTimes: [{ what: measurementName('x'), ms: -1, guidance: 5 }, { what: 'y' }]
						}
					}
				]
			}
		]);
		expect(vitestTimings(report, ROOT)).toEqual([
			{ layer: 'core', file: 'src/lib/core/a.test.ts', name: 'a', ms: 0, measurements: [] }
		]);
		expect(vitestTimings(undefined, ROOT)).toEqual([]);
		expect(vitestTimings({ testResults: 'nope' }, ROOT)).toEqual([]);
	});
});

describe('playwrightTimings', () => {
	it('reads each journey with its describe, title and the sum of its attempts', () => {
		const report = {
			config: { rootDir: `${ROOT}/tests/journeys` },
			suites: [
				{
					title: 'j0-first-run.journey.ts',
					specs: [],
					suites: [
						{
							title: 'J0 First run',
							specs: [
								{
									title: 'the start page',
									file: 'j0-first-run.journey.ts',
									tests: [{ results: [{ duration: 400 }, { duration: 600 }] }]
								}
							]
						}
					]
				}
			]
		};
		expect(playwrightTimings(report, ROOT)).toEqual([
			{
				layer: 'journey',
				file: 'tests/journeys/j0-first-run.journey.ts',
				name: 'J0 First run > the start page',
				ms: 1000,
				measurements: []
			}
		]);
		expect(playwrightTimings(undefined, ROOT)).toEqual([]);
	});
});

describe('timeWarnings', () => {
	it('says nothing when everything is within guidance', () => {
		const tests = [
			timing({ ms: ms(250) }),
			timing({ layer: 'integration', ms: ms(2_999) }),
			timing({ layer: 'journey', ms: ms(19_000) }),
			timing({ measurements: [{ what: measurementName('x'), ms: ms(100), guidance: ms(100) }] })
		];
		expect(timeWarnings(tests, TIME_LIMITS, quickRun)).toEqual([]);
	});

	it('holds each test to the guidance for its own type', () => {
		const core = timing({ ms: ms(251) });
		const integration = timing({ layer: 'integration', ms: ms(251) });
		const journey = timing({ layer: 'journey', ms: ms(20_001) });
		expect(timeWarnings([core, integration, journey], TIME_LIMITS, quickRun)).toEqual([
			{ kind: 'TestOverGuidance', test: core, guidance: 250 },
			{ kind: 'TestOverGuidance', test: journey, guidance: 20_000 }
		]);
	});

	it('warns about a measurement over its guidance even when the test is within its own', () => {
		const measurement = { what: measurementName('covering'), ms: ms(171), guidance: ms(150) };
		const test = timing({ ms: ms(200), measurements: [measurement] });
		expect(timeWarnings([test], TIME_LIMITS, quickRun)).toEqual([
			{ kind: 'MeasurementOverGuidance', test, measurement }
		]);
	});

	it('warns about a run over its guidance, and only then', () => {
		expect(timeWarnings([], TIME_LIMITS, { ms: ms(120_001), guidance: ms(120_000) })).toEqual([
			{ kind: 'RunOverGuidance', ms: 120_001, guidance: 120_000 }
		]);
		expect(timeWarnings([], TIME_LIMITS, { ms: ms(120_000), guidance: ms(120_000) })).toEqual([]);
	});
});

describe('describeTimeWarning', () => {
	it('names the test, how long it took and the guidance', () => {
		const test = timing({ name: testName('glob is quick'), ms: ms(312.4) });
		const warning = { kind: 'TestOverGuidance', test, guidance: ms(250) } as const;
		expect(describeTimeWarning(warning)).toBe(
			'src/lib/core/a.test.ts > glob is quick took 312 ms, over the 250 ms guidance for a core test.'
		);
		expect(warningFile(warning)).toBe('src/lib/core/a.test.ts');
	});

	it('names what a test measured', () => {
		const measurement = { what: measurementName('covering'), ms: ms(171.3), guidance: ms(150) };
		const test = timing({ name: testName('scale') });
		expect(describeTimeWarning({ kind: 'MeasurementOverGuidance', test, measurement })).toBe(
			'src/lib/core/a.test.ts > scale: covering took 171 ms, over its 150 ms guidance.'
		);
	});

	it('says what to do about a long run, and names no file', () => {
		const warning = { kind: 'RunOverGuidance', ms: ms(130_000), guidance: ms(120_000) } as const;
		expect(describeTimeWarning(warning)).toContain('took 130.0 s, over the 120.0 s');
		expect(describeTimeWarning(warning)).toContain('Time per step');
		expect(warningFile(warning)).toBeUndefined();
	});

	it('gives a long journey in seconds', () => {
		const test = timing({ layer: 'journey', ms: ms(24_500) });
		expect(describeTimeWarning({ kind: 'TestOverGuidance', test, guidance: ms(20_000) })).toContain(
			'took 24.5 s, over the 20.0 s guidance for a journey.'
		);
	});
});

describe('slowest', () => {
	it('lists the slowest first, without changing the input', () => {
		const tests = [timing({ ms: ms(1) }), timing({ ms: ms(3) }), timing({ ms: ms(2) })];
		expect(slowest(tests, 2).map((t) => t.ms)).toEqual([3, 2]);
		expect(tests.map((t) => t.ms)).toEqual([1, 3, 2]);
	});
});
