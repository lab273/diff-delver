import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** The WCAG levels every screen must meet. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Scans what is on the page now and fails with a readable list of problems.
 * Call it once on every screen a journey reaches.
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

/** Scans the page in the light theme and again in the dark theme. */
export async function expectAccessibleInBothThemes(page: Page): Promise<void> {
	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme });
		await expectAccessible(page);
	}
}
