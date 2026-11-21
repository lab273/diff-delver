/**
 * What lint forbids in journey files (tests/journeys/), so that a journey reaches
 * the page only as a person does, by keyboard, through the journey helper
 * (tests/support/journey.ts; docs/DEVELOPING.md, "Checking the experience").
 *
 * The helper gives a journey no Playwright page, context or locator, so most of
 * Playwright is out of reach by construction. These rules close what is left: the
 * test's other fixtures, the methods that run code in the page or change it
 * behind its back, direct input, and the dynamic ways of reaching a property that
 * a list of names cannot see. eslint.config.js applies them; they are tested on
 * planted code in scripts/journey-rules.test.ts.
 */

const KEYBOARD_ONLY =
	'Journeys use the keyboard only (docs/DEVELOPING.md, "Checking the experience"): use journey.press, journey.type and journey.activate.';

const HELPER_ONLY =
	'Journeys reach the page only through the journey helper (tests/support/journey.ts). ' +
	'If a journey needs something it does not offer, add a named helper there.';

/** Playwright fixtures a journey must not take: each is a way round the helper. */
const FORBIDDEN_FIXTURES = [
	'page',
	'context',
	'browser',
	'browserName',
	'request',
	'playwright',
	'baseURL'
];

/**
 * Properties that run code in the page, change it without input, or lead back to
 * the Playwright objects the helper keeps to itself.
 */
const FORBIDDEN_PROPERTIES = [
	'evaluate',
	'evaluateAll',
	'evaluateHandle',
	'$eval',
	'$$eval',
	'$',
	'$$',
	'addScriptTag',
	'addStyleTag',
	'addInitScript',
	'setContent',
	'setExtraHTTPHeaders',
	'exposeFunction',
	'exposeBinding',
	'route',
	'routeFromHAR',
	'routeWebSocket',
	'unroute',
	'grantPermissions',
	'emulateMedia',
	'setViewportSize',
	'clock',
	'page',
	'context',
	'browser',
	'request',
	'frames',
	'mainFrame',
	'frameLocator',
	'locator',
	'elementHandle',
	'elementHandles',
	'extend',
	'use'
];

/** Methods that give input other than the keyboard, or type without the helper. */
const INPUT_METHODS = [
	'click',
	'dblclick',
	'fill',
	'clear',
	'hover',
	'tap',
	'check',
	'uncheck',
	'setChecked',
	'selectOption',
	'selectText',
	'dragTo',
	'dragAndDrop',
	'setInputFiles',
	'dispatchEvent',
	'press',
	'pressSequentially',
	'type',
	'focus',
	'blur'
];

const names = (list: readonly string[]): string =>
	list.map((name) => name.replace(/\$/g, '\\$')).join('|');

/** For `no-restricted-syntax` in journey files. */
export const JOURNEY_RESTRICTED_SYNTAX: readonly { selector: string; message: string }[] = [
	{
		selector: `CallExpression[callee.property.name=/^(${names(INPUT_METHODS)})$/]:not([callee.object.name='journey'])`,
		message: KEYBOARD_ONLY
	},
	{
		selector: 'MemberExpression[property.name=/^(mouse|touchscreen|keyboard)$/]',
		message: KEYBOARD_ONLY
	},
	{
		selector: `MemberExpression[property.name=/^(${names(FORBIDDEN_PROPERTIES)})$/]`,
		message: HELPER_ONLY
	},
	{
		selector: `ObjectPattern > Property[key.name=/^(${names(FORBIDDEN_FIXTURES)})$/]`,
		message: `A journey takes only the journey fixture. ${HELPER_ONLY}`
	},
	{
		// `x['evaluate']` and `x[name]` hide a property from the rules above.
		selector: "MemberExpression[computed=true][property.type!='Literal']",
		message: HELPER_ONLY
	},
	{
		selector: "MemberExpression[computed=true][property.type='Literal'][property.raw=/^['\"]/]",
		message: HELPER_ONLY
	},
	{
		selector: 'Identifier[name=/^(Reflect|Proxy|Function|globalThis|window|document)$/]',
		message: HELPER_ONLY
	}
];
