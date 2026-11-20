/**
 * `pnpm verify`: everything a commit must pass, in order, stopping at the first
 * failure. Prints how long each step took and the slowest tests, and fails if the
 * whole run is over its time budget.
 *
 * Budgets come from the README, "Testing". The total budget is for a laptop; slower
 * machines such as CI set VERIFY_BUDGET_SECONDS.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_TOTAL_BUDGET_SECONDS = 90;
const CORE_SUITE_BUDGET_MS = 5_000;
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

interface Timing {
	readonly name: string;
	readonly ms: number;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const millis = (ms: number): string => `${Math.round(ms)} ms`;

function heading(text: string): void {
	console.log(`\n\u001b[1m${text}\u001b[0m`);
}

// --- Reading the test reports ---------------------------------------------------

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Json[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readJson(path: string): unknown {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return parsed;
	} catch {
		return undefined;
	}
}

interface TestTiming extends Timing {
	readonly file: string;
}

function vitestTimings(): readonly TestTiming[] {
	const report = readJson(vitestReport);
	if (!isRecord(report)) return [];
	return records(report['testResults']).flatMap((file) =>
		records(file['assertionResults']).map((test) => ({
			file: text(file['name']).replace(`${root}/`, ''),
			name: text(test['fullName']),
			ms: number(test['duration'])
		}))
	);
}

function playwrightTimings(): readonly TestTiming[] {
	const report = readJson(playwrightReport);
	if (!isRecord(report)) return [];
	const timings: TestTiming[] = [];
	const visit = (suite: Json, titles: readonly string[]): void => {
		const here = [...titles, text(suite['title'])].filter((t) => t !== '');
		for (const spec of records(suite['specs'])) {
			for (const test of records(spec['tests'])) {
				const ms = records(test['results']).reduce((sum, r) => sum + number(r['duration']), 0);
				timings.push({
					file: text(spec['file']),
					name: [...here.slice(1), text(spec['title'])].join(' > '),
					ms
				});
			}
		}
		for (const child of records(suite['suites'])) visit(child, here);
	};
	for (const suite of records(report['suites'])) visit(suite, []);
	return timings;
}

function printSlowest(title: string, timings: readonly TestTiming[]): void {
	if (timings.length === 0) return;
	heading(title);
	const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_SHOWN);
	for (const t of slowest) {
		console.log(`  ${millis(t.ms).padStart(8)}  ${t.file} > ${t.name}`);
	}
}

// --- Main -----------------------------------------------------------------------

function totalBudgetMs(): number {
	const raw = process.env['VERIFY_BUDGET_SECONDS'];
	if (raw === undefined || raw === '') return DEFAULT_TOTAL_BUDGET_SECONDS * 1000;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.error(`VERIFY_BUDGET_SECONDS must be a positive number of seconds, not "${raw}".`);
		process.exit(2);
	}
	return parsed * 1000;
}

async function main(): Promise<number> {
	const budgetMs = totalBudgetMs();
	rmSync(reportDir, { recursive: true, force: true });
	mkdirSync(reportDir, { recursive: true });

	const started = performance.now();
	const timings: Timing[] = [];
	let failedStep: string | undefined;

	for (const step of steps) {
		heading(`▶ ${step.name}`);
		const stepStarted = performance.now();
		let code = 0;
		for (const command of step.commands) {
			code = await run(command);
			if (code !== 0) break;
		}
		timings.push({ name: step.name, ms: performance.now() - stepStarted });
		if (code !== 0) {
			failedStep = step.name;
			break;
		}
	}
	const totalMs = performance.now() - started;

	heading('Time per step');
	for (const t of timings) console.log(`  ${seconds(t.ms).padStart(8)}  ${t.name}`);

	const unitTimings = vitestTimings();
	printSlowest('Slowest unit and integration tests', unitTimings);
	printSlowest('Slowest journeys', playwrightTimings());

	const problems: string[] = [];
	if (failedStep !== undefined) problems.push(`${failedStep} failed. See its output above.`);

	const coreMs = unitTimings
		.filter((t) => t.file.startsWith('src/lib/core/'))
		.reduce((sum, t) => sum + t.ms, 0);
	if (coreMs > CORE_SUITE_BUDGET_MS) {
		problems.push(
			`The core tests took ${seconds(coreMs)} together, over their budget of ${seconds(CORE_SUITE_BUDGET_MS)}.`
		);
	}
	if (totalMs > budgetMs) {
		problems.push(
			`The whole check took ${seconds(totalMs)}, over its budget of ${seconds(budgetMs)}. ` +
				'Find the slow step above; on a slower machine, set VERIFY_BUDGET_SECONDS.'
		);
	}

	heading(`Total ${seconds(totalMs)} (budget ${seconds(budgetMs)})`);
	if (problems.length === 0) {
		console.log('\u001b[32m✔ verify passed\u001b[0m');
		return 0;
	}
	for (const problem of problems) console.error(`\u001b[31m✘ ${problem}\u001b[0m`);
	return 1;
}

process.exitCode = await main();
