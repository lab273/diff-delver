import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A version of diff delver's database schema: the number of a migration, 1 or more. */
export type SchemaVersion = Tiny<number, 'SchemaVersion'>;

export interface InvalidSchemaVersion {
	readonly kind: 'InvalidSchemaVersion';
	readonly value: number;
}

export function parseSchemaVersion(value: number): Result<SchemaVersion, InvalidSchemaVersion> {
	if (!Number.isSafeInteger(value) || value < 1)
		return err({ kind: 'InvalidSchemaVersion', value });
	return ok(value as SchemaVersion);
}

/** A version written in the code, such as a migration's. A failure is a bug. */
export function schemaVersionOf(value: number): SchemaVersion {
	const parsed = parseSchemaVersion(value);
	if (!parsed.ok) throw new RangeError(`Not a schema version: ${String(value)}`);
	return parsed.value;
}
