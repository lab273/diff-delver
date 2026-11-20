/**
 * The journey screenshots, from the command line.
 *
 *   node scripts/journeys.ts check <report.json>
 *       After a complete journey run (pnpm verify runs this): fails if a committed
 *       image is no longer produced by any step, or two steps produce one name.
 *   pnpm journeys:update
 *       Builds, runs every journey, rewrites the images whose pixels changed,
 *       adds new ones, removes the ones no step produces, and says which.
 *   pnpm journeys:repeat [runs]
 *       The determinism check: builds once and runs every journey many times
 *       (20 by default), in parallel, comparing every screenshot with the
 *       committed image, and reports whether the runs gave identical pixels and
 *       identical bytes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	auditScreenshots,
	describeAudit,
	producedScreenshots,
	SCREENSHOT_DIRECTORY
} from './journey-screenshots.ts';
import { comparePngPixels } from './png-pixels.ts';

const root = join(import.meta.dirname, '..');
const bin = (name: string): string => join(root, 'node_modules', '.bin', name);
const screenshots = join(root, SCREENSHOT_DIRECTORY);
const DEFAULT_RUNS = 20;

function run(
	program: string,
	args: readonly string[],
	env: Record<string, string> = {}
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(program, args, {
			cwd: root,
			stdio: 'inherit',
			env: { ...process.env, ...env }
		});
		child.on('error', () => {
			resolve(1);
		});
		child.on('exit', (code) => {
			resolve(code ?? 1);
		});
	});
}

async function readJson(path: string): Promise<unknown> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
		return parsed;
	} catch {
		return undefined;
	}
}

async function committed(): Promise<readonly string[]> {
	try {
		return (await readdir(screenshots)).filter((name) => name.endsWith('.png')).sort();
	} catch {
		return [];
	}
}

async function hashes(): Promise<ReadonlyMap<string, string>> {
	const result = new Map<string, string>();
	for (const name of await committed()) {
		const bytes = await readFile(join(screenshots, name));
		result.set(name, createHash('sha256').update(bytes).digest('hex'));
	}
	return result;
}

/** Builds the app and runs every journey, with a JSON report in `report`. */
async function journeys(
	report: string,
	env: Record<string, string>,
	extra: readonly string[] = []
): Promise<number> {
	const built = await run(bin('vite'), ['build', '--logLevel', 'warn']);
	if (built !== 0) return built;
	return run(bin('playwright'), ['test', '--reporter=list,json', ...extra], {
		PLAYWRIGHT_JSON_OUTPUT_FILE: report,
		...env
	});
}

async function check(reportPath: string | undefined): Promise<number> {
	if (reportPath === undefined) {
		console.error(
			'Say which Playwright JSON report to check: node scripts/journeys.ts check <report.json>.'
		);
		return 2;
	}
	const produced = producedScreenshots(await readJson(reportPath));
	if (produced === undefined) {
		console.error(
			`Could not read the journey report ${reportPath}, so the screenshots could not be checked. ` +
				'Run the journeys again.'
		);
		return 1;
	}
	const problems = describeAudit(auditScreenshots(produced, await committed()));
	for (const problem of problems) console.error(`✘ ${problem}`);
	if (problems.length === 0)
		console.log(`✔ Every committed screenshot is produced by a step (${String(produced.length)}).`);
	return problems.length === 0 ? 0 : 1;
}

async function update(): Promise<number> {
	if (process.platform !== 'linux') {
		console.error(
			`The committed screenshots are Linux images, and this is ${process.platform}. ` +
				'Run pnpm journeys:update on Linux, or let CI tell you which images changed.'
		);
		return 1;
	}
	const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-journeys-'));
	try {
		const before = await hashes();
		const report = join(scratch, 'report.json');
		const code = await journeys(report, { DIFF_DELVER_SCREENSHOTS: 'update' });
		if (code !== 0) {
			console.error(
				'\nThe journeys failed on something other than a screenshot (see above), so no stale ' +
					'image was removed. Fix that and run pnpm journeys:update again.'
			);
			return code;
		}
		const produced = producedScreenshots(await readJson(report)) ?? [];
		const audit = auditScreenshots(produced, await committed());
		for (const name of audit.stale) await rm(join(screenshots, name));
		for (const problem of describeAudit({ stale: [], duplicates: audit.duplicates })) {
			console.error(`✘ ${problem}`);
		}
		const after = await hashes();
		const changed = [...after]
			.filter(([n, h]) => before.has(n) && before.get(n) !== h)
			.map(([n]) => n);
		const added = [...after.keys()].filter((n) => !before.has(n));
		console.log('');
		for (const name of changed) console.log(`  changed  ${name}`);
		for (const name of added) console.log(`  added    ${name}`);
		for (const name of audit.stale) console.log(`  removed  ${name}`);
		const unchanged = after.size - changed.length - added.length;
		console.log(
			changed.length + added.length + audit.stale.length === 0
				? `No screenshot changed (${String(unchanged)} checked).`
				: `${String(unchanged)} unchanged. Look at the changed images, then commit them with the change.`
		);
		return audit.duplicates.length === 0 ? 0 : 1;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function repeat(runsArgument: string | undefined): Promise<number> {
	const runs = runsArgument === undefined ? DEFAULT_RUNS : Number(runsArgument);
	if (!Number.isSafeInteger(runs) || runs < 2) {
		console.error(
			`Give the number of runs as a whole number of 2 or more, not "${String(runsArgument)}".`
		);
		return 2;
	}
	const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-repeat-'));
	try {
		const copies = join(scratch, 'copies');
		const code = await journeys(
			join(scratch, 'report.json'),
			{ DIFF_DELVER_SCREENSHOT_COPY: copies },
			[`--repeat-each=${String(runs)}`]
		);
		const byName = new Map<string, Buffer[]>();
		for (const index of await readdir(copies).catch(() => [])) {
			for (const name of await readdir(join(copies, index))) {
				const list = byName.get(name) ?? [];
				list.push(await readFile(join(copies, index, name)));
				byName.set(name, list);
			}
		}
		let different = 0;
		console.log('');
		for (const [name, shots] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
			const first = shots[0];
			if (first === undefined) continue;
			const byteHashes = new Set(shots.map((s) => createHash('sha256').update(s).digest('hex')));
			const pixelSame = shots.every((s) => comparePngPixels(first, s).kind === 'Same');
			if (!pixelSame) different += 1;
			console.log(
				`  ${pixelSame ? '✔' : '✘'} ${name}: ${String(shots.length)} screenshots, ` +
					`${pixelSame ? 'identical pixels' : 'DIFFERENT pixels'}, ` +
					`${String(byteHashes.size)} distinct file(s) by bytes`
			);
		}
		if (code !== 0 || different > 0 || byName.size === 0) {
			console.error(
				`\n✘ Not deterministic, or a journey failed: ${String(different)} image(s) varied between runs. ` +
					'See above; the journey output names any screenshot that differs from the committed one.'
			);
			return 1;
		}
		console.log(
			`\n✔ ${String(runs)} runs of every journey: every screenshot identical, and equal to the committed image.`
		);
		return 0;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function main(args: readonly string[]): Promise<number> {
	const command: string = args[0] ?? '';
	switch (command) {
		case 'check':
			return check(args[1]);
		case 'update':
			return update();
		case 'repeat':
			return repeat(args[1]);
		default:
			console.error('Use one of: check <report.json>, update, repeat [runs].');
			return 2;
	}
}

process.exitCode = await main(process.argv.slice(2));
