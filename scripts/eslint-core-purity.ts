/**
 * A lint rule for core code (README, "Layout"): no clock, timezone, locale or
 * build environment. It covers what `no-restricted-globals` and
 * `no-restricted-properties` in eslint.config.js cannot see, because a global is
 * allowed in some positions and not in others, or because the call looks like
 * any other. It follows every reference to the global, so an alias
 * (`const D = Date`) is a reference in a position that is not allowed.
 *
 * - `Date` only as `Date.UTC(...)`, `new Date(value)` with a first argument that
 *   is not spread, `x instanceof Date`, or a type. `new Date()`, `Date()`,
 *   `Date.now()` and `Date.parse()` read the clock or the local timezone.
 * - `Temporal` only through its members other than `Temporal.Now`.
 * - `Intl` not at all: its formatters fall back to the machine's locale and
 *   timezone. Format at the edge, or pass a formatter in.
 * - `Reflect.construct`, which builds a `Date` without `new`.
 * - `import.meta`, which holds the build environment.
 * - Methods whose result depends on the locale or the timezone, whatever they are
 *   called on: `toLocaleString` and the like, `localeCompare`,
 *   `getTimezoneOffset`, and `Date`'s local-time getters and setters (the
 *   `getUTC...` and `setUTC...` forms are fine).
 * - `toString()` and `String(...)` of a value whose type is `Date`, which print
 *   local time. These two need type information.
 */
import {
	AST_NODE_TYPES,
	ESLintUtils,
	type TSESLint,
	type TSESTree
} from '@typescript-eslint/utils';

const LOCAL_METHODS: ReadonlySet<string> = new Set([
	'toLocaleString',
	'toLocaleDateString',
	'toLocaleTimeString',
	'toLocaleUpperCase',
	'toLocaleLowerCase',
	'localeCompare',
	'getTimezoneOffset',
	'toDateString',
	'toTimeString',
	'getFullYear',
	'getYear',
	'getMonth',
	'getDate',
	'getDay',
	'getHours',
	'getMinutes',
	'getSeconds',
	'getMilliseconds',
	'setFullYear',
	'setYear',
	'setMonth',
	'setDate',
	'setHours',
	'setMinutes',
	'setSeconds',
	'setMilliseconds'
]);

const WATCHED_GLOBALS = ['Date', 'Temporal', 'Intl', 'Reflect'] as const;

type MessageId =
	'date' | 'temporal' | 'intl' | 'reflect' | 'importMeta' | 'localMethod' | 'dateText';

/** The property a member expression names, when it is written out. */
function propertyName(node: TSESTree.MemberExpression): string | undefined {
	if (!node.computed)
		return node.property.type === AST_NODE_TYPES.Identifier ? node.property.name : undefined;
	return node.property.type === AST_NODE_TYPES.Literal ? String(node.property.value) : undefined;
}

/** Whether a reference to one of the watched globals is in a position that reads nothing. */
function allowed(id: TSESTree.Identifier): boolean {
	const parent = id.parent;
	const member =
		parent.type === AST_NODE_TYPES.MemberExpression && parent.object === id ? parent : undefined;
	switch (id.name) {
		case 'Date':
			return (
				(member !== undefined && !member.computed && propertyName(member) === 'UTC') ||
				(parent.type === AST_NODE_TYPES.NewExpression &&
					parent.callee === id &&
					parent.arguments[0] !== undefined &&
					parent.arguments[0].type !== AST_NODE_TYPES.SpreadElement) ||
				(parent.type === AST_NODE_TYPES.BinaryExpression &&
					parent.operator === 'instanceof' &&
					parent.right === id)
			);
		case 'Temporal': {
			const name = member === undefined ? undefined : propertyName(member);
			return name !== undefined && name !== 'Now';
		}
		case 'Reflect': {
			const name = member === undefined ? undefined : propertyName(member);
			return name !== undefined && name !== 'construct';
		}
		default:
			return false;
	}
}

function messageFor(name: string): MessageId {
	switch (name) {
		case 'Date':
			return 'date';
		case 'Temporal':
			return 'temporal';
		case 'Reflect':
			return 'reflect';
		default:
			return 'intl';
	}
}

/** Whether a reference reads the value, not only a type such as `: Date`. */
function readsValue(reference: TSESLint.Scope.Reference): boolean {
	return reference.isValueReference;
}

export const corePurity = ESLintUtils.RuleCreator.withoutDocs<[], MessageId>({
	meta: {
		type: 'problem',
		defaultOptions: [],
		schema: [],
		messages: {
			date: '`Date` used like this reads the clock or the local timezone. Use Date.UTC(...) or new Date(value), or take time from the Clock.',
			temporal:
				'`Temporal.Now` reads the clock. Take time from the Clock; other Temporal members are fine.',
			intl: "`Intl` falls back to the machine's locale and timezone. Format at the edge, or pass a formatter in.",
			reflect: '`Reflect.construct` can build a Date without `new`. Core does not use it.',
			importMeta:
				'`import.meta` holds the build environment. Pass what is needed in from the edge.',
			localMethod:
				"`{{name}}` depends on the machine's locale or timezone. Use a fixed form (getUTC..., toISOString, a plain comparison) or format at the edge.",
			dateText: 'Turning a Date into text this way prints local time. Use toISOString().'
		}
	},
	create(context) {
		const services = context.sourceCode.parserServices;
		/** Whether the expression's type is the built-in Date; false without type information. */
		const isDate = (node: TSESTree.Node): boolean => {
			if (services?.program === undefined || services.program === null) return false;
			return (
				ESLintUtils.getParserServices(context).getTypeAtLocation(node).getSymbol()?.getName() ===
				'Date'
			);
		};

		return {
			'Program:exit'(program) {
				const scope = context.sourceCode.getScope(program);
				for (const name of WATCHED_GLOBALS) {
					const references = new Set([
						...(scope.set.get(name)?.references ?? []),
						...scope.through.filter((r) => r.identifier.name === name)
					]);
					for (const reference of references) {
						if (!readsValue(reference)) continue;
						// A local variable of the same name is not the global.
						if (reference.resolved !== null && reference.resolved.defs.length > 0) continue;
						const id = reference.identifier;
						if (id.type !== AST_NODE_TYPES.Identifier || allowed(id)) continue;
						context.report({ node: id, messageId: messageFor(name) });
					}
				}
			},
			MetaProperty(node) {
				if (node.meta.name === 'import') context.report({ node, messageId: 'importMeta' });
			},
			MemberExpression(node) {
				const name = propertyName(node);
				if (name !== undefined && LOCAL_METHODS.has(name)) {
					context.report({ node, messageId: 'localMethod', data: { name } });
				} else if (
					name === 'toString' &&
					node.parent.type === AST_NODE_TYPES.CallExpression &&
					node.parent.callee === node &&
					isDate(node.object)
				) {
					context.report({ node, messageId: 'dateText' });
				}
			},
			CallExpression(node) {
				const [first] = node.arguments;
				if (
					node.callee.type === AST_NODE_TYPES.Identifier &&
					node.callee.name === 'String' &&
					first !== undefined &&
					isDate(first)
				) {
					context.report({ node, messageId: 'dateText' });
				}
			}
		};
	}
});

const plugin = { meta: { name: 'diff-delver-core' }, rules: { purity: corePurity } };

/**
 * The rule as a plugin, `core/purity`. Typed only by its name, as
 * typescript-eslint types its own plugin, because ESLint's rule types and
 * typescript-eslint's do not match although the rules work in both.
 */
export const corePurityPlugin: { readonly meta: { readonly name: string } } = plugin;
