import { err, ok, type Result } from './result.ts';

/**
 * What a change line is for. Roles only change how the reviewer may group lines
 * (DESIGN 4.4); they never change coverage.
 */
export type Role = 'code' | 'test' | 'snapshot';

export const ROLES: readonly Role[] = ['code', 'test', 'snapshot'];

export interface InvalidRole {
	readonly kind: 'InvalidRole';
	readonly value: string;
}

export function parseRole(value: string): Result<Role, InvalidRole> {
	switch (value) {
		case 'code':
		case 'test':
		case 'snapshot':
			return ok(value);
		default:
			return err({ kind: 'InvalidRole', value });
	}
}
