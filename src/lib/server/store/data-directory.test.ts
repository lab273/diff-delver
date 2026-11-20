import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { machineDataDirectory } from './data-directory.ts';

describe('machineDataDirectory', () => {
	it("is under this machine's home or data folder, in a diff-delver folder", () => {
		const dir = machineDataDirectory();
		expect(dir.ok).toBe(true);
		if (dir.ok) {
			expect(dir.value.endsWith('diff-delver')).toBe(true);
			expect(dir.value.startsWith(process.env['XDG_DATA_HOME'] ?? homedir())).toBe(true);
		}
	});
});
