import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** The WCAG levels every screen must meet. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Scans what is on the page now and fails with a readable list of problems.
 * Every journey step calls it (tests/support/journey.ts), in both colour schemes.
 */
export async function expectAccessible(page: Page): Promise<void> {
	// Legacy mode runs axe in the page in one call; the default runs it frame by
	// frame and finishes in a second page, which costs seconds on a long page. What
	// legacy mode gives up is frames from another origin, and a journey's pages
	// have none: requests outside the app are refused. Only violations are wanted,
	// so axe does not spend time describing what passed.
	const results = await new AxeBuilder({ page })
		.withTags(WCAG_TAGS)
		.setLegacyMode(true)
		.options({ resultTypes: ['violations'] })
		.analyze();
	const problems = results.violations.map(
		(violation) =>
			`${violation.id} (${violation.impact ?? 'unknown impact'}): ${violation.help}\n` +
			violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n')
	);
	expect(problems, `Accessibility problems on ${page.url()}`).toEqual([]);
}
