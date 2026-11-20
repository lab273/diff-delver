import { expect, test } from '../support/journey.ts';

// J0 First run. So far only the start page exists; this journey grows as the
// first build step lands.
test.describe('J0 First run', () => {
	test('the start page names the product and says nothing is open yet', async ({ journey }) => {
		const { page } = journey;
		await journey.open('/');

		await expect(page.getByRole('heading', { level: 1, name: 'diff delver' })).toBeVisible();
		await expect(page.getByText('No diffs have been opened yet.')).toBeVisible();
		await expect(page).toHaveTitle('diff delver');
		// Nothing on the page takes focus yet; this lists what Tab reaches once it does.
		expect(await journey.tabOrder()).toEqual([]);

		await journey.step('Start page');
	});
});
