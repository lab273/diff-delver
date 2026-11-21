/**
 * What was wrong with a tool call's arguments, in terms of the call: Zod's own
 * issues, turned into sentences an agent can act on, naming the field by its
 * place (`items[2].lines`), what it should be, and the fields an object takes.
 * Zod's raw messages never reach the agent. A field a tool does not take but
 * an agent may still send can have a sentence of its own, saying why.
 */
import { z } from 'zod';
import { textForAgent, type TextForAgent } from '#lib/core/text-for-agent.tiny.ts';

/** At most this many problems are written out. */
const MAX_PROBLEMS = 8;

type Issue = z.core.$ZodIssue;

function placeOf(path: readonly PropertyKey[]): string {
	if (path.length === 0) return 'The call';
	let out = '';
	for (const key of path) {
		out += typeof key === 'number' ? `[${String(key)}]` : `${out === '' ? '' : '.'}${String(key)}`;
	}
	return `"${out}"`;
}

/** The schema at a path of a schema, through objects, lists and optional values. */
function schemaAt(schema: z.ZodType, path: readonly PropertyKey[]): z.ZodType | undefined {
	let at: z.ZodType | undefined = schema;
	for (const key of path) {
		at = unwrapped(at);
		if (at instanceof z.ZodObject && typeof key === 'string') {
			const shape: Record<string, z.ZodType | undefined> = at.shape;
			at = shape[key];
		} else if (at instanceof z.ZodArray && typeof key === 'number') {
			at = at.element instanceof z.ZodType ? at.element : undefined;
		} else {
			return undefined;
		}
	}
	return unwrapped(at);
}

function unwrapped(schema: z.ZodType | undefined): z.ZodType | undefined {
	let at = schema;
	while (at instanceof z.ZodOptional || at instanceof z.ZodDefault) {
		const inner: unknown = at.unwrap();
		at = inner instanceof z.ZodType ? inner : undefined;
	}
	return at;
}

function fieldsOf(schema: z.ZodType | undefined): readonly string[] {
	return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

const EXPECTED: Readonly<Record<string, string>> = {
	string: 'text',
	number: 'a number',
	int: 'a whole number',
	boolean: 'true or false',
	array: 'a list',
	object: 'an object'
};

function describeIssue(issue: Issue, schema: z.ZodType): string {
	const where = placeOf(issue.path);
	switch (issue.code) {
		case 'invalid_type':
			if (issue.input === undefined) return `${where} is missing.`;
			return `${where} should be ${EXPECTED[issue.expected] ?? issue.expected}.`;
		case 'too_big':
			if (issue.origin === 'string') {
				return `${where} is too long: at most ${String(issue.maximum)} characters.`;
			}
			if (issue.origin === 'array') {
				return `${where} has too many entries: at most ${String(issue.maximum)} in one call. Send the rest in another call.`;
			}
			return `${where} is too large: at most ${String(issue.maximum)}.`;
		case 'too_small':
			if (issue.origin === 'string') return `${where} is empty.`;
			if (issue.origin === 'array') {
				return `${where} is empty: give at least ${String(issue.minimum)}.`;
			}
			return `${where} is too small: at least ${String(issue.minimum)}.`;
		case 'invalid_value':
			return `${where} must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}.`;
		case 'unrecognized_keys': {
			const fields = fieldsOf(schemaAt(schema, issue.path));
			return `${where} has ${issue.keys.length === 1 ? 'a field' : 'fields'} this tool does not take: ${issue.keys.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}.${fields.length > 0 ? ` The fields are ${fields.map((f) => `"${f}"`).join(', ')}.` : ''}`;
		}
		case 'invalid_union':
		case 'invalid_format':
		case 'not_multiple_of':
		case 'invalid_key':
		case 'invalid_element':
		case 'custom':
			return `${where} is not in the form this tool takes.`;
	}
}

/** The arguments' problems, at most a few, with the call's own example after them. */
export function describeInputProblems(
	tool: string,
	schema: z.ZodType,
	error: z.ZodError,
	example: string,
	notTaken: Readonly<Record<string, string>> = {}
): TextForAgent {
	const issues = error.issues.slice(0, MAX_PROBLEMS).map((issue) => describeIssue(issue, schema));
	const more = error.issues.length - issues.length;
	const why = error.issues.flatMap((issue) =>
		issue.code === 'unrecognized_keys' && issue.path.length === 0
			? issue.keys.flatMap((key) => {
					const said = Object.hasOwn(notTaken, key) ? notTaken[key] : undefined;
					return said === undefined ? [] : [said];
				})
			: []
	);
	return textForAgent(
		[
			`The call to ${tool} was refused before anything was read or changed:`,
			...issues.map((i) => `- ${i}`),
			...(more > 0 ? [`- and ${String(more)} more problems like these.`] : []),
			...why,
			`For example: ${example}`
		].join('\n')
	);
}
