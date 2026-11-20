/**
 * Git object ids: full lowercase hex, 40 characters for SHA-1 repositories and
 * 64 for SHA-256 ones. Abbreviated ids are not accepted; diff delver always asks
 * git for full ids.
 */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether a string is a full git object id. */
export function isObjectId(value: string): boolean {
	return OBJECT_ID.test(value);
}

/** Whether an object id is git's all-zero id, which stands for "no object". */
export function isNullObjectId(value: string): boolean {
	return /^0+$/.test(value);
}
