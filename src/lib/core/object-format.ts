/**
 * A repository's object format: the hash its object ids use (DESIGN 3.2). A store
 * holding a repository's objects must use the same one.
 */
import { err, ok, type Result } from './result.ts';
import { parseTreeId, type TreeId } from './tree-id.tiny.ts';

export type ObjectFormat = 'sha1' | 'sha256';

export interface InvalidObjectFormat {
	readonly kind: 'InvalidObjectFormat';
	readonly value: string;
}

/** Accepts git's names, as `git rev-parse --show-object-format` prints them. */
export function parseObjectFormat(value: string): Result<ObjectFormat, InvalidObjectFormat> {
	return value === 'sha1' || value === 'sha256'
		? ok(value)
		: err({ kind: 'InvalidObjectFormat', value });
}

function treeId(value: string): TreeId {
	const parsed = parseTreeId(value);
	if (!parsed.ok) throw new RangeError(`Not a tree id: ${value}`);
	return parsed.value;
}

/** git's empty tree in each format, which every repository can name without storing it. */
export const EMPTY_TREE: Readonly<Record<ObjectFormat, TreeId>> = {
	sha1: treeId('4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
	sha256: treeId('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321')
};
