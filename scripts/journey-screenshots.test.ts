/** Naming the journey screenshots and finding stale ones (scripts/journey-screenshots.ts). */
import { describe, expect, it } from 'vitest';
import {
	auditScreenshots,
	describeAudit,
	journeySlug,
	producedScreenshots,
	SCREENSHOT_ANNOTATION,
	screenshotMode,
	screenshotName,
	stepSlug,
	withoutScreenshotVariables
} from './journey-screenshots.ts';

describe('the screenshot mode', () => {
	it('compares unless told to update, exactly', () => {
		expect(screenshotMode({})).toBe('compare');
		expect(screenshotMode({ DIFF_DELVER_SCREENSHOTS: 'Update' })).toBe('compare');
		expect(screenshotMode({ DIFF_DELVER_SCREENSHOTS: 'update' })).toBe('update');
	});

	it('is taken out of the environment pnpm verify runs with, which says what it took', () => {
		const { env, removed } = withoutScreenshotVariables({
			PATH: '/bin',
			DIFF_DELVER_SCREENSHOTS: 'update',
			DIFF_DELVER_SCREENSHOT_COPY: '/tmp/x'
		});
		expect(env).toEqual({ PATH: '/bin' });
		expect(screenshotMode(env)).toBe('compare');
		expect(removed).toEqual(['DIFF_DELVER_SCREENSHOTS', 'DIFF_DELVER_SCREENSHOT_COPY']);
		expect(withoutScreenshotVariables({ PATH: '/bin' }).removed).toEqual([]);
	});
});

describe('names', () => {
	it('turns a step name into plain lower-case words joined by hyphens', () => {
		expect(stepSlug('Start page')).toEqual({ ok: true, value: 'start-page' });
		expect(stepSlug('  Review #2: Café & tests! ')).toEqual({
			ok: true,
			value: 'review-2-cafe-tests'
		});
	});

	it('refuses a step name with no words, or one too long to read in a listing', () => {
		expect(stepSlug('!!!')).toEqual({ ok: false, error: { kind: 'InvalidStepName', name: '!!!' } });
		expect(stepSlug('word '.repeat(20)).ok).toBe(false);
	});

	it('names the journey after its file', () => {
		expect(journeySlug('/repo/tests/journeys/j0-first-run.journey.ts')).toBe('j0-first-run');
		expect(journeySlug('C:\\repo\\tests\\journeys\\j3-tick.journey.ts')).toBe('j3-tick');
	});

	it('names an image so that a listing reads in journey and step order', () => {
		const names = [
			screenshotName('j0-first-run', 10, 'finished', 'light'),
			screenshotName('j0-first-run', 2, 'overview', 'dark'),
			screenshotName('j0-first-run', 1, 'start-page', 'light')
		];
		expect([...names].sort()).toEqual([
			'j0-first-run.01.start-page.light.png',
			'j0-first-run.02.overview.dark.png',
			'j0-first-run.10.finished.light.png'
		]);
	});
});

describe('auditScreenshots', () => {
	it('finds nothing wrong when every committed image was produced once', () => {
		const names = ['a.01.x.light.png', 'a.01.x.dark.png'];
		const audit = auditScreenshots(names, names);
		expect(audit).toEqual({ stale: [], duplicates: [] });
		expect(describeAudit(audit)).toEqual([]);
	});

	it('finds committed images no step produced, and names produced twice', () => {
		const audit = auditScreenshots(
			['a.01.x.light.png', 'a.01.x.light.png'],
			['a.01.x.light.png', 'a.02.old.light.png', 'README.txt']
		);
		expect(audit).toEqual({ stale: ['a.02.old.light.png'], duplicates: ['a.01.x.light.png'] });
		expect(describeAudit(audit)).toEqual([
			'tests/journeys/screenshots/a.02.old.light.png is committed, but no journey step produces it any more. Run pnpm journeys:update to remove it, and commit the removal.',
			'a.01.x.light.png is produced by more than one step. Each journey file holds one test, so give the other test its own journey file.'
		]);
	});
});

describe('producedScreenshots', () => {
	const annotation = (description: string): unknown => ({
		type: SCREENSHOT_ANNOTATION,
		description
	});

	it('reads the names from the last attempt of every test, in nested suites', () => {
		const report = {
			suites: [
				{
					specs: [
						{
							tests: [
								{
									results: [
										{ annotations: [annotation('old.png')] },
										{ annotations: [annotation('a.png'), { type: 'other', description: 'x' }] }
									]
								}
							]
						}
					],
					suites: [{ specs: [{ tests: [{ results: [{ annotations: [annotation('b.png')] }] }] }] }]
				}
			]
		};
		expect(producedScreenshots(report)).toEqual(['a.png', 'b.png']);
	});

	it('tells a missing report from a run with no images', () => {
		expect(producedScreenshots(undefined)).toBeUndefined();
		expect(producedScreenshots({ suites: [] })).toEqual([]);
	});
});
