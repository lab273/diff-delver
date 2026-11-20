import { expect, test } from '@playwright/test';
import { expectAccessibleInBothThemes } from '../support/accessibility.ts';

// J0 First run. So far only the start page exists; this journey grows as the
// first build step lands.
test.describe('J0 First run', () => {
	test('the start page names the product and says nothing is open yet', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { level: 1, name: 'diff delver' })).toBeVisible();
		await expect(page.getByText('No diffs have been opened yet.')).toBeVisible();
		await expect(page).toHaveTitle('diff delver');

		await expectAccessibleInBothThemes(page);
	});
});
