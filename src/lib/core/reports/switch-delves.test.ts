import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../absolute-path.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import {
	DELVES_LISTED_WITHOUT_FINDING,
	findDelves,
	knownRepositories,
	offersFinding
} from './switch-delves.ts';

function folder(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`${path} is not an absolute path`);
	return parsed.value;
}

function delve(title: string, repository: string, directory: string) {
	return {
		title: reviewerMessage(title),
		repository: reviewerMessage(repository),
		directory: folder(directory)
	};
}

describe('knownRepositories', () => {
	it('gives each repository once, in the order its Delves come', () => {
		const known = knownRepositories([
			delve('Uncommitted changes', 'shop', '/work/shop'),
			delve('Staged changes', 'ledger', '/work/ledger'),
			delve('discounts compared with main', 'shop', '/work/shop')
		]);
		expect(known).toEqual([
			{ repository: 'shop', directory: '/work/shop', sameName: false },
			{ repository: 'ledger', directory: '/work/ledger', sameName: false }
		]);
	});

	it('says when two repositories in different folders have the same name', () => {
		const known = knownRepositories([
			delve('Uncommitted changes', 'shop', '/work/shop'),
			delve('Uncommitted changes', 'shop', '/old/shop'),
			delve('Uncommitted changes', 'ledger', '/work/ledger')
		]);
		expect(known.map((k) => [k.directory, k.sameName])).toEqual([
			['/work/shop', true],
			['/old/shop', true],
			['/work/ledger', false]
		]);
	});

	it('knows none when there are no Delves', () => {
		expect(knownRepositories([])).toEqual([]);
	});
});

describe('offersFinding', () => {
	it('offers a box to find a Delve only past a handful', () => {
		expect(offersFinding(0)).toBe(false);
		expect(offersFinding(DELVES_LISTED_WITHOUT_FINDING)).toBe(false);
		expect(offersFinding(DELVES_LISTED_WITHOUT_FINDING + 1)).toBe(true);
	});
});

describe('findDelves', () => {
	const delves = [
		delve('Uncommitted changes', 'shop', '/work/shop'),
		delve('discounts compared with origin/main', 'shop', '/work/shop'),
		delve('Staged changes', 'Ledger', '/work/ledger')
	];

	it('finds every Delve when nothing is typed', () => {
		expect(findDelves(delves, '')).toEqual(delves);
		expect(findDelves(delves, '   ')).toEqual(delves);
	});

	it('finds by title or repository, whatever the case of A to Z', () => {
		expect(findDelves(delves, 'DISCOUNT').map((d) => d.title)).toEqual([
			'discounts compared with origin/main'
		]);
		expect(findDelves(delves, 'ledger').map((d) => d.title)).toEqual(['Staged changes']);
	});

	it('needs every word typed, in any order, across title and repository', () => {
		expect(findDelves(delves, 'shop changes').map((d) => d.title)).toEqual(['Uncommitted changes']);
		expect(findDelves(delves, 'changes tea')).toEqual([]);
	});

	it('keeps the order given', () => {
		expect(findDelves(delves, 'changes').map((d) => d.repository)).toEqual(['shop', 'Ledger']);
	});
});
