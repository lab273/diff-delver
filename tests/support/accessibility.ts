import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** The WCAG levels every screen must meet. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Scans what is on the page now and fails with a readable list of problems.
 * Every journey step calls it (tests/support/journey.ts), in both colour schemes.
 */
export async function expectAccessible(page: Page): Promise<void> {
	const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
	const problems = results.violations.map(
		(violation) =>
			`${violation.id} (${violation.impact ?? 'unknown impact'}): ${violation.help}\n` +
			violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n')
	);
	expect(problems, `Accessibility problems on ${page.url()}`).toEqual([]);
}
