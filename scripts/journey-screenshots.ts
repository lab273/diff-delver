/**
 * The committed journey screenshots (README, "Checking the experience"): where
 * each step's images live and what they are called, which images a run produced,
 * and which committed ones no step produces any more. Pure; the journey helper
 * (tests/support/journey.ts) and `pnpm journeys:*` (scripts/journeys.ts) use it.
 *
 * Every image is in one directory, named so that a listing reads as the journeys:
 *
 *     j0-first-run.01.start-page.dark.png
 *     j0-first-run.01.start-page.light.png
 *     j0-first-run.02.….png
 */

import { err, ok, type Result } from '../src/lib/core/result.ts';
import type { StepNumber } from '../src/lib/core/step-number.tiny.ts';

/** Where the committed images are, relative to the repository. */
export const SCREENSHOT_DIRECTORY = 'tests/journeys/screenshots';

/**
 * Set to `update` by `pnpm journeys:update` (scripts/journeys.ts): steps then
 * rewrite the committed images that changed instead of failing on them.
 */
export const SCREENSHOT_MODE_VARIABLE = 'DIFF_DELVER_SCREENSHOTS';

/** Set by `pnpm journeys:repeat` to a directory every screenshot is copied into. */
export const SCREENSHOT_COPY_VARIABLE = 'DIFF_DELVER_SCREENSHOT_COPY';

/** Whether a step compares its screenshots with the committed ones or rewrites them. */
export type ScreenshotMode = 'compare' | 'update';

export function screenshotMode(env: Readonly<Record<string, string | undefined>>): ScreenshotMode {
	return env[SCREENSHOT_MODE_VARIABLE] === 'update' ? 'update' : 'compare';
}

/**
 * The environment without the variables that change what the journeys do with
 * their screenshots, and which of them were set. `pnpm verify` runs with this, so
 * it only ever compares: a variable left over in a shell cannot make it rewrite
 * the committed images and pass.
 */
export function withoutScreenshotVariables(env: Readonly<Record<string, string | undefined>>): {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly removed: readonly string[];
} {
	const variables = [SCREENSHOT_MODE_VARIABLE, SCREENSHOT_COPY_VARIABLE];
	return {
		env: Object.fromEntries(Object.entries(env).filter(([name]) => !variables.includes(name))),
		removed: variables.filter((name) => env[name] !== undefined)
	};
}

/** Said at the start of a journey run that rewrites images, so it is never mistaken for a check. */
export const UPDATE_MODE_NOTICE = [
	'',
	'!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
	`!! ${SCREENSHOT_MODE_VARIABLE}=update: the journeys REWRITE the committed screenshots`,
	'!! that changed instead of checking them. This run checks nothing about the images.',
	'!! Look at every changed image before you commit it. Unset the variable to compare.',
	'!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
	''
].join('\n');

/** The annotation each step adds to its test for every image it produced or checked. */
export const SCREENSHOT_ANNOTATION = 'journey-screenshot';

/** Both colour schemes, in the order a step takes them. */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The longest step slug, so that names stay readable in a listing. */
const MAX_SLUG_LENGTH = 60;

/** Why a step name cannot name an image. */
export interface InvalidStepName {
	readonly kind: 'InvalidStepName';
	readonly name: string;
}

/**
 * The step name as it appears in a file name: lower case, words joined with
 * hyphens. "Start page" becomes `start-page`.
 */
export function stepSlug(name: string): Result<string, InvalidStepName> {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	if (slug === '' || slug.length > MAX_SLUG_LENGTH) {
		return err({ kind: 'InvalidStepName', name });
	}
	return ok(slug);
}

/** The journey's name as files use it: its test file's name, `j0-first-run.journey.ts` → `j0-first-run`. */
export function journeySlug(testFile: string): string {
	const base = testFile.split(/[/\\]/).at(-1) ?? testFile;
	return base.replace(/\.journey\.ts$/, '');
}

/** The image file name of one step in one theme. Steps are numbered from 1. */
export function screenshotName(
	journey: string,
	step: StepNumber,
	slug: string,
	theme: Theme
): string {
	return `${journey}.${String(step).padStart(2, '0')}.${slug}.${theme}.png`;
}

/** What a complete run left wrong in the screenshot directory. */
export interface ScreenshotAudit {
	/** Committed images that no step produced. */
	readonly stale: readonly string[];
	/** Names more than one step produced, so they would overwrite each other. */
	readonly duplicates: readonly string[];
}

/** Compares the images a complete run produced with the ones in the directory. */
export function auditScreenshots(
	produced: readonly string[],
	committed: readonly string[]
): ScreenshotAudit {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of produced) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return {
		stale: committed.filter((name) => name.endsWith('.png') && !seen.has(name)).sort(),
		duplicates: [...duplicates].sort()
	};
}

/** What to tell the person about an audit, one line per problem; empty when all is well. */
export function describeAudit(audit: ScreenshotAudit): readonly string[] {
	return [
		...audit.stale.map(
			(name) =>
				`${SCREENSHOT_DIRECTORY}/${name} is committed, but no journey step produces it any more. ` +
				'Run pnpm journeys:update to remove it, and commit the removal.'
		),
		...audit.duplicates.map(
			(name) =>
				`${name} is produced by more than one step. Each journey file holds one test, ` +
				'so give the other test its own journey file.'
		)
	];
}

// --- Reading the Playwright report ------------------------------------------------------

function fields(value: unknown): ReadonlyMap<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Map();
	return new Map<string, unknown>(Object.entries(value));
}

function list(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Every screenshot name the steps of a run recorded, from a Playwright JSON
 * report, once per attempt that recorded it. Undefined when there is no readable
 * report, so a missing report is never mistaken for a run with no images.
 */
export function producedScreenshots(report: unknown): readonly string[] | undefined {
	const root = fields(report);
	if (!root.has('suites')) return undefined;
	const names: string[] = [];
	const visit = (suite: unknown): void => {
		const s = fields(suite);
		for (const spec of list(s.get('specs'))) {
			for (const test of list(fields(spec).get('tests'))) {
				// Retries would record the same names again; only the last attempt counts.
				const result = list(fields(test).get('results')).at(-1);
				for (const annotation of list(fields(result).get('annotations'))) {
					const a = fields(annotation);
					const description = a.get('description');
					if (a.get('type') === SCREENSHOT_ANNOTATION && typeof description === 'string') {
						names.push(description);
					}
				}
			}
		}
		for (const child of list(s.get('suites'))) visit(child);
	};
	for (const suite of list(root.get('suites'))) visit(suite);
	return names;
}
