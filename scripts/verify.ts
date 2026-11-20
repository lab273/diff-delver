/**
 * `pnpm verify`: everything a commit must pass, in order, stopping at the first
 * failure. Prints how long each step took, the slowest tests, and a warning for
 * every test over the time guidance for its type and for a run that has become
 * unreasonably long. Time never fails the run (README, "Testing"); only a test that
 * hangs past its hang timeout does, and that is the test failing.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { millisecondsOf, type Milliseconds } from '../src/lib/core/milliseconds.tiny.ts';
import { TIME_LIMITS } from './test-time-limits.ts';
import {
	describeTimeWarning,
	formatMs,
	formatSeconds,
	playwrightTimings,
	slowest,
	timeWarnings,
	vitestTimings,
	warningFile,
	type TestTiming
} from './test-timings.ts';

/**
 * Past this, the whole run counts as unreasonably long and verify warns. Two
 * minutes: about ten times a run today, so only a real slowdown reaches it, and
 * the point at which running verify before every commit starts to be put off.
 * CI machines, several times slower, stay under it. Override with
 * VERIFY_WARN_AFTER_SECONDS.
 */
const DEFAULT_WARN_AFTER_SECONDS = 120;
const SLOWEST_SHOWN = 5;

const root = join(import.meta.dirname, '..');
const bin = (name: string): string => join(root, 'node_modules', '.bin', name);
const reportDir = join(root, '.verify');
const vitestReport = join(reportDir, 'vitest.json');
const playwrightReport = join(reportDir, 'playwright.json');

interface Command {
	readonly program: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

interface Step {
	readonly name: string;
	readonly commands: readonly Command[];
}

const inCi = process.env['CI'] !== undefined;
const inGitHubActions = process.env['GITHUB_ACTIONS'] === 'true';

const steps: readonly Step[] = [
	{ name: 'Format', commands: [{ program: bin('prettier'), args: ['--check', '.'] }] },
	{ name: 'Lint', commands: [{ program: bin('eslint'), args: ['.', '--max-warnings', '0'] }] },
	{
		name: 'Type check',
		commands: [
			{ program: bin('svelte-kit'), args: ['sync'] },
			{
				program: bin('svelte-check'),
				args: ['--tsconfig', './tsconfig.json', '--fail-on-warnings', '--output', 'human']
			}
		]
	},
	{
		name: 'Unit and integration tests',
		commands: [
			{
				program: bin('vitest'),
				args: ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${vitestReport}`]
			}
		]
	},
	{
		name: 'Production build',
		commands: [{ program: bin('vite'), args: ['build', '--logLevel', 'warn'] }]
	},
	{
		name: 'Journeys',
		commands: [
			{
				program: bin('playwright'),
				args: ['test', `--reporter=${inCi ? 'list,github,json' : 'list,json'}`],
				env: { PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightReport }
			}
		]
	}
];

function run(command: Command): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command.program, command.args, {
			cwd: root,
			stdio: 'inherit',
			env: { ...process.env, ...command.env }
		});
		child.on('error', (error) => {
			console.error(`Could not start ${command.program}: ${error.message}`);
			resolve(1);
		});
		child.on('exit', (code, signal) => {
			resolve(code ?? (signal === null ? 1 : 128));
		});
	});
}

interface StepTiming {
	readonly name: string;
	readonly ms: Milliseconds;
}

const elapsedSince = (started: number): Milliseconds => millisecondsOf(performance.now() - started);

function heading(text: string): void {
	console.log(`\n\u001b[1m${text}\u001b[0m`);
}

function readJson(path: string): unknown {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return parsed;
	} catch {
		return undefined;
	}
}

function printSlowest(title: string, timings: readonly TestTiming[]): void {
	if (timings.length === 0) return;
	heading(title);
	for (const t of slowest(timings, SLOWEST_SHOWN)) {
		console.log(`  ${formatMs(t.ms).padStart(8)}  ${t.file} > ${t.name}`);
	}
}

/** GitHub's workflow command syntax: `%`, CR and LF escaped in the message. */
function gitHubEscape(text: string): string {
	return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

// --- Main -----------------------------------------------------------------------

function warnAfter(): Milliseconds {
	const raw = process.env['VERIFY_WARN_AFTER_SECONDS'];
	if (raw === undefined || raw === '') return millisecondsOf(DEFAULT_WARN_AFTER_SECONDS * 1000);
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.error(
			`VERIFY_WARN_AFTER_SECONDS must be a positive number of seconds, not "${raw}". ` +
				'Set it to a number such as 300, or unset it to use the default of ' +
				`${String(DEFAULT_WARN_AFTER_SECONDS)}.`
		);
		process.exit(2);
	}
	return millisecondsOf(parsed * 1000);
}

async function main(): Promise<number> {
	const runGuidance = warnAfter();
	rmSync(reportDir, { recursive: true, force: true });
	mkdirSync(reportDir, { recursive: true });

	const started = performance.now();
	const timings: StepTiming[] = [];
	let failedStep: string | undefined;

	for (const step of steps) {
		heading(`▶ ${step.name}`);
		const stepStarted = performance.now();
		let code = 0;
		for (const command of step.commands) {
			code = await run(command);
			if (code !== 0) break;
		}
		timings.push({ name: step.name, ms: elapsedSince(stepStarted) });
		if (code !== 0) {
			failedStep = step.name;
			break;
		}
	}
	const totalMs = elapsedSince(started);

	heading('Time per step');
	for (const t of timings) console.log(`  ${formatSeconds(t.ms).padStart(8)}  ${t.name}`);

	const unitTimings = vitestTimings(readJson(vitestReport), root);
	const journeyTimings = playwrightTimings(readJson(playwrightReport), root);
	printSlowest('Slowest unit and integration tests', unitTimings);
	printSlowest('Slowest journeys', journeyTimings);

	const warnings = timeWarnings([...unitTimings, ...journeyTimings], TIME_LIMITS, {
		ms: totalMs,
		guidance: runGuidance
	});
	if (warnings.length > 0) {
		heading(
			`\u001b[33m⚠ ${String(warnings.length)} over the time guidance (README, "Testing"). ` +
				'They do not fail the run; each is a prompt to look for a faster way.\u001b[0m'
		);
		for (const warning of warnings) {
			const message = describeTimeWarning(warning);
			console.log(`\u001b[33m  ⚠ ${message}\u001b[0m`);
			if (inGitHubActions) {
				const file = warningFile(warning);
				const where = file === undefined ? '' : `file=${file},`;
				console.log(`::warning ${where}title=Over the time guidance::${gitHubEscape(message)}`);
			}
		}
	}

	heading(`Total ${formatSeconds(totalMs)}`);
	if (failedStep === undefined) {
		console.log('\u001b[32m✔ verify passed\u001b[0m');
		return 0;
	}
	console.error(`\u001b[31m✘ ${failedStep} failed. See its output above.\u001b[0m`);
	return 1;
}

process.exitCode = await main();
