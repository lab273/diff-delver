import { describe, expect, it } from 'vitest';
import { parseSnapshotId } from './snapshot-id.tiny.ts';
import { parseSourceIdentity } from './source-identity.tiny.ts';
import { parseStoreId } from './store-id.tiny.ts';

describe('the ids of stores, snapshots and source states', () => {
	it('accepts only the shapes the store makes', () => {
		expect(parseSnapshotId('0123456789abcdef0123456789abcdef').ok).toBe(true);
		expect(parseSnapshotId('0123456789ABCDEF0123456789abcdef').ok).toBe(false);
		expect(parseSnapshotId('short').ok).toBe(false);
		expect(parseStoreId('diff-delver-0123456789abcdef').ok).toBe(true);
		expect(parseStoreId('-leading').ok).toBe(false);
		expect(parseStoreId('has/slash').ok).toBe(false);
		expect(parseStoreId('a'.repeat(81)).ok).toBe(false);
		expect(parseSourceIdentity('a'.repeat(64)).ok).toBe(true);
		expect(parseSourceIdentity('a'.repeat(63)).ok).toBe(false);
	});
});
