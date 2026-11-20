import { expect, test } from '../support/journey.ts';

// J0 First run. So far only the start page exists; this journey grows as the
// first build step lands.
test.describe('J0 First run', () => {
	test('the start page names the product and says nothing is open yet', async ({ journey }) => {
		await journey.open('/');

		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'diff delver' }));
		await journey.expectVisible(journey.byText('No diffs have been opened yet.'));
		expect(await journey.title()).toBe('diff delver');
		// Nothing on the page takes focus yet; this lists what Tab reaches once it does.
		expect(await journey.tabOrder()).toEqual([]);

		await journey.step('Start page');
	});
});
