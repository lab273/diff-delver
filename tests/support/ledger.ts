/**
 * The ledger: a medium-sized diff of believable TypeScript, for the agent
 * trials (tests/agent-trials/) and the journeys that show what an agent made of
 * it. A small invoicing service, committed, then changed in the working tree by
 * three concerns at once, as a person's uncommitted work often is:
 *
 * - **Currencies.** Invoices get a currency: `money.ts` carries one, a new
 *   `currency.ts` knows each currency's minor units and how it rounds tax, the
 *   formatter shows symbols (and moves, renamed, to `format/amount.ts`), the API
 *   and its generated types take a currency, the store keeps one (with a
 *   migration), and the PDF snapshot is re-recorded.
 * - **Structured logging.** `log.ts` becomes a logger of JSON lines with levels
 *   and fields, and its callers change with it, in the same files as the
 *   currency changes: `server/routes.ts`, `store/invoices.ts`, `config.ts` and
 *   `invoice.ts` each hold lines of both.
 * - **Housekeeping.** A test framework bump (the lockfile), the release script
 *   made executable, a new logo.
 *
 * It has one test that covers nothing in particular (`tests/smoke.test.ts`), a
 * generated file marked `linguist-generated` in `.gitattributes`, a lockfile, a
 * re-recorded snapshot, a rename, a file made executable and a small image.
 * Real git builds it, with `GitRepo`'s fixed identity and dates, so its trees
 * are the same everywhere.
 */
import { createHash } from 'node:crypto';
import type { GitRepo } from './git-repo.ts';

const text = (...lines: readonly string[]): string => `${lines.join('\n')}\n`;

/** A tiny PNG, made different by its last bytes. */
function png(variant: number): Uint8Array {
	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		0,
		0,
		0,
		0x0d,
		0x49,
		0x48,
		0x44,
		0x52,
		0,
		0,
		0,
		0x10,
		0,
		0,
		0,
		0x10,
		8,
		6,
		0,
		0,
		0,
		variant,
		variant + 1,
		variant + 2,
		variant + 3
	]);
}

// --- The lockfile ------------------------------------------------------------

interface LockedPackage {
	readonly name: string;
	readonly version: string;
	readonly dependencies?: Readonly<Record<string, string>>;
}

function integrity(name: string, version: string): string {
	return `sha512-${createHash('sha512').update(`${name}@${version}`).digest('base64')}`;
}

function lockfile(
	direct: Readonly<Record<string, string>>,
	packages: readonly LockedPackage[]
): string {
	const out = [
		"lockfileVersion: '9.0'",
		'',
		'settings:',
		'  autoInstallPeers: true',
		'  excludeLinksFromLockfile: false',
		'',
		'importers:',
		'',
		'  .:',
		'    devDependencies:'
	];
	for (const [name, version] of Object.entries(direct)) {
		out.push(`      ${name}:`, `        specifier: ^${version}`, `        version: ${version}`);
	}
	out.push('', 'packages:', '');
	for (const p of packages) {
		out.push(
			`  ${p.name}@${p.version}:`,
			`    resolution: {integrity: ${integrity(p.name, p.version)}}`,
			''
		);
	}
	out.push('snapshots:', '');
	for (const p of packages) {
		out.push(`  ${p.name}@${p.version}:`);
		const deps = Object.entries(p.dependencies ?? {});
		if (deps.length > 0) {
			out.push('    dependencies:');
			for (const [name, version] of deps) out.push(`      ${name}: ${version}`);
		}
		out.push('');
	}
	return text(...out.slice(0, -1));
}

/** esbuild's packages for each platform, which a bump of the test framework moves together. */
const ESBUILD_PLATFORMS = [
	'aix-ppc64',
	'android-arm',
	'android-arm64',
	'android-x64',
	'darwin-arm64',
	'darwin-x64',
	'freebsd-arm64',
	'freebsd-x64',
	'linux-arm',
	'linux-arm64',
	'linux-ia32',
	'linux-loong64',
	'linux-mips64el',
	'linux-ppc64',
	'linux-riscv64',
	'linux-s390x',
	'linux-x64',
	'netbsd-x64',
	'openbsd-x64',
	'sunos-x64',
	'win32-arm64',
	'win32-ia32',
	'win32-x64'
] as const;

function testFramework(
	version: string,
	chai: string,
	tinypool: string,
	esbuild: string
): LockedPackage[] {
	return [
		...ESBUILD_PLATFORMS.map((platform) => ({ name: `@esbuild/${platform}`, version: esbuild })),
		{
			name: 'esbuild',
			version: esbuild,
			dependencies: Object.fromEntries(ESBUILD_PLATFORMS.map((p) => [`@esbuild/${p}`, esbuild]))
		},
		{ name: '@vitest/expect', version, dependencies: { chai } },
		{ name: '@vitest/runner', version, dependencies: { '@vitest/utils': version } },
		{ name: '@vitest/snapshot', version, dependencies: { '@vitest/pretty-format': version } },
		{ name: '@vitest/spy', version, dependencies: { tinyspy: '4.0.3' } },
		{ name: '@vitest/utils', version, dependencies: { loupe: '3.1.4' } },
		{ name: '@vitest/pretty-format', version },
		{ name: 'chai', version: chai, dependencies: { 'assertion-error': '2.0.1', loupe: '3.1.4' } },
		{ name: 'tinypool', version: tinypool },
		{
			name: 'vitest',
			version,
			dependencies: {
				'@vitest/expect': version,
				'@vitest/runner': version,
				'@vitest/snapshot': version,
				'@vitest/spy': version,
				esbuild,
				tinypool
			}
		}
	];
}

const SHARED_PACKAGES: readonly LockedPackage[] = [
	{ name: 'assertion-error', version: '2.0.1' },
	{ name: 'loupe', version: '3.1.4' },
	{ name: 'tinyspy', version: '4.0.3' },
	{ name: 'typescript', version: '5.8.3' }
];

// --- The generated API types -------------------------------------------------

interface Schema {
	readonly name: string;
	readonly doc: string;
	readonly fields: readonly (readonly [string, string, string])[];
}

/** What `openapi-typescript` would write for these schemas. */
function apiTypes(schemas: readonly Schema[]): string {
	const out = [
		'/**',
		' * This file was generated from api/openapi.yaml by `pnpm openapi:generate`.',
		' * Do not edit it by hand: change the schema and generate it again.',
		' */',
		''
	];
	for (const schema of schemas) {
		out.push(`/** ${schema.doc} */`, `export interface ${schema.name} {`);
		for (const [field, type, doc] of schema.fields) {
			out.push(`\t/** ${doc} */`, `\t${field}: ${type};`);
		}
		out.push('}', '');
	}
	return text(...out.slice(0, -1));
}

const LINE_FIELDS_BEFORE = [
	['description', 'string', 'What was sold.'],
	['quantity', 'number', 'How many, which may be a fraction for hours.'],
	['unit_price_cents', 'number', 'The price of one, in cents.'],
	['tax_rate', "'standard' | 'reduced' | 'zero'", 'Which tax rate applies.']
] as const;

const LINE_FIELDS_AFTER = [
	['description', 'string', 'What was sold.'],
	['quantity', 'number', 'How many, which may be a fraction for hours.'],
	['unit_price_minor', 'number', "The price of one, in the minor unit of the invoice's currency."],
	['tax_rate', "'standard' | 'reduced' | 'zero'", 'Which tax rate applies.']
] as const;

const CURRENCY_TYPE = "'EUR' | 'GBP' | 'USD' | 'JPY' | 'CHF' | 'SEK' | 'KWD'";

const SCHEMAS_BEFORE: readonly Schema[] = [
	{
		name: 'InvoiceLineRequest',
		doc: 'One line of an invoice to create.',
		fields: LINE_FIELDS_BEFORE
	},
	{
		name: 'CreateInvoiceRequest',
		doc: 'The body of POST /invoices.',
		fields: [
			['id', 'string', 'The invoice number, chosen by the caller.'],
			['customer_id', 'string', 'Who the invoice is for.'],
			['issued_on', 'string', 'The date of issue, as YYYY-MM-DD.'],
			['lines', 'InvoiceLineRequest[]', 'What was sold, in order.']
		]
	},
	{
		name: 'InvoiceLineResponse',
		doc: 'One line of an invoice, as the API returns it.',
		fields: [
			['description', 'string', 'What was sold.'],
			['quantity', 'string', 'How many, formatted.'],
			['unit_price', 'string', 'The price of one, formatted.'],
			['net', 'string', 'Quantity times price, formatted.'],
			['tax_rate', 'string', 'The tax rate, as a percentage.']
		]
	},
	{
		name: 'InvoiceResponse',
		doc: 'An invoice with its totals.',
		fields: [
			['id', 'string', 'The invoice number.'],
			['customer_id', 'string', 'Who the invoice is for.'],
			['issued_on', 'string', 'The date of issue, as YYYY-MM-DD.'],
			['net', 'string', 'The total before tax, formatted.'],
			['tax', 'string', 'The tax, formatted.'],
			['gross', 'string', 'The total with tax, formatted.'],
			['lines', 'InvoiceLineResponse[]', 'What was sold, in order.']
		]
	},
	{
		name: 'ErrorResponse',
		doc: 'Why a request was refused.',
		fields: [
			['error', 'string', 'What went wrong, in a sentence.'],
			['problems', 'string[] | undefined', 'Each problem found, when there were several.']
		]
	},
	{
		name: 'CustomerResponse',
		doc: 'A customer.',
		fields: [
			['id', 'string', 'The customer number.'],
			['name', 'string', 'The name invoices are addressed to.'],
			['email', 'string', 'Where invoices are sent.']
		]
	}
];

const SCHEMAS_AFTER: readonly Schema[] = [
	{
		name: 'InvoiceLineRequest',
		doc: 'One line of an invoice to create.',
		fields: LINE_FIELDS_AFTER
	},
	{
		name: 'CreateInvoiceRequest',
		doc: 'The body of POST /invoices.',
		fields: [
			['id', 'string', 'The invoice number, chosen by the caller.'],
			['customer_id', 'string', 'Who the invoice is for.'],
			['issued_on', 'string', 'The date of issue, as YYYY-MM-DD.'],
			[
				'currency',
				`${CURRENCY_TYPE} | undefined`,
				"The invoice's currency; the customer's, or the default, when left out."
			],
			['lines', 'InvoiceLineRequest[]', 'What was sold, in order.']
		]
	},
	{
		name: 'InvoiceLineResponse',
		doc: 'One line of an invoice, as the API returns it.',
		fields: [
			['description', 'string', 'What was sold.'],
			['quantity', 'string', 'How many, formatted.'],
			['unit_price', 'string', 'The price of one, formatted with its currency.'],
			['net', 'string', 'Quantity times price, formatted with its currency.'],
			['tax_rate', 'string', 'The tax rate, as a percentage.']
		]
	},
	{
		name: 'InvoiceResponse',
		doc: 'An invoice with its totals.',
		fields: [
			['id', 'string', 'The invoice number.'],
			['customer_id', 'string', 'Who the invoice is for.'],
			['issued_on', 'string', 'The date of issue, as YYYY-MM-DD.'],
			['currency', CURRENCY_TYPE, 'The currency every amount is in.'],
			['net', 'string', 'The total before tax, formatted with its currency.'],
			['tax', 'string', 'The tax, formatted with its currency.'],
			['gross', 'string', 'The total with tax, formatted with its currency.'],
			['gross_minor', 'number', 'The total with tax, in minor units, for machines.'],
			['lines', 'InvoiceLineResponse[]', 'What was sold, in order.']
		]
	},
	{
		name: 'ErrorResponse',
		doc: 'Why a request was refused.',
		fields: [
			['error', 'string', 'What went wrong, in a sentence.'],
			['problems', 'string[] | undefined', 'Each problem found, when there were several.']
		]
	},
	{
		name: 'CustomerResponse',
		doc: 'A customer.',
		fields: [
			['id', 'string', 'The customer number.'],
			['name', 'string', 'The name invoices are addressed to.'],
			['email', 'string', 'Where invoices are sent.'],
			[
				'preferred_currency',
				`${CURRENCY_TYPE} | undefined`,
				'The currency new invoices for this customer are written in.'
			]
		]
	},
	{
		name: 'CurrencyResponse',
		doc: 'A currency invoices can be written in.',
		fields: [
			['code', CURRENCY_TYPE, 'Its ISO 4217 code.'],
			['name', 'string', 'Its name in English.'],
			['symbol', 'string', 'The symbol amounts are shown with.'],
			['minor_units', 'number', 'How many digits follow the decimal point.']
		]
	},
	{
		name: 'CurrencyListResponse',
		doc: 'The body of GET /currencies.',
		fields: [
			['currencies', 'CurrencyResponse[]', 'Every currency, by code.'],
			['default', CURRENCY_TYPE, 'The currency used when none is given.']
		]
	}
];

// --- The files before ---------------------------------------------------------

const PACKAGE_BEFORE = text(
	'{',
	'\t"name": "ledger",',
	'\t"version": "1.4.0",',
	'\t"private": true,',
	'\t"type": "module",',
	'\t"scripts": {',
	'\t\t"start": "node src/server/app.ts",',
	'\t\t"test": "vitest run"',
	'\t},',
	'\t"devDependencies": {',
	'\t\t"typescript": "^5.8.3",',
	'\t\t"vitest": "^3.1.4"',
	'\t}',
	'}'
);

const README_BEFORE = text(
	'# Ledger',
	'',
	'Issues invoices for Ledger Ltd and keeps them.',
	'',
	'## Running it',
	'',
	'```',
	'DATABASE_URL=postgres://localhost/ledger pnpm start',
	'```',
	'',
	'`PORT` sets the port (8080 by default) and `COMPANY_NAME` the name printed on',
	'invoices.',
	'',
	'## Money',
	'',
	'Every amount is kept in whole cents. Nothing is ever a float of euros.'
);

const OPENAPI_BEFORE = text(
	'openapi: 3.1.0',
	'info:',
	'  title: Ledger',
	'  version: 1.4.0',
	'paths:',
	'  /invoices:',
	'    post:',
	'      summary: Create or replace an invoice.',
	'      requestBody:',
	'        content:',
	'          application/json:',
	'            schema: { $ref: "#/components/schemas/CreateInvoiceRequest" }',
	'  /invoices/{id}:',
	'    get:',
	'      summary: An invoice with its totals.',
	'  /customers/{id}/invoices:',
	'    get:',
	"      summary: A customer's invoices, newest first.",
	'components:',
	'  schemas:',
	'    InvoiceLineRequest:',
	'      type: object',
	'      required: [description, quantity, unit_price_cents, tax_rate]',
	'      properties:',
	'        description: { type: string }',
	'        quantity: { type: number }',
	'        unit_price_cents: { type: integer }',
	'        tax_rate: { enum: [standard, reduced, zero] }',
	'    CreateInvoiceRequest:',
	'      type: object',
	'      required: [id, customer_id, issued_on, lines]',
	'      properties:',
	'        id: { type: string }',
	'        customer_id: { type: string }',
	'        issued_on: { type: string, format: date }',
	'        lines: { type: array, items: { $ref: "#/components/schemas/InvoiceLineRequest" } }'
);

const MONEY_BEFORE = text(
	'/** An amount of money in whole cents. Never a fraction of a cent. */',
	'export type Cents = number & { readonly __cents: true };',
	'',
	'export function cents(value: number): Cents {',
	'\tif (!Number.isInteger(value)) throw new RangeError(`Not a whole number of cents: ${value}`);',
	'\treturn value as Cents;',
	'}',
	'',
	'export function add(a: Cents, b: Cents): Cents {',
	'\treturn cents(a + b);',
	'}',
	'',
	'export function sum(amounts: readonly Cents[]): Cents {',
	'\treturn amounts.reduce((total, amount) => add(total, amount), cents(0));',
	'}',
	'',
	'export function multiply(amount: Cents, quantity: number): Cents {',
	'\treturn cents(Math.round(amount * quantity));',
	'}',
	'',
	'export function percentOf(amount: Cents, percent: number): Cents {',
	'\treturn cents(Math.round((amount * percent) / 100));',
	'}'
);

const MONEY_TEST_BEFORE = text(
	"import { describe, expect, it } from 'vitest';",
	"import { add, cents, multiply, percentOf, sum } from './money.ts';",
	'',
	"describe('money', () => {",
	"\tit('refuses a fraction of a cent', () => {",
	'\t\texpect(() => cents(1.5)).toThrow(RangeError);',
	'\t});',
	'',
	"\tit('adds and sums', () => {",
	'\t\texpect(add(cents(100), cents(250))).toBe(350);',
	'\t\texpect(sum([cents(1), cents(2), cents(3)])).toBe(6);',
	'\t\texpect(sum([])).toBe(0);',
	'\t});',
	'',
	"\tit('multiplies by a quantity, rounding to the cent', () => {",
	'\t\texpect(multiply(cents(333), 1.5)).toBe(500);',
	'\t});',
	'',
	"\tit('takes a percentage', () => {",
	'\t\texpect(percentOf(cents(1999), 20)).toBe(400);',
	'\t});',
	'});'
);

const TAX_BEFORE = text(
	"import { percentOf, type Cents } from './money.ts';",
	'',
	"export type TaxRate = 'standard' | 'reduced' | 'zero';",
	'',
	'const PERCENT: Record<TaxRate, number> = { standard: 20, reduced: 5, zero: 0 };',
	'',
	'export function taxFor(net: Cents, rate: TaxRate): Cents {',
	'\treturn percentOf(net, PERCENT[rate]);',
	'}',
	'',
	'export function describeRate(rate: TaxRate): string {',
	'\treturn `${PERCENT[rate]}%`;',
	'}'
);

const TAX_TEST_BEFORE = text(
	"import { expect, it } from 'vitest';",
	"import { cents } from './money.ts';",
	"import { describeRate, taxFor } from './tax.ts';",
	'',
	"it('takes the standard rate', () => {",
	"\texpect(taxFor(cents(1000), 'standard')).toBe(200);",
	'});',
	'',
	"it('takes nothing at the zero rate', () => {",
	"\texpect(taxFor(cents(1000), 'zero')).toBe(0);",
	'});',
	'',
	"it('describes a rate', () => {",
	"\texpect(describeRate('reduced')).toBe('5%');",
	'});'
);

const FORMAT_BEFORE = text(
	"import type { Cents } from './money.ts';",
	'',
	'/** 123456 cents as "1,234.56". */',
	'export function formatAmount(amount: Cents): string {',
	'\tconst negative = amount < 0;',
	'\tconst whole = Math.floor(Math.abs(amount) / 100);',
	'\tconst rest = Math.abs(amount) % 100;',
	"\tconst grouped = String(whole).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');",
	"\tconst text = `${grouped}.${String(rest).padStart(2, '0')}`;",
	'\treturn negative ? `-${text}` : text;',
	'}',
	'',
	'/** A date as "15 Jan 2026". */',
	'export function formatDate(iso: string): string {',
	"\tconst [year, month, day] = iso.split('-');",
	"\tconst months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];",
	"\treturn `${Number(day)} ${months[Number(month) - 1] ?? '?'} ${year ?? ''}`;",
	'}',
	'',
	'/** A quantity as a whole number, or with two decimals when it is a fraction (hours). */',
	'export function formatQuantity(quantity: number): string {',
	'\treturn Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2);',
	'}',
	'',
	'/** An invoice number as printed: "INV-1001" stays, "1001" becomes "INV-1001". */',
	'export function formatInvoiceNumber(id: string): string {',
	"\treturn id.startsWith('INV-') ? id : `INV-${id}`;",
	'}',
	'',
	'/** A percentage as printed on a line: 20 as "20%", 5.5 as "5.5%". */',
	'export function formatPercent(percent: number): string {',
	'\treturn `${Number.isInteger(percent) ? String(percent) : percent.toFixed(1)}%`;',
	'}',
	'',
	'/** Text cut to fit a column of the PDF, with an ellipsis when it was cut. */',
	'export function fitColumn(text: string, width: number): string {',
	'\treturn text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;',
	'}'
);

const LOG_BEFORE = text(
	'/** Writes a line to the console with the time it was written. */',
	'export function log(message: string): void {',
	'\tconsole.log(`[${new Date().toISOString()}] ${message}`);',
	'}',
	'',
	'/** Writes a warning to the console with the time it was written. */',
	'export function warn(message: string): void {',
	'\tconsole.warn(`[${new Date().toISOString()}] WARNING ${message}`);',
	'}'
);

const CONFIG_BEFORE = text(
	'export interface Config {',
	'\treadonly port: number;',
	'\treadonly databaseUrl: string;',
	'\treadonly companyName: string;',
	'}',
	'',
	'function required(name: string): string {',
	'\tconst value = process.env[name];',
	"\tif (value === undefined || value === '') throw new Error(`${name} is not set.`);",
	'\treturn value;',
	'}',
	'',
	'export const config: Config = {',
	"\tport: Number(process.env['PORT'] ?? 8080),",
	"\tdatabaseUrl: required('DATABASE_URL'),",
	"\tcompanyName: process.env['COMPANY_NAME'] ?? 'Ledger Ltd'",
	'};'
);

const INVOICE_BEFORE = text(
	"import { log } from './log.ts';",
	"import { cents, multiply, sum, type Cents } from './money.ts';",
	"import { taxFor, type TaxRate } from './tax.ts';",
	'',
	'export interface InvoiceLine {',
	'\treadonly description: string;',
	'\treadonly quantity: number;',
	'\treadonly unitPrice: Cents;',
	'\treadonly taxRate: TaxRate;',
	'}',
	'',
	'export interface Invoice {',
	'\treadonly id: string;',
	'\treadonly customerId: string;',
	'\treadonly issuedOn: string;',
	'\treadonly lines: readonly InvoiceLine[];',
	'}',
	'',
	'export interface Totals {',
	'\treadonly net: Cents;',
	'\treadonly tax: Cents;',
	'\treadonly gross: Cents;',
	'}',
	'',
	'export function lineNet(line: InvoiceLine): Cents {',
	'\treturn multiply(line.unitPrice, line.quantity);',
	'}',
	'',
	'export function totals(invoice: Invoice): Totals {',
	'\tconst nets = invoice.lines.map(lineNet);',
	'\tconst net = sum(nets);',
	'\tconst tax = sum(invoice.lines.map((line, i) => taxFor(nets[i] ?? cents(0), line.taxRate)));',
	'\tconst gross = cents(net + tax);',
	'\tlog(`totals for ${invoice.id}: ${gross}`);',
	'\treturn { net, tax, gross };',
	'}',
	'',
	'export function validate(invoice: Invoice): string[] {',
	'\tconst problems: string[] = [];',
	"\tif (invoice.lines.length === 0) problems.push('An invoice needs at least one line.');",
	'\tfor (const [i, line] of invoice.lines.entries()) {',
	'\t\tif (line.quantity <= 0) problems.push(`Line ${i + 1} has no quantity.`);',
	"\t\tif (line.description.trim() === '') problems.push(`Line ${i + 1} has no description.`);",
	'\t}',
	'\treturn problems;',
	'}'
);

const INVOICE_TEST_BEFORE = text(
	"import { describe, expect, it } from 'vitest';",
	"import { totals, validate, type Invoice } from './invoice.ts';",
	"import { cents } from './money.ts';",
	'',
	'const invoice: Invoice = {',
	"\tid: 'INV-1001',",
	"\tcustomerId: 'C-7',",
	"\tissuedOn: '2026-01-15',",
	'\tlines: [',
	"\t\t{ description: 'Consulting', quantity: 2, unitPrice: cents(15000), taxRate: 'standard' },",
	"\t\t{ description: 'Book', quantity: 1, unitPrice: cents(2000), taxRate: 'reduced' }",
	'\t]',
	'};',
	'',
	"describe('totals', () => {",
	"\tit('adds the lines and their tax', () => {",
	'\t\texpect(totals(invoice)).toEqual({ net: 32000, tax: 6100, gross: 38100 });',
	'\t});',
	'});',
	'',
	"describe('validate', () => {",
	"\tit('accepts a good invoice', () => {",
	'\t\texpect(validate(invoice)).toEqual([]);',
	'\t});',
	'',
	"\tit('wants at least one line', () => {",
	"\t\texpect(validate({ ...invoice, lines: [] })).toEqual(['An invoice needs at least one line.']);",
	'\t});',
	'});'
);

const STORE_INVOICES_BEFORE = text(
	"import type { Invoice, InvoiceLine } from '../invoice.ts';",
	"import { log, warn } from '../log.ts';",
	"import { cents } from '../money.ts';",
	"import type { Database } from './database.ts';",
	'',
	'interface InvoiceRow {',
	'\tid: string;',
	'\tcustomer_id: string;',
	'\tissued_on: string;',
	'}',
	'',
	'interface LineRow {',
	'\tinvoice_id: string;',
	'\tposition: number;',
	'\tdescription: string;',
	'\tquantity: number;',
	'\tunit_price_cents: number;',
	"\ttax_rate: 'standard' | 'reduced' | 'zero';",
	'}',
	'',
	'export class InvoiceStore {',
	'\tconstructor(private readonly db: Database) {}',
	'',
	'\tasync get(id: string): Promise<Invoice | undefined> {',
	'\t\tconst row = await this.db.one<InvoiceRow>(',
	"\t\t\t'SELECT id, customer_id, issued_on FROM invoices WHERE id = $1',",
	'\t\t\t[id]',
	'\t\t);',
	'\t\tif (row === undefined) {',
	'\t\t\twarn(`invoice ${id} not found`);',
	'\t\t\treturn undefined;',
	'\t\t}',
	'\t\treturn this.#withLines(row);',
	'\t}',
	'',
	'\tasync forCustomer(customerId: string): Promise<Invoice[]> {',
	'\t\tconst rows = await this.db.many<InvoiceRow>(',
	"\t\t\t'SELECT id, customer_id, issued_on FROM invoices WHERE customer_id = $1 ORDER BY issued_on DESC',",
	'\t\t\t[customerId]',
	'\t\t);',
	'\t\treturn Promise.all(rows.map((row) => this.#withLines(row)));',
	'\t}',
	'',
	'\tasync save(invoice: Invoice): Promise<void> {',
	'\t\tawait this.db.transaction(async (tx) => {',
	'\t\t\tawait tx.run(',
	"\t\t\t\t'INSERT INTO invoices (id, customer_id, issued_on) VALUES ($1, $2, $3) ' +",
	"\t\t\t\t\t'ON CONFLICT (id) DO UPDATE SET customer_id = $2, issued_on = $3',",
	'\t\t\t\t[invoice.id, invoice.customerId, invoice.issuedOn]',
	'\t\t\t);',
	"\t\t\tawait tx.run('DELETE FROM invoice_lines WHERE invoice_id = $1', [invoice.id]);",
	'\t\t\tfor (const [position, line] of invoice.lines.entries()) {',
	'\t\t\t\tawait tx.run(',
	"\t\t\t\t\t'INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, tax_rate) ' +",
	"\t\t\t\t\t\t'VALUES ($1, $2, $3, $4, $5, $6)',",
	'\t\t\t\t\t[invoice.id, position, line.description, line.quantity, line.unitPrice, line.taxRate]',
	'\t\t\t\t);',
	'\t\t\t}',
	'\t\t});',
	'\t\tlog(`saved invoice ${invoice.id} with ${invoice.lines.length} lines`);',
	'\t}',
	'',
	'\tasync #withLines(row: InvoiceRow): Promise<Invoice> {',
	'\t\tconst lines = await this.db.many<LineRow>(',
	"\t\t\t'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position',",
	'\t\t\t[row.id]',
	'\t\t);',
	'\t\treturn {',
	'\t\t\tid: row.id,',
	'\t\t\tcustomerId: row.customer_id,',
	'\t\t\tissuedOn: row.issued_on,',
	'\t\t\tlines: lines.map(toLine)',
	'\t\t};',
	'\t}',
	'}',
	'',
	'function toLine(row: LineRow): InvoiceLine {',
	'\treturn {',
	'\t\tdescription: row.description,',
	'\t\tquantity: row.quantity,',
	'\t\tunitPrice: cents(row.unit_price_cents),',
	'\t\ttaxRate: row.tax_rate',
	'\t};',
	'}'
);

const STORE_CUSTOMERS_BEFORE = text(
	"import type { Customer } from '../customers.ts';",
	"import type { Database } from './database.ts';",
	'',
	'interface CustomerRow {',
	'\tid: string;',
	'\tname: string;',
	'\temail: string;',
	'}',
	'',
	'export class CustomerStore {',
	'\tconstructor(private readonly db: Database) {}',
	'',
	'\tasync get(id: string): Promise<Customer | undefined> {',
	"\t\tconst row = await this.db.one<CustomerRow>('SELECT id, name, email FROM customers WHERE id = $1', [id]);",
	'\t\treturn row === undefined ? undefined : { id: row.id, name: row.name, email: row.email };',
	'\t}',
	'}'
);

const CUSTOMERS = text(
	'export interface Customer {',
	'\treadonly id: string;',
	'\treadonly name: string;',
	'\treadonly email: string;',
	'}',
	'',
	'export function addressLine(customer: Customer): string {',
	'\treturn `${customer.name} <${customer.email}>`;',
	'}'
);

const DATABASE = text(
	'/** The little the stores need of a database client. */',
	'export interface Database {',
	'\tone<T>(sql: string, params: readonly unknown[]): Promise<T | undefined>;',
	'\tmany<T>(sql: string, params: readonly unknown[]): Promise<T[]>;',
	'\trun(sql: string, params: readonly unknown[]): Promise<void>;',
	'\ttransaction(work: (tx: Database) => Promise<void>): Promise<void>;',
	'}'
);

const ROUTER = text(
	'export interface Request {',
	'\treadonly id: string;',
	'\treadonly params: Readonly<Record<string, string>>;',
	'\treadonly query: Readonly<Record<string, string | undefined>>;',
	'\treadonly body: unknown;',
	'}',
	'',
	'export interface Response {',
	'\tstatus(code: number): Response;',
	'\tjson(body: unknown): Response;',
	'}',
	'',
	'export type Handler = (req: Request, res: Response) => Promise<Response>;',
	'',
	'export interface Router {',
	'\tget(path: string, handler: Handler): void;',
	'\tpost(path: string, handler: Handler): void;',
	'}'
);

const APP_BEFORE = text(
	"import { config } from '../config.ts';",
	"import { log, warn } from '../log.ts';",
	"import { connect } from '../store/connect.ts';",
	"import { InvoiceStore } from '../store/invoices.ts';",
	"import { createRouter, listen } from './http.ts';",
	"import { invoiceRoutes } from './routes.ts';",
	'',
	'export async function start(): Promise<void> {',
	'\tconst db = await connect(config.databaseUrl);',
	'\tconst router = createRouter();',
	'\tinvoiceRoutes(router, new InvoiceStore(db));',
	"\trouter.get('/health', async (_req, res) => res.json({ ok: true }));",
	'\tconst server = await listen(router, config.port);',
	'\tlog(`listening on port ${config.port}`);',
	"\tprocess.on('SIGTERM', () => {",
	"\t\twarn('stopping on SIGTERM');",
	'\t\tserver.close();',
	'\t});',
	'}',
	'',
	'await start();'
);

const ROUTES_BEFORE = text(
	"import type { CreateInvoiceRequest, InvoiceResponse } from '../generated/api-types.ts';",
	"import { formatAmount, formatQuantity } from '../format.ts';",
	"import { lineNet, totals, validate, type Invoice } from '../invoice.ts';",
	"import { log, warn } from '../log.ts';",
	"import { cents } from '../money.ts';",
	"import type { InvoiceStore } from '../store/invoices.ts';",
	"import { describeRate } from '../tax.ts';",
	"import type { Router } from './router.ts';",
	'',
	'export function invoiceRoutes(router: Router, store: InvoiceStore): void {',
	"\trouter.get('/invoices/:id', async (req, res) => {",
	"\t\tconst id = req.params['id'] ?? '';",
	'\t\tlog(`GET /invoices/${id}`);',
	'\t\tconst invoice = await store.get(id);',
	"\t\tif (invoice === undefined) return res.status(404).json({ error: 'There is no such invoice.' });",
	'\t\treturn res.json(present(invoice));',
	'\t});',
	'',
	"\trouter.post('/invoices', async (req, res) => {",
	'\t\tconst body = req.body as CreateInvoiceRequest;',
	'\t\tconst invoice: Invoice = {',
	'\t\t\tid: body.id,',
	'\t\t\tcustomerId: body.customer_id,',
	'\t\t\tissuedOn: body.issued_on,',
	'\t\t\tlines: body.lines.map((line) => ({',
	'\t\t\t\tdescription: line.description,',
	'\t\t\t\tquantity: line.quantity,',
	'\t\t\t\tunitPrice: cents(line.unit_price_cents),',
	'\t\t\t\ttaxRate: line.tax_rate',
	'\t\t\t}))',
	'\t\t};',
	'\t\tconst problems = validate(invoice);',
	'\t\tif (problems.length > 0) {',
	"\t\t\twarn(`refused invoice ${body.id}: ${problems.join('; ')}`);",
	"\t\t\treturn res.status(422).json({ error: 'The invoice is not valid.', problems });",
	'\t\t}',
	'\t\tawait store.save(invoice);',
	'\t\tlog(`created invoice ${invoice.id}`);',
	'\t\treturn res.status(201).json(present(invoice));',
	'\t});',
	'',
	"\trouter.get('/customers/:id/invoices', async (req, res) => {",
	"\t\tconst id = req.params['id'] ?? '';",
	'\t\tlog(`GET /customers/${id}/invoices`);',
	'\t\tconst invoices = await store.forCustomer(id);',
	'\t\treturn res.json(invoices.map(present));',
	'\t});',
	'}',
	'',
	'function present(invoice: Invoice): InvoiceResponse {',
	'\tconst sums = totals(invoice);',
	'\treturn {',
	'\t\tid: invoice.id,',
	'\t\tcustomer_id: invoice.customerId,',
	'\t\tissued_on: invoice.issuedOn,',
	'\t\tnet: formatAmount(sums.net),',
	'\t\ttax: formatAmount(sums.tax),',
	'\t\tgross: formatAmount(sums.gross),',
	'\t\tlines: invoice.lines.map((line) => ({',
	'\t\t\tdescription: line.description,',
	'\t\t\tquantity: formatQuantity(line.quantity),',
	'\t\t\tunit_price: formatAmount(line.unitPrice),',
	'\t\t\tnet: formatAmount(lineNet(line)),',
	'\t\t\ttax_rate: describeRate(line.taxRate)',
	'\t\t}))',
	'\t};',
	'}'
);

const ROUTES_TEST_BEFORE = text(
	"import { describe, expect, it } from 'vitest';",
	"import { fakeStore, request } from '../test-helpers.ts';",
	"import { invoiceRoutes } from './routes.ts';",
	'',
	'const body = {',
	"\tid: 'INV-1001',",
	"\tcustomer_id: 'C-7',",
	"\tissued_on: '2026-01-15',",
	"\tlines: [{ description: 'Consulting', quantity: 2, unit_price_cents: 15000, tax_rate: 'standard' }]",
	'};',
	'',
	"describe('POST /invoices', () => {",
	"\tit('creates an invoice and answers with its totals', async () => {",
	"\t\tconst res = await request(invoiceRoutes, fakeStore(), 'POST', '/invoices', body);",
	'\t\texpect(res.status).toBe(201);',
	"\t\texpect(res.body).toMatchObject({ net: '300.00', tax: '60.00', gross: '360.00' });",
	'\t});',
	'',
	"\tit('refuses an invoice with no lines', async () => {",
	"\t\tconst res = await request(invoiceRoutes, fakeStore(), 'POST', '/invoices', { ...body, lines: [] });",
	'\t\texpect(res.status).toBe(422);',
	'\t});',
	'});',
	'',
	"describe('GET /invoices/:id', () => {",
	"\tit('answers 404 for an invoice that does not exist', async () => {",
	"\t\tconst res = await request(invoiceRoutes, fakeStore(), 'GET', '/invoices/nope');",
	'\t\texpect(res.status).toBe(404);',
	'\t});',
	'});'
);

const RENDER_BEFORE = text(
	"import { config } from '../config.ts';",
	"import type { Customer } from '../customers.ts';",
	"import { formatAmount, formatDate, formatQuantity } from '../format.ts';",
	"import { lineNet, totals, type Invoice } from '../invoice.ts';",
	"import { describeRate } from '../tax.ts';",
	'',
	'/** The invoice as the lines of text the PDF writer lays out, top to bottom. */',
	'export function renderInvoice(invoice: Invoice, customer: Customer): string[] {',
	'\tconst sums = totals(invoice);',
	'\treturn [',
	'\t\tconfig.companyName,',
	'\t\t`Invoice ${invoice.id}`,',
	'\t\t`Issued ${formatDate(invoice.issuedOn)}`,',
	'\t\t`To ${customer.name}`,',
	"\t\t'',",
	'\t\t...invoice.lines.map(',
	'\t\t\t(line) =>',
	'\t\t\t\t`${line.description}  ${formatQuantity(line.quantity)} x ${formatAmount(line.unitPrice)}  ${describeRate(line.taxRate)}  ${formatAmount(lineNet(line))}`',
	'\t\t),',
	"\t\t'',",
	'\t\t`Net    ${formatAmount(sums.net)}`,',
	'\t\t`Tax    ${formatAmount(sums.tax)}`,',
	'\t\t`Total  ${formatAmount(sums.gross)}`',
	'\t];',
	'}'
);

const PDF_TEST_BEFORE = text(
	"import { expect, it } from 'vitest';",
	"import { cents } from '../src/money.ts';",
	"import { renderInvoice } from '../src/pdf/render.ts';",
	'',
	"const customer = { id: 'C-7', name: 'Ada Lovelace Ltd', email: 'accounts@example.com' };",
	'',
	"it('lays out an invoice', () => {",
	'\tconst lines = renderInvoice(',
	'\t\t{',
	"\t\t\tid: 'INV-1001',",
	"\t\t\tcustomerId: 'C-7',",
	"\t\t\tissuedOn: '2026-01-15',",
	'\t\t\tlines: [',
	"\t\t\t\t{ description: 'Consulting', quantity: 2, unitPrice: cents(15000), taxRate: 'standard' },",
	"\t\t\t\t{ description: 'Travel', quantity: 1, unitPrice: cents(4250), taxRate: 'zero' },",
	"\t\t\t\t{ description: 'Book', quantity: 1, unitPrice: cents(2000), taxRate: 'reduced' }",
	'\t\t\t]',
	'\t\t},',
	'\t\tcustomer',
	'\t);',
	'\texpect(lines).toMatchSnapshot();',
	'});'
);

/** What vitest writes for `lines`, one exported snapshot per test. */
function snapshotFile(tests: readonly (readonly [string, readonly string[]])[]): string {
	const out = ['// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html', ''];
	for (const [name, lines] of tests) {
		out.push(`exports[\`${name} 1\`] = \``, '[');
		for (const line of lines) out.push(`  "${line}",`);
		out.push(']', '`;', '');
	}
	return text(...out.slice(0, -1));
}

const SNAPSHOT_BEFORE = snapshotFile([
	[
		'lays out an invoice',
		[
			'Ledger Ltd',
			'Invoice INV-1001',
			'Issued 15 Jan 2026',
			'To Ada Lovelace Ltd',
			'',
			'Consulting  2 x 150.00  20%  300.00',
			'Travel  1 x 42.50  0%  42.50',
			'Book  1 x 20.00  5%  20.00',
			'',
			'Net    362.50',
			'Tax    61.00',
			'Total  423.50'
		]
	]
]);

const RELEASE_BEFORE = text(
	'#!/bin/sh',
	'# Tags a release and pushes it; CI builds and deploys the tag.',
	'version=$(node -p "require(\'./package.json\').version")',
	'git tag "v$version"',
	'git push origin "v$version"'
);

const GITATTRIBUTES = text('src/generated/** linguist-generated=true', '*.png binary');

const TSCONFIG = text(
	'{',
	'\t"compilerOptions": {',
	'\t\t"target": "es2024",',
	'\t\t"module": "nodenext",',
	'\t\t"strict": true,',
	'\t\t"noUncheckedIndexedAccess": true,',
	'\t\t"allowImportingTsExtensions": true,',
	'\t\t"noEmit": true',
	'\t}',
	'}'
);

const MIGRATIONS = [
	[
		'src/store/migrations/001-invoices.sql',
		text(
			'CREATE TABLE invoices (',
			'  id TEXT PRIMARY KEY,',
			'  customer_id TEXT NOT NULL,',
			'  issued_on DATE NOT NULL',
			');'
		)
	],
	[
		'src/store/migrations/002-invoice-lines.sql',
		text(
			'CREATE TABLE invoice_lines (',
			'  invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,',
			'  position INTEGER NOT NULL,',
			'  description TEXT NOT NULL,',
			'  quantity NUMERIC NOT NULL,',
			'  unit_price_cents BIGINT NOT NULL,',
			'  tax_rate TEXT NOT NULL,',
			'  PRIMARY KEY (invoice_id, position)',
			');'
		)
	],
	[
		'src/store/migrations/003-customers.sql',
		text(
			'CREATE TABLE customers (',
			'  id TEXT PRIMARY KEY,',
			'  name TEXT NOT NULL,',
			'  email TEXT NOT NULL',
			');'
		)
	]
] as const;

const TEST_HELPERS = text(
	"import type { Invoice } from './invoice.ts';",
	"import type { InvoiceStore } from './store/invoices.ts';",
	"import type { Router } from './server/router.ts';",
	'',
	'/** An invoice store that keeps invoices in memory. */',
	'export function fakeStore(): InvoiceStore {',
	'\tconst invoices = new Map<string, Invoice>();',
	'\treturn {',
	'\t\tget: async (id: string) => invoices.get(id),',
	'\t\tforCustomer: async (id: string) => [...invoices.values()].filter((i) => i.customerId === id),',
	'\t\tsave: async (invoice: Invoice) => {',
	'\t\t\tinvoices.set(invoice.id, invoice);',
	'\t\t}',
	'\t} as unknown as InvoiceStore;',
	'}',
	'',
	'/** Sends one request through the routes `install` sets up, and gives the answer. */',
	'export async function request(',
	'\tinstall: (router: Router, store: InvoiceStore) => void,',
	'\tstore: InvoiceStore,',
	"\tmethod: 'GET' | 'POST',",
	'\tpath: string,',
	'\tbody?: unknown',
	'): Promise<{ status: number; body: unknown }> {',
	'\tconst routes: { method: string; pattern: string; handler: Parameters<Router["get"]>[1] }[] = [];',
	'\tinstall(',
	'\t\t{',
	"\t\t\tget: (pattern, handler) => routes.push({ method: 'GET', pattern, handler }),",
	"\t\t\tpost: (pattern, handler) => routes.push({ method: 'POST', pattern, handler })",
	'\t\t},',
	'\t\tstore',
	'\t);',
	'\tfor (const route of routes) {',
	"\t\tconst names = route.pattern.split('/');",
	"\t\tconst parts = path.split('/');",
	'\t\tif (route.method !== method || names.length !== parts.length) continue;',
	'\t\tconst params: Record<string, string> = {};',
	"\t\tif (!names.every((n, i) => (n.startsWith(':') ? ((params[n.slice(1)] = parts[i] ?? ''), true) : n === parts[i]))) continue;",
	'\t\tconst answer = { status: 200, body: undefined as unknown };',
	'\t\tconst res = {',
	'\t\t\tstatus(code: number) {',
	'\t\t\t\tanswer.status = code;',
	'\t\t\t\treturn res;',
	'\t\t\t},',
	'\t\t\tjson(value: unknown) {',
	'\t\t\t\tanswer.body = value;',
	'\t\t\t\treturn res;',
	'\t\t\t}',
	'\t\t};',
	"\t\tawait route.handler({ id: 'test', params, query: {}, body }, res);",
	'\t\treturn answer;',
	'\t}',
	'\treturn { status: 404, body: undefined };',
	'}'
);

// --- The files after ----------------------------------------------------------

const PACKAGE_AFTER = text(
	'{',
	'\t"name": "ledger",',
	'\t"version": "1.4.0",',
	'\t"private": true,',
	'\t"type": "module",',
	'\t"scripts": {',
	'\t\t"start": "node src/server/app.ts",',
	'\t\t"test": "vitest run",',
	'\t\t"openapi:generate": "openapi-typescript api/openapi.yaml -o src/generated/api-types.ts"',
	'\t},',
	'\t"devDependencies": {',
	'\t\t"typescript": "^5.8.3",',
	'\t\t"vitest": "^3.2.1"',
	'\t}',
	'}'
);

const README_AFTER = text(
	'# Ledger',
	'',
	'Issues invoices for Ledger Ltd and keeps them.',
	'',
	'## Running it',
	'',
	'```',
	'DATABASE_URL=postgres://localhost/ledger pnpm start',
	'```',
	'',
	'`PORT` sets the port (8080 by default), `COMPANY_NAME` the name printed on',
	'invoices, `DEFAULT_CURRENCY` the currency of an invoice that names none (EUR by',
	'default) and `LOG_LEVEL` how much is logged (`info` by default).',
	'',
	'## Money',
	'',
	'Every amount is kept in whole minor units of its currency (cents, pence, yen),',
	'with the currency beside it. Nothing is ever a float, and amounts in different',
	'currencies are never added. See [docs/currencies.md](docs/currencies.md).',
	'',
	'## Logs',
	'',
	'Logs are JSON lines on standard error, one object per line, with `time`,',
	'`level` and `message` and the fields of what was logged.'
);

const OPENAPI_AFTER = text(
	'openapi: 3.1.0',
	'info:',
	'  title: Ledger',
	'  version: 1.5.0',
	'paths:',
	'  /invoices:',
	'    post:',
	'      summary: Create or replace an invoice.',
	'      requestBody:',
	'        content:',
	'          application/json:',
	'            schema: { $ref: "#/components/schemas/CreateInvoiceRequest" }',
	'  /invoices/{id}:',
	'    get:',
	'      summary: An invoice with its totals.',
	'  /customers/{id}/invoices:',
	'    get:',
	"      summary: A customer's invoices, newest first.",
	'  /currencies:',
	'    get:',
	'      summary: The currencies invoices can be written in.',
	'components:',
	'  schemas:',
	'    Currency:',
	'      enum: [EUR, GBP, USD, JPY, CHF, SEK, KWD]',
	'    InvoiceLineRequest:',
	'      type: object',
	'      required: [description, quantity, unit_price_minor, tax_rate]',
	'      properties:',
	'        description: { type: string }',
	'        quantity: { type: number }',
	'        unit_price_minor: { type: integer }',
	'        tax_rate: { enum: [standard, reduced, zero] }',
	'    CreateInvoiceRequest:',
	'      type: object',
	'      required: [id, customer_id, issued_on, lines]',
	'      properties:',
	'        id: { type: string }',
	'        customer_id: { type: string }',
	'        issued_on: { type: string, format: date }',
	'        currency: { $ref: "#/components/schemas/Currency" }',
	'        lines: { type: array, items: { $ref: "#/components/schemas/InvoiceLineRequest" } }'
);

const CURRENCY = text(
	'/**',
	' * The currencies invoices can be written in, by ISO 4217 code: how many digits',
	' * follow the decimal point, the symbol amounts are shown with, and the name.',
	' */',
	'export const CURRENCIES = {',
	"\tEUR: { minorUnits: 2, symbol: '€', name: 'Euro' },",
	"\tGBP: { minorUnits: 2, symbol: '£', name: 'Pound sterling' },",
	"\tUSD: { minorUnits: 2, symbol: '$', name: 'US dollar' },",
	"\tJPY: { minorUnits: 0, symbol: '¥', name: 'Japanese yen' },",
	"\tCHF: { minorUnits: 2, symbol: 'CHF ', name: 'Swiss franc' },",
	"\tSEK: { minorUnits: 2, symbol: 'kr ', name: 'Swedish krona' },",
	"\tKWD: { minorUnits: 3, symbol: 'KD ', name: 'Kuwaiti dinar' }",
	'} as const;',
	'',
	'export type CurrencyCode = keyof typeof CURRENCIES;',
	'',
	'export function isCurrencyCode(text: string): text is CurrencyCode {',
	'\treturn Object.hasOwn(CURRENCIES, text);',
	'}',
	'',
	'/** A currency code as a person or a client wrote it: " eur" is EUR. */',
	'export function parseCurrency(text: string): CurrencyCode {',
	'\tconst code = text.trim().toUpperCase();',
	'\tif (!isCurrencyCode(code)) {',
	'\t\tthrow new RangeError(',
	'\t\t\t`Unknown currency "${text}". Use one of ${Object.keys(CURRENCIES).join(\', \')}.`',
	'\t\t);',
	'\t}',
	'\treturn code;',
	'}',
	'',
	'export function minorUnits(code: CurrencyCode): number {',
	'\treturn CURRENCIES[code].minorUnits;',
	'}',
	'',
	'export function symbol(code: CurrencyCode): string {',
	'\treturn CURRENCIES[code].symbol;',
	'}',
	'',
	'/**',
	' * Rounds an exact amount of minor units, such as a tax, the way the currency',
	' * requires: half away from zero, except Swiss francs, which are rounded to the',
	' * nearest five rappen.',
	' */',
	'export function roundForTax(exact: number, code: CurrencyCode): number {',
	"\tif (code === 'CHF') return Math.round(exact / 5) * 5;",
	'\treturn Math.sign(exact) * Math.round(Math.abs(exact));',
	'}'
);

const CURRENCY_TEST = text(
	"import { describe, expect, it } from 'vitest';",
	"import { minorUnits, parseCurrency, roundForTax, symbol } from './currency.ts';",
	'',
	"describe('parseCurrency', () => {",
	"\tit('reads a code in any case, with space around it', () => {",
	"\t\texpect(parseCurrency(' eur ')).toBe('EUR');",
	"\t\texpect(parseCurrency('jpy')).toBe('JPY');",
	'\t});',
	'',
	"\tit('refuses a code it does not know, naming the ones it does', () => {",
	"\t\texpect(() => parseCurrency('XYZ')).toThrow(/Use one of EUR, GBP, USD, JPY, CHF, SEK, KWD/);",
	'\t});',
	'});',
	'',
	"describe('minor units', () => {",
	"\tit('knows currencies with none and with three', () => {",
	"\t\texpect(minorUnits('JPY')).toBe(0);",
	"\t\texpect(minorUnits('KWD')).toBe(3);",
	"\t\texpect(symbol('GBP')).toBe('£');",
	'\t});',
	'});',
	'',
	"describe('roundForTax', () => {",
	"\tit('rounds half away from zero', () => {",
	"\t\texpect(roundForTax(2.5, 'EUR')).toBe(3);",
	"\t\texpect(roundForTax(-2.5, 'EUR')).toBe(-3);",
	'\t});',
	'',
	"\tit('rounds Swiss francs to five rappen', () => {",
	"\t\texpect(roundForTax(1237, 'CHF')).toBe(1235);",
	"\t\texpect(roundForTax(1238, 'CHF')).toBe(1240);",
	'\t});',
	'});'
);

const MONEY_AFTER = text(
	"import { minorUnits, type CurrencyCode } from './currency.ts';",
	'',
	'/**',
	' * An amount of money in the minor unit of its currency (cents, pence, yen),',
	' * never a fraction of one, with the currency it is in.',
	' */',
	'export interface Money {',
	'\treadonly minor: number;',
	'\treadonly currency: CurrencyCode;',
	'}',
	'',
	'/** Amounts in two currencies were combined: a bug in the caller, never rounded away. */',
	'export class CurrencyMismatch extends Error {',
	'\tconstructor(',
	'\t\treadonly left: CurrencyCode,',
	'\t\treadonly right: CurrencyCode',
	'\t) {',
	'\t\tsuper(`Cannot combine ${left} with ${right}.`);',
	'\t}',
	'}',
	'',
	'export function money(minor: number, currency: CurrencyCode): Money {',
	'\tif (!Number.isInteger(minor)) {',
	'\t\tthrow new RangeError(`Not a whole number of ${currency} minor units: ${minor}`);',
	'\t}',
	'\treturn { minor, currency };',
	'}',
	'',
	'export function zero(currency: CurrencyCode): Money {',
	'\treturn money(0, currency);',
	'}',
	'',
	'export function add(a: Money, b: Money): Money {',
	'\tif (a.currency !== b.currency) throw new CurrencyMismatch(a.currency, b.currency);',
	'\treturn money(a.minor + b.minor, a.currency);',
	'}',
	'',
	'/** The sum of amounts in one currency; zero of that currency for none. */',
	'export function sum(amounts: readonly Money[], currency: CurrencyCode): Money {',
	'\treturn amounts.reduce((total, amount) => add(total, amount), zero(currency));',
	'}',
	'',
	'export function multiply(amount: Money, quantity: number): Money {',
	'\treturn money(Math.round(amount.minor * quantity), amount.currency);',
	'}',
	'',
	'export function percentOf(amount: Money, percent: number): Money {',
	'\treturn money(Math.round((amount.minor * percent) / 100), amount.currency);',
	'}',
	'',
	'/** The amount in major units, as a number: 1050 cents is 10.5. For display only. */',
	'export function inMajorUnits(amount: Money): number {',
	'\treturn amount.minor / 10 ** minorUnits(amount.currency);',
	'}'
);

const MONEY_TEST_AFTER = text(
	"import { describe, expect, it } from 'vitest';",
	"import { add, CurrencyMismatch, inMajorUnits, money, multiply, percentOf, sum } from './money.ts';",
	'',
	"const eur = (minor: number) => money(minor, 'EUR');",
	'',
	"describe('money', () => {",
	"\tit('refuses a fraction of a minor unit', () => {",
	"\t\texpect(() => money(1.5, 'EUR')).toThrow(RangeError);",
	'\t});',
	'',
	"\tit('adds and sums in one currency', () => {",
	'\t\texpect(add(eur(100), eur(250))).toEqual(eur(350));',
	"\t\texpect(sum([eur(1), eur(2), eur(3)], 'EUR')).toEqual(eur(6));",
	"\t\texpect(sum([], 'JPY')).toEqual(money(0, 'JPY'));",
	'\t});',
	'',
	"\tit('never adds two currencies', () => {",
	"\t\texpect(() => add(eur(100), money(100, 'GBP'))).toThrow(CurrencyMismatch);",
	'\t});',
	'',
	"\tit('multiplies by a quantity, rounding to the minor unit', () => {",
	'\t\texpect(multiply(eur(333), 1.5)).toEqual(eur(500));',
	'\t});',
	'',
	"\tit('takes a percentage', () => {",
	'\t\texpect(percentOf(eur(1999), 20)).toEqual(eur(400));',
	'\t});',
	'',
	"\tit('gives major units for display', () => {",
	'\t\texpect(inMajorUnits(eur(1050))).toBe(10.5);',
	"\t\texpect(inMajorUnits(money(1050, 'JPY'))).toBe(1050);",
	"\t\texpect(inMajorUnits(money(1050, 'KWD'))).toBe(1.05);",
	'\t});',
	'});'
);

const TAX_AFTER = text(
	"import { roundForTax } from './currency.ts';",
	"import { money, type Money } from './money.ts';",
	'',
	"export type TaxRate = 'standard' | 'reduced' | 'zero';",
	'',
	'const PERCENT: Record<TaxRate, number> = { standard: 20, reduced: 5, zero: 0 };',
	'',
	"/** The tax on a net amount, rounded as the amount's currency requires. */",
	'export function taxFor(net: Money, rate: TaxRate): Money {',
	'\tconst exact = (net.minor * PERCENT[rate]) / 100;',
	'\treturn money(roundForTax(exact, net.currency), net.currency);',
	'}',
	'',
	'export function describeRate(rate: TaxRate): string {',
	'\treturn `${PERCENT[rate]}%`;',
	'}'
);

const TAX_TEST_AFTER = text(
	"import { expect, it } from 'vitest';",
	"import { money } from './money.ts';",
	"import { describeRate, taxFor } from './tax.ts';",
	'',
	"it('takes the standard rate', () => {",
	"\texpect(taxFor(money(1000, 'EUR'), 'standard')).toEqual(money(200, 'EUR'));",
	'});',
	'',
	"it('takes nothing at the zero rate', () => {",
	"\texpect(taxFor(money(1000, 'EUR'), 'zero')).toEqual(money(0, 'EUR'));",
	'});',
	'',
	"it('rounds Swiss tax to five rappen', () => {",
	"\texpect(taxFor(money(1234, 'CHF'), 'reduced')).toEqual(money(60, 'CHF'));",
	'});',
	'',
	"it('describes a rate', () => {",
	"\texpect(describeRate('reduced')).toBe('5%');",
	'});'
);

const FORMAT_AFTER = text(
	"import { minorUnits, symbol } from '../currency.ts';",
	"import type { Money } from '../money.ts';",
	'',
	'/** 123456 cents of EUR as "€1,234.56"; 1234 JPY as "¥1,234". */',
	'export function formatAmount(amount: Money): string {',
	'\tconst negative = amount.minor < 0;',
	'\tconst digits = minorUnits(amount.currency);',
	'\tconst scale = 10 ** digits;',
	'\tconst whole = Math.floor(Math.abs(amount.minor) / scale);',
	'\tconst rest = Math.abs(amount.minor) % scale;',
	"\tconst grouped = String(whole).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');",
	"\tconst text = digits === 0 ? grouped : `${grouped}.${String(rest).padStart(digits, '0')}`;",
	'\tconst shown = `${symbol(amount.currency)}${text}`;',
	'\treturn negative ? `-${shown}` : shown;',
	'}',
	'',
	'/** A date as "15 Jan 2026". */',
	'export function formatDate(iso: string): string {',
	"\tconst [year, month, day] = iso.split('-');",
	"\tconst months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];",
	"\treturn `${Number(day)} ${months[Number(month) - 1] ?? '?'} ${year ?? ''}`;",
	'}',
	'',
	'/** A quantity as a whole number, or with two decimals when it is a fraction (hours). */',
	'export function formatQuantity(quantity: number): string {',
	'\treturn Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2);',
	'}',
	'',
	'/** An invoice number as printed: "INV-1001" stays, "1001" becomes "INV-1001". */',
	'export function formatInvoiceNumber(id: string): string {',
	"\treturn id.startsWith('INV-') ? id : `INV-${id}`;",
	'}',
	'',
	'/** A percentage as printed on a line: 20 as "20%", 5.5 as "5.5%". */',
	'export function formatPercent(percent: number): string {',
	'\treturn `${Number.isInteger(percent) ? String(percent) : percent.toFixed(1)}%`;',
	'}',
	'',
	'/** Text cut to fit a column of the PDF, with an ellipsis when it was cut. */',
	'export function fitColumn(text: string, width: number): string {',
	'\treturn text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;',
	'}'
);

const LOG_AFTER = text(
	"import { config } from './config.ts';",
	'',
	'/**',
	' * Structured logging: one JSON object per line on standard error, so the',
	" * platform's log collector can index the fields. Nothing below the configured",
	' * level is written.',
	' */',
	"export type Level = 'debug' | 'info' | 'warn' | 'error';",
	'',
	'const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };',
	'',
	'export type Fields = Readonly<Record<string, string | number | boolean | undefined>>;',
	'',
	'export interface Logger {',
	'\tdebug(message: string, fields?: Fields): void;',
	'\tinfo(message: string, fields?: Fields): void;',
	'\twarn(message: string, fields?: Fields): void;',
	'\terror(message: string, fields?: Fields): void;',
	'\t/** A logger that adds these fields to every line, such as the request id. */',
	'\twith(fields: Fields): Logger;',
	'}',
	'',
	"/** Where lines go: standard error, or a test's array. */",
	'export interface Sink {',
	'\twrite(line: string): void;',
	'}',
	'',
	'const standardError: Sink = { write: (line) => process.stderr.write(`${line}\\n`) };',
	'',
	'export interface LoggerOptions {',
	'\treadonly level: Level;',
	'\treadonly sink?: Sink;',
	'\treadonly now?: () => Date;',
	'\treadonly fields?: Fields;',
	'}',
	'',
	'export function isLevel(text: string): text is Level {',
	'\treturn Object.hasOwn(ORDER, text);',
	'}',
	'',
	'export function createLogger(options: LoggerOptions): Logger {',
	'\tconst sink = options.sink ?? standardError;',
	'\tconst now = options.now ?? (() => new Date());',
	'\tconst base = options.fields ?? {};',
	'\tconst emit = (level: Level, message: string, fields: Fields = {}): void => {',
	'\t\tif (ORDER[level] < ORDER[options.level]) return;',
	'\t\tsink.write(JSON.stringify({ time: now().toISOString(), level, message, ...base, ...fields }));',
	'\t};',
	'\treturn {',
	"\t\tdebug: (message, fields) => emit('debug', message, fields),",
	"\t\tinfo: (message, fields) => emit('info', message, fields),",
	"\t\twarn: (message, fields) => emit('warn', message, fields),",
	"\t\terror: (message, fields) => emit('error', message, fields),",
	'\t\twith: (fields) => createLogger({ ...options, fields: { ...base, ...fields } })',
	'\t};',
	'}',
	'',
	"/** The process's logger, at the level the configuration gives. */",
	'export const log: Logger = createLogger({ level: config.logLevel });'
);

const LOG_TEST = text(
	"import { describe, expect, it } from 'vitest';",
	"import { createLogger } from './log.ts';",
	'',
	"const at = () => new Date('2026-01-15T09:30:00Z');",
	'',
	"describe('createLogger', () => {",
	"\tit('writes one JSON object per line, with its fields', () => {",
	'\t\tconst lines: string[] = [];',
	"\t\tconst log = createLogger({ level: 'info', sink: { write: (l) => lines.push(l) }, now: at });",
	"\t\tlog.info('saved invoice', { invoice: 'INV-1001', lines: 2 });",
	'\t\texpect(lines.map((l) => JSON.parse(l))).toEqual([',
	"\t\t\t{ time: '2026-01-15T09:30:00.000Z', level: 'info', message: 'saved invoice', invoice: 'INV-1001', lines: 2 }",
	'\t\t]);',
	'\t});',
	'',
	"\tit('writes nothing below its level', () => {",
	'\t\tconst lines: string[] = [];',
	"\t\tconst log = createLogger({ level: 'warn', sink: { write: (l) => lines.push(l) }, now: at });",
	"\t\tlog.debug('noise');",
	"\t\tlog.info('noise');",
	"\t\tlog.warn('kept');",
	'\t\texpect(lines).toHaveLength(1);',
	'\t});',
	'',
	"\tit('adds the fields of `with` to every line', () => {",
	'\t\tconst lines: string[] = [];',
	"\t\tconst log = createLogger({ level: 'debug', sink: { write: (l) => lines.push(l) }, now: at });",
	"\t\tlog.with({ request: 'r-1' }).debug('hello');",
	"\t\texpect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ request: 'r-1', message: 'hello' });",
	'\t});',
	'});'
);

const CONFIG_AFTER = text(
	"import { parseCurrency, type CurrencyCode } from './currency.ts';",
	"import { isLevel, type Level } from './log.ts';",
	'',
	'export interface Config {',
	'\treadonly port: number;',
	'\treadonly databaseUrl: string;',
	'\treadonly companyName: string;',
	'\t/** The currency of an invoice that names none and whose customer has none. */',
	'\treadonly defaultCurrency: CurrencyCode;',
	'\treadonly logLevel: Level;',
	'}',
	'',
	'function required(name: string): string {',
	'\tconst value = process.env[name];',
	"\tif (value === undefined || value === '') throw new Error(`${name} is not set.`);",
	'\treturn value;',
	'}',
	'',
	'function logLevel(): Level {',
	"\tconst value = process.env['LOG_LEVEL'] ?? 'info';",
	'\tif (!isLevel(value)) throw new Error(`LOG_LEVEL must be debug, info, warn or error, not ${value}.`);',
	'\treturn value;',
	'}',
	'',
	'export const config: Config = {',
	"\tport: Number(process.env['PORT'] ?? 8080),",
	"\tdatabaseUrl: required('DATABASE_URL'),",
	"\tcompanyName: process.env['COMPANY_NAME'] ?? 'Ledger Ltd',",
	"\tdefaultCurrency: parseCurrency(process.env['DEFAULT_CURRENCY'] ?? 'EUR'),",
	'\tlogLevel: logLevel()',
	'};'
);

const INVOICE_AFTER = text(
	"import type { CurrencyCode } from './currency.ts';",
	"import { log } from './log.ts';",
	"import { add, multiply, sum, zero, type Money } from './money.ts';",
	"import { taxFor, type TaxRate } from './tax.ts';",
	'',
	'export interface InvoiceLine {',
	'\treadonly description: string;',
	'\treadonly quantity: number;',
	'\treadonly unitPrice: Money;',
	'\treadonly taxRate: TaxRate;',
	'}',
	'',
	'export interface Invoice {',
	'\treadonly id: string;',
	'\treadonly customerId: string;',
	'\treadonly issuedOn: string;',
	'\t/** Every amount on the invoice is in this currency. */',
	'\treadonly currency: CurrencyCode;',
	'\treadonly lines: readonly InvoiceLine[];',
	'}',
	'',
	'export interface Totals {',
	'\treadonly net: Money;',
	'\treadonly tax: Money;',
	'\treadonly gross: Money;',
	'}',
	'',
	'export function lineNet(line: InvoiceLine): Money {',
	'\treturn multiply(line.unitPrice, line.quantity);',
	'}',
	'',
	'export function totals(invoice: Invoice): Totals {',
	'\tconst nets = invoice.lines.map(lineNet);',
	'\tconst net = sum(nets, invoice.currency);',
	'\tconst tax = sum(',
	'\t\tinvoice.lines.map((line, i) => taxFor(nets[i] ?? zero(invoice.currency), line.taxRate)),',
	'\t\tinvoice.currency',
	'\t);',
	'\tconst gross = add(net, tax);',
	"\tlog.debug('totals', { invoice: invoice.id, gross: gross.minor, currency: gross.currency });",
	'\treturn { net, tax, gross };',
	'}',
	'',
	'export function validate(invoice: Invoice): string[] {',
	'\tconst problems: string[] = [];',
	"\tif (invoice.lines.length === 0) problems.push('An invoice needs at least one line.');",
	'\tfor (const [i, line] of invoice.lines.entries()) {',
	'\t\tif (line.quantity <= 0) problems.push(`Line ${i + 1} has no quantity.`);',
	"\t\tif (line.description.trim() === '') problems.push(`Line ${i + 1} has no description.`);",
	'\t\tif (line.unitPrice.currency !== invoice.currency) {',
	'\t\t\tproblems.push(`Line ${i + 1} is in ${line.unitPrice.currency}, not ${invoice.currency}.`);',
	'\t\t}',
	'\t}',
	'\treturn problems;',
	'}'
);

const INVOICE_TEST_AFTER = text(
	"import { describe, expect, it } from 'vitest';",
	"import { totals, validate, type Invoice } from './invoice.ts';",
	"import { money } from './money.ts';",
	'',
	"const eur = (minor: number) => money(minor, 'EUR');",
	'',
	'const invoice: Invoice = {',
	"\tid: 'INV-1001',",
	"\tcustomerId: 'C-7',",
	"\tissuedOn: '2026-01-15',",
	"\tcurrency: 'EUR',",
	'\tlines: [',
	"\t\t{ description: 'Consulting', quantity: 2, unitPrice: eur(15000), taxRate: 'standard' },",
	"\t\t{ description: 'Book', quantity: 1, unitPrice: eur(2000), taxRate: 'reduced' }",
	'\t]',
	'};',
	'',
	"describe('totals', () => {",
	"\tit('adds the lines and their tax', () => {",
	'\t\texpect(totals(invoice)).toEqual({ net: eur(32000), tax: eur(6100), gross: eur(38100) });',
	'\t});',
	'',
	"\tit('totals an invoice in yen, which has no minor unit', () => {",
	'\t\tconst yen: Invoice = {',
	'\t\t\t...invoice,',
	"\t\t\tcurrency: 'JPY',",
	"\t\t\tlines: [{ description: 'Book', quantity: 3, unitPrice: money(1980, 'JPY'), taxRate: 'reduced' }]",
	'\t\t};',
	"\t\texpect(totals(yen).gross).toEqual(money(6237, 'JPY'));",
	'\t});',
	'});',
	'',
	"describe('validate', () => {",
	"\tit('accepts a good invoice', () => {",
	'\t\texpect(validate(invoice)).toEqual([]);',
	'\t});',
	'',
	"\tit('wants at least one line', () => {",
	"\t\texpect(validate({ ...invoice, lines: [] })).toEqual(['An invoice needs at least one line.']);",
	'\t});',
	'',
	"\tit('refuses a line in another currency', () => {",
	'\t\tconst mixed: Invoice = {',
	'\t\t\t...invoice,',
	"\t\t\tlines: [{ description: 'Book', quantity: 1, unitPrice: money(2000, 'GBP'), taxRate: 'reduced' }]",
	'\t\t};',
	"\t\texpect(validate(mixed)).toEqual(['Line 1 is in GBP, not EUR.']);",
	'\t});',
	'});'
);

const STORE_INVOICES_AFTER = text(
	"import type { CurrencyCode } from '../currency.ts';",
	"import type { Invoice, InvoiceLine } from '../invoice.ts';",
	"import { log } from '../log.ts';",
	"import { money } from '../money.ts';",
	"import type { Database } from './database.ts';",
	'',
	'interface InvoiceRow {',
	'\tid: string;',
	'\tcustomer_id: string;',
	'\tissued_on: string;',
	'\tcurrency: CurrencyCode;',
	'}',
	'',
	'interface LineRow {',
	'\tinvoice_id: string;',
	'\tposition: number;',
	'\tdescription: string;',
	'\tquantity: number;',
	'\tunit_price_minor: number;',
	"\ttax_rate: 'standard' | 'reduced' | 'zero';",
	'}',
	'',
	'export class InvoiceStore {',
	'\tconstructor(private readonly db: Database) {}',
	'',
	'\tasync get(id: string): Promise<Invoice | undefined> {',
	'\t\tconst row = await this.db.one<InvoiceRow>(',
	"\t\t\t'SELECT id, customer_id, issued_on, currency FROM invoices WHERE id = $1',",
	'\t\t\t[id]',
	'\t\t);',
	'\t\tif (row === undefined) {',
	"\t\t\tlog.info('invoice not found', { invoice: id });",
	'\t\t\treturn undefined;',
	'\t\t}',
	'\t\treturn this.#withLines(row);',
	'\t}',
	'',
	'\tasync forCustomer(customerId: string): Promise<Invoice[]> {',
	'\t\tconst rows = await this.db.many<InvoiceRow>(',
	"\t\t\t'SELECT id, customer_id, issued_on, currency FROM invoices WHERE customer_id = $1 ORDER BY issued_on DESC',",
	'\t\t\t[customerId]',
	'\t\t);',
	'\t\treturn Promise.all(rows.map((row) => this.#withLines(row)));',
	'\t}',
	'',
	'\tasync save(invoice: Invoice): Promise<void> {',
	'\t\tawait this.db.transaction(async (tx) => {',
	'\t\t\tawait tx.run(',
	"\t\t\t\t'INSERT INTO invoices (id, customer_id, issued_on, currency) VALUES ($1, $2, $3, $4) ' +",
	"\t\t\t\t\t'ON CONFLICT (id) DO UPDATE SET customer_id = $2, issued_on = $3, currency = $4',",
	'\t\t\t\t[invoice.id, invoice.customerId, invoice.issuedOn, invoice.currency]',
	'\t\t\t);',
	"\t\t\tawait tx.run('DELETE FROM invoice_lines WHERE invoice_id = $1', [invoice.id]);",
	'\t\t\tfor (const [position, line] of invoice.lines.entries()) {',
	'\t\t\t\tawait tx.run(',
	"\t\t\t\t\t'INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_minor, tax_rate) ' +",
	"\t\t\t\t\t\t'VALUES ($1, $2, $3, $4, $5, $6)',",
	'\t\t\t\t\t[invoice.id, position, line.description, line.quantity, line.unitPrice.minor, line.taxRate]',
	'\t\t\t\t);',
	'\t\t\t}',
	'\t\t});',
	"\t\tlog.info('saved invoice', { invoice: invoice.id, lines: invoice.lines.length });",
	'\t}',
	'',
	'\tasync #withLines(row: InvoiceRow): Promise<Invoice> {',
	'\t\tconst lines = await this.db.many<LineRow>(',
	"\t\t\t'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position',",
	'\t\t\t[row.id]',
	'\t\t);',
	'\t\treturn {',
	'\t\t\tid: row.id,',
	'\t\t\tcustomerId: row.customer_id,',
	'\t\t\tissuedOn: row.issued_on,',
	'\t\t\tcurrency: row.currency,',
	'\t\t\tlines: lines.map((line) => toLine(line, row.currency))',
	'\t\t};',
	'\t}',
	'}',
	'',
	'function toLine(row: LineRow, currency: CurrencyCode): InvoiceLine {',
	'\treturn {',
	'\t\tdescription: row.description,',
	'\t\tquantity: row.quantity,',
	'\t\tunitPrice: money(row.unit_price_minor, currency),',
	'\t\ttaxRate: row.tax_rate',
	'\t};',
	'}'
);

const STORE_CUSTOMERS_AFTER = text(
	"import type { CurrencyCode } from '../currency.ts';",
	"import type { Customer } from '../customers.ts';",
	"import type { Database } from './database.ts';",
	'',
	'interface CustomerRow {',
	'\tid: string;',
	'\tname: string;',
	'\temail: string;',
	'\tpreferred_currency: CurrencyCode | null;',
	'}',
	'',
	'export class CustomerStore {',
	'\tconstructor(private readonly db: Database) {}',
	'',
	'\tasync get(id: string): Promise<Customer | undefined> {',
	'\t\tconst row = await this.db.one<CustomerRow>(',
	"\t\t\t'SELECT id, name, email, preferred_currency FROM customers WHERE id = $1',",
	'\t\t\t[id]',
	'\t\t);',
	'\t\treturn row === undefined ? undefined : { id: row.id, name: row.name, email: row.email };',
	'\t}',
	'',
	'\t/** The currency new invoices for the customer are written in, if they chose one. */',
	'\tasync preferredCurrency(id: string): Promise<CurrencyCode | undefined> {',
	'\t\tconst row = await this.db.one<CustomerRow>(',
	"\t\t\t'SELECT preferred_currency FROM customers WHERE id = $1',",
	'\t\t\t[id]',
	'\t\t);',
	'\t\treturn row?.preferred_currency ?? undefined;',
	'\t}',
	'}'
);

const MIGRATION_CURRENCY = text(
	'-- Invoices get a currency. Every invoice written before now was in euros.',
	"ALTER TABLE invoices ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'EUR';",
	'ALTER TABLE invoices ALTER COLUMN currency DROP DEFAULT;',
	'',
	"-- Prices are in the minor unit of the invoice's currency, which is no longer always cents.",
	'ALTER TABLE invoice_lines RENAME COLUMN unit_price_cents TO unit_price_minor;',
	'',
	'-- A customer may choose the currency their invoices are written in.',
	'ALTER TABLE customers ADD COLUMN preferred_currency CHAR(3);'
);

const APP_AFTER = text(
	"import { config } from '../config.ts';",
	"import { log } from '../log.ts';",
	"import { connect } from '../store/connect.ts';",
	"import { CustomerStore } from '../store/customers.ts';",
	"import { InvoiceStore } from '../store/invoices.ts';",
	"import { createRouter, listen } from './http.ts';",
	"import { currencyRoutes, invoiceRoutes } from './routes.ts';",
	'',
	'export async function start(): Promise<void> {',
	'\tconst db = await connect(config.databaseUrl);',
	'\tconst router = createRouter();',
	'\tinvoiceRoutes(router, new InvoiceStore(db), new CustomerStore(db));',
	'\tcurrencyRoutes(router);',
	"\trouter.get('/health', async (_req, res) => res.json({ ok: true }));",
	'\tconst server = await listen(router, config.port);',
	"\tlog.info('listening', { port: config.port, level: config.logLevel });",
	"\tprocess.on('SIGTERM', () => {",
	"\t\tlog.warn('stopping', { signal: 'SIGTERM' });",
	'\t\tserver.close();',
	'\t});',
	'}',
	'',
	'await start();'
);

const ROUTES_AFTER = text(
	"import { config } from '../config.ts';",
	"import { CURRENCIES, parseCurrency, type CurrencyCode } from '../currency.ts';",
	"import { formatAmount, formatQuantity } from '../format/amount.ts';",
	'import type {',
	'\tCreateInvoiceRequest,',
	'\tCurrencyListResponse,',
	'\tInvoiceResponse',
	"} from '../generated/api-types.ts';",
	"import { lineNet, totals, validate, type Invoice } from '../invoice.ts';",
	"import { log } from '../log.ts';",
	"import { money } from '../money.ts';",
	"import type { CustomerStore } from '../store/customers.ts';",
	"import type { InvoiceStore } from '../store/invoices.ts';",
	"import { describeRate } from '../tax.ts';",
	"import type { Router } from './router.ts';",
	'',
	'export function invoiceRoutes(router: Router, store: InvoiceStore, customers: CustomerStore): void {',
	"\trouter.get('/invoices/:id', async (req, res) => {",
	"\t\tconst id = req.params['id'] ?? '';",
	'\t\tconst requestLog = log.with({ request: req.id });',
	"\t\trequestLog.info('get invoice', { invoice: id });",
	'\t\tconst invoice = await store.get(id);',
	"\t\tif (invoice === undefined) return res.status(404).json({ error: 'There is no such invoice.' });",
	'\t\treturn res.json(present(invoice));',
	'\t});',
	'',
	"\trouter.post('/invoices', async (req, res) => {",
	'\t\tconst requestLog = log.with({ request: req.id });',
	'\t\tconst body = req.body as CreateInvoiceRequest;',
	'\t\tlet currency: CurrencyCode;',
	'\t\ttry {',
	'\t\t\tcurrency =',
	'\t\t\t\tbody.currency === undefined',
	'\t\t\t\t\t? ((await customers.preferredCurrency(body.customer_id)) ?? config.defaultCurrency)',
	'\t\t\t\t\t: parseCurrency(body.currency);',
	'\t\t} catch (error) {',
	'\t\t\treturn res.status(422).json({ error: (error as Error).message });',
	'\t\t}',
	'\t\tconst invoice: Invoice = {',
	'\t\t\tid: body.id,',
	'\t\t\tcustomerId: body.customer_id,',
	'\t\t\tissuedOn: body.issued_on,',
	'\t\t\tcurrency,',
	'\t\t\tlines: body.lines.map((line) => ({',
	'\t\t\t\tdescription: line.description,',
	'\t\t\t\tquantity: line.quantity,',
	'\t\t\t\tunitPrice: money(line.unit_price_minor, currency),',
	'\t\t\t\ttaxRate: line.tax_rate',
	'\t\t\t}))',
	'\t\t};',
	'\t\tconst problems = validate(invoice);',
	'\t\tif (problems.length > 0) {',
	"\t\t\trequestLog.warn('refused invoice', { invoice: body.id, problems: problems.length });",
	"\t\t\treturn res.status(422).json({ error: 'The invoice is not valid.', problems });",
	'\t\t}',
	'\t\tawait store.save(invoice);',
	"\t\trequestLog.info('created invoice', { invoice: invoice.id, currency });",
	'\t\treturn res.status(201).json(present(invoice));',
	'\t});',
	'',
	"\trouter.get('/customers/:id/invoices', async (req, res) => {",
	"\t\tconst id = req.params['id'] ?? '';",
	"\t\tlog.with({ request: req.id }).info('list invoices', { customer: id });",
	'\t\tconst invoices = await store.forCustomer(id);',
	'\t\treturn res.json(invoices.map(present));',
	'\t});',
	'}',
	'',
	'export function currencyRoutes(router: Router): void {',
	"\trouter.get('/currencies', async (_req, res) => {",
	'\t\tconst body: CurrencyListResponse = {',
	'\t\t\tcurrencies: Object.entries(CURRENCIES).map(([code, c]) => ({',
	'\t\t\t\tcode: code as CurrencyCode,',
	'\t\t\t\tname: c.name,',
	'\t\t\t\tsymbol: c.symbol.trim(),',
	'\t\t\t\tminor_units: c.minorUnits',
	'\t\t\t})),',
	'\t\t\tdefault: config.defaultCurrency',
	'\t\t};',
	'\t\treturn res.json(body);',
	'\t});',
	'}',
	'',
	'function present(invoice: Invoice): InvoiceResponse {',
	'\tconst sums = totals(invoice);',
	'\treturn {',
	'\t\tid: invoice.id,',
	'\t\tcustomer_id: invoice.customerId,',
	'\t\tissued_on: invoice.issuedOn,',
	'\t\tcurrency: invoice.currency,',
	'\t\tnet: formatAmount(sums.net),',
	'\t\ttax: formatAmount(sums.tax),',
	'\t\tgross: formatAmount(sums.gross),',
	'\t\tgross_minor: sums.gross.minor,',
	'\t\tlines: invoice.lines.map((line) => ({',
	'\t\t\tdescription: line.description,',
	'\t\t\tquantity: formatQuantity(line.quantity),',
	'\t\t\tunit_price: formatAmount(line.unitPrice),',
	'\t\t\tnet: formatAmount(lineNet(line)),',
	'\t\t\ttax_rate: describeRate(line.taxRate)',
	'\t\t}))',
	'\t};',
	'}'
);

const ROUTES_TEST_AFTER = text(
	"import { describe, expect, it } from 'vitest';",
	"import { fakeCustomers, fakeStore, request } from '../test-helpers.ts';",
	"import { currencyRoutes, invoiceRoutes } from './routes.ts';",
	'',
	'const body = {',
	"\tid: 'INV-1001',",
	"\tcustomer_id: 'C-7',",
	"\tissued_on: '2026-01-15',",
	"\tlines: [{ description: 'Consulting', quantity: 2, unit_price_minor: 15000, tax_rate: 'standard' }]",
	'};',
	'',
	'const routes = (router: Parameters<typeof invoiceRoutes>[0], store: Parameters<typeof invoiceRoutes>[1]) =>',
	"\tinvoiceRoutes(router, store, fakeCustomers({ 'C-9': 'GBP' }));",
	'',
	"describe('POST /invoices', () => {",
	"\tit('creates an invoice in the default currency and answers with its totals', async () => {",
	"\t\tconst res = await request(routes, fakeStore(), 'POST', '/invoices', body);",
	'\t\texpect(res.status).toBe(201);',
	'\t\texpect(res.body).toMatchObject({',
	"\t\t\tcurrency: 'EUR',",
	"\t\t\tnet: '€300.00',",
	"\t\t\ttax: '€60.00',",
	"\t\t\tgross: '€360.00',",
	'\t\t\tgross_minor: 36000',
	'\t\t});',
	'\t});',
	'',
	"\tit('takes the currency the request names', async () => {",
	"\t\tconst res = await request(routes, fakeStore(), 'POST', '/invoices', { ...body, currency: 'jpy' });",
	"\t\texpect(res.body).toMatchObject({ currency: 'JPY', gross: '¥36,000' });",
	'\t});',
	'',
	'\tit("takes the customer\'s currency when the request names none", async () => {',
	"\t\tconst res = await request(routes, fakeStore(), 'POST', '/invoices', { ...body, customer_id: 'C-9' });",
	"\t\texpect(res.body).toMatchObject({ currency: 'GBP', gross: '£360.00' });",
	'\t});',
	'',
	"\tit('refuses a currency it does not know', async () => {",
	"\t\tconst res = await request(routes, fakeStore(), 'POST', '/invoices', { ...body, currency: 'XYZ' });",
	'\t\texpect(res.status).toBe(422);',
	'\t});',
	'',
	"\tit('refuses an invoice with no lines', async () => {",
	"\t\tconst res = await request(routes, fakeStore(), 'POST', '/invoices', { ...body, lines: [] });",
	'\t\texpect(res.status).toBe(422);',
	'\t});',
	'});',
	'',
	"describe('GET /invoices/:id', () => {",
	"\tit('answers 404 for an invoice that does not exist', async () => {",
	"\t\tconst res = await request(routes, fakeStore(), 'GET', '/invoices/nope');",
	'\t\texpect(res.status).toBe(404);',
	'\t});',
	'});',
	'',
	"describe('GET /currencies', () => {",
	"\tit('lists every currency and the default', async () => {",
	"\t\tconst res = await request((router) => currencyRoutes(router), fakeStore(), 'GET', '/currencies');",
	"\t\texpect(res.body).toMatchObject({ default: 'EUR' });",
	'\t});',
	'});'
);

const RENDER_AFTER = text(
	"import { config } from '../config.ts';",
	"import { CURRENCIES } from '../currency.ts';",
	"import type { Customer } from '../customers.ts';",
	"import { formatAmount, formatDate, formatQuantity } from '../format/amount.ts';",
	"import { lineNet, totals, type Invoice } from '../invoice.ts';",
	"import { describeRate } from '../tax.ts';",
	'',
	'/** The invoice as the lines of text the PDF writer lays out, top to bottom. */',
	'export function renderInvoice(invoice: Invoice, customer: Customer): string[] {',
	'\tconst sums = totals(invoice);',
	'\treturn [',
	'\t\tconfig.companyName,',
	'\t\t`Invoice ${invoice.id}`,',
	'\t\t`Issued ${formatDate(invoice.issuedOn)}`,',
	'\t\t`To ${customer.name}`,',
	'\t\t`Amounts in ${CURRENCIES[invoice.currency].name} (${invoice.currency})`,',
	"\t\t'',",
	'\t\t...invoice.lines.map(',
	'\t\t\t(line) =>',
	'\t\t\t\t`${line.description}  ${formatQuantity(line.quantity)} x ${formatAmount(line.unitPrice)}  ${describeRate(line.taxRate)}  ${formatAmount(lineNet(line))}`',
	'\t\t),',
	"\t\t'',",
	'\t\t`Net    ${formatAmount(sums.net)}`,',
	'\t\t`Tax    ${formatAmount(sums.tax)}`,',
	'\t\t`Total  ${formatAmount(sums.gross)}`',
	'\t];',
	'}'
);

const PDF_TEST_AFTER = text(
	"import { expect, it } from 'vitest';",
	"import type { CurrencyCode } from '../src/currency.ts';",
	"import { money } from '../src/money.ts';",
	"import { renderInvoice } from '../src/pdf/render.ts';",
	'',
	"const customer = { id: 'C-7', name: 'Ada Lovelace Ltd', email: 'accounts@example.com' };",
	'',
	'function invoiceIn(currency: CurrencyCode, prices: readonly [number, number, number]) {',
	'\treturn {',
	"\t\tid: 'INV-1001',",
	"\t\tcustomerId: 'C-7',",
	"\t\tissuedOn: '2026-01-15',",
	'\t\tcurrency,',
	'\t\tlines: [',
	"\t\t\t{ description: 'Consulting', quantity: 2, unitPrice: money(prices[0], currency), taxRate: 'standard' as const },",
	"\t\t\t{ description: 'Travel', quantity: 1, unitPrice: money(prices[1], currency), taxRate: 'zero' as const },",
	"\t\t\t{ description: 'Book', quantity: 1, unitPrice: money(prices[2], currency), taxRate: 'reduced' as const }",
	'\t\t]',
	'\t};',
	'}',
	'',
	"it('lays out an invoice', () => {",
	"\texpect(renderInvoice(invoiceIn('EUR', [15000, 4250, 2000]), customer)).toMatchSnapshot();",
	'});',
	'',
	"it('lays out an invoice in yen, with no minor unit', () => {",
	"\texpect(renderInvoice(invoiceIn('JPY', [24000, 6800, 3200]), customer)).toMatchSnapshot();",
	'});'
);

const SNAPSHOT_AFTER = snapshotFile([
	[
		'lays out an invoice',
		[
			'Ledger Ltd',
			'Invoice INV-1001',
			'Issued 15 Jan 2026',
			'To Ada Lovelace Ltd',
			'Amounts in Euro (EUR)',
			'',
			'Consulting  2 x €150.00  20%  €300.00',
			'Travel  1 x €42.50  0%  €42.50',
			'Book  1 x €20.00  5%  €20.00',
			'',
			'Net    €362.50',
			'Tax    €61.00',
			'Total  €423.50'
		]
	],
	[
		'lays out an invoice in yen, with no minor unit',
		[
			'Ledger Ltd',
			'Invoice INV-1001',
			'Issued 15 Jan 2026',
			'To Ada Lovelace Ltd',
			'Amounts in Japanese yen (JPY)',
			'',
			'Consulting  2 x ¥24,000  20%  ¥48,000',
			'Travel  1 x ¥6,800  0%  ¥6,800',
			'Book  1 x ¥3,200  5%  ¥3,200',
			'',
			'Net    ¥58,000',
			'Tax    ¥9,760',
			'Total  ¥67,760'
		]
	]
]);

const SMOKE_TEST = text(
	"import { expect, it } from 'vitest';",
	"import { fakeStore, request } from '../src/test-helpers.ts';",
	"import type { Router } from '../src/server/router.ts';",
	'',
	'// Not a test of any one feature: the service answers at all, and its health',
	'// check says so, which the deploy pipeline waits for.',
	"it('answers its health check', async () => {",
	'\tconst health = (router: Router) => {',
	"\t\trouter.get('/health', async (_req, res) => res.json({ ok: true }));",
	'\t};',
	"\tconst res = await request(health, fakeStore(), 'GET', '/health');",
	'\texpect(res).toEqual({ status: 200, body: { ok: true } });',
	'});',
	'',
	"it('answers 404 for a path it does not know', async () => {",
	"\tconst res = await request(() => undefined, fakeStore(), 'GET', '/nowhere');",
	'\texpect(res.status).toBe(404);',
	'});'
);

const TEST_HELPERS_AFTER = TEST_HELPERS.replace(
	"import type { InvoiceStore } from './store/invoices.ts';",
	[
		"import type { CurrencyCode } from './currency.ts';",
		"import type { CustomerStore } from './store/customers.ts';",
		"import type { InvoiceStore } from './store/invoices.ts';"
	].join('\n')
).replace(
	'/** Sends one request',
	[
		"/** A customer store that knows only each customer's preferred currency. */",
		'export function fakeCustomers(preferred: Readonly<Record<string, CurrencyCode>>): CustomerStore {',
		'\treturn {',
		'\t\tpreferredCurrency: async (id: string) => preferred[id]',
		'\t} as unknown as CustomerStore;',
		'}',
		'',
		'/** Sends one request'
	].join('\n')
);

const CURRENCIES_DOC = text(
	'# Currencies',
	'',
	'An invoice is written in one currency, and every amount on it is in that',
	"currency. Amounts are kept as whole numbers of the currency's minor unit: cents",
	'for euros, pence for pounds, and yen themselves for yen, which have none.',
	'',
	'## Which currency an invoice is in',
	'',
	'1. The currency the request names, if it names one.',
	"2. Otherwise the customer's preferred currency, if they have one.",
	'3. Otherwise `DEFAULT_CURRENCY`, which is EUR unless it is set.',
	'',
	'An invoice whose lines are in another currency than its own is refused.',
	'',
	'## Supported currencies',
	'',
	'| Code | Name | Minor units | Shown as |',
	'|---|---|---|---|',
	'| EUR | Euro | 2 | €1,234.56 |',
	'| GBP | Pound sterling | 2 | £1,234.56 |',
	'| USD | US dollar | 2 | $1,234.56 |',
	'| JPY | Japanese yen | 0 | ¥1,234 |',
	'| CHF | Swiss franc | 2 | CHF 1,234.55 |',
	'| SEK | Swedish krona | 2 | kr 1,234.56 |',
	'| KWD | Kuwaiti dinar | 3 | KD 1,234.567 |',
	'',
	'## Tax',
	'',
	'Tax is worked out on each line in exact minor units, then rounded half away',
	'from zero. Swiss francs are rounded to the nearest five rappen, as Swiss',
	'invoices must be.',
	'',
	'## Existing invoices',
	'',
	'Migration `004-invoice-currency.sql` marks every invoice written before it as',
	'EUR, which every invoice then was, and renames `unit_price_cents` to',
	'`unit_price_minor`.'
);

const RELEASE_AFTER = text(
	'#!/bin/sh',
	'# Tags a release and pushes it; CI builds and deploys the tag.',
	'set -eu',
	'version=$(node -p "require(\'./package.json\').version")',
	'git tag "v$version"',
	'git push origin "v$version"'
);

/**
 * The ledger's repository: committed, then changed in the working tree. Run
 * by `defineFixture` (keyed by this function's source, within one run) and by
 * the trials, which build it in a folder of their own.
 */
export async function buildLedger(repo: GitRepo): Promise<void> {
	const before: Readonly<Record<string, string | Uint8Array>> = {
		'package.json': PACKAGE_BEFORE,
		'pnpm-lock.yaml': lockfile({ typescript: '5.8.3', vitest: '3.1.4' }, [
			...SHARED_PACKAGES,
			...testFramework('3.1.4', '5.2.0', '1.0.2', '0.25.4')
		]),
		'tsconfig.json': TSCONFIG,
		'.gitattributes': GITATTRIBUTES,
		'README.md': README_BEFORE,
		'api/openapi.yaml': OPENAPI_BEFORE,
		'assets/logo.png': png(1),
		'scripts/release.sh': RELEASE_BEFORE,
		'src/config.ts': CONFIG_BEFORE,
		'src/customers.ts': CUSTOMERS,
		'src/format.ts': FORMAT_BEFORE,
		'src/generated/api-types.ts': apiTypes(SCHEMAS_BEFORE),
		'src/invoice.ts': INVOICE_BEFORE,
		'src/invoice.test.ts': INVOICE_TEST_BEFORE,
		'src/log.ts': LOG_BEFORE,
		'src/money.ts': MONEY_BEFORE,
		'src/money.test.ts': MONEY_TEST_BEFORE,
		'src/pdf/render.ts': RENDER_BEFORE,
		'src/server/app.ts': APP_BEFORE,
		'src/server/router.ts': ROUTER,
		'src/server/routes.ts': ROUTES_BEFORE,
		'src/server/routes.test.ts': ROUTES_TEST_BEFORE,
		'src/store/customers.ts': STORE_CUSTOMERS_BEFORE,
		'src/store/database.ts': DATABASE,
		'src/store/invoices.ts': STORE_INVOICES_BEFORE,
		'src/tax.ts': TAX_BEFORE,
		'src/tax.test.ts': TAX_TEST_BEFORE,
		'src/test-helpers.ts': TEST_HELPERS,
		'tests/pdf.test.ts': PDF_TEST_BEFORE,
		'tests/__snapshots__/pdf.test.ts.snap': SNAPSHOT_BEFORE,
		...Object.fromEntries(MIGRATIONS)
	};
	for (const [path, content] of Object.entries(before)) await repo.write(path, content);
	await repo.commit('Ledger 1.4: invoices in euros');

	await repo.move('src/format.ts', 'src/format/amount.ts');
	const after: Readonly<Record<string, string | Uint8Array>> = {
		'package.json': PACKAGE_AFTER,
		'pnpm-lock.yaml': lockfile({ typescript: '5.8.3', vitest: '3.2.1' }, [
			...SHARED_PACKAGES,
			...testFramework('3.2.1', '5.2.1', '1.1.1', '0.25.5')
		]),
		'README.md': README_AFTER,
		'api/openapi.yaml': OPENAPI_AFTER,
		'assets/logo.png': png(7),
		'docs/currencies.md': CURRENCIES_DOC,
		'scripts/release.sh': RELEASE_AFTER,
		'src/config.ts': CONFIG_AFTER,
		'src/currency.ts': CURRENCY,
		'src/currency.test.ts': CURRENCY_TEST,
		'src/format/amount.ts': FORMAT_AFTER,
		'src/generated/api-types.ts': apiTypes(SCHEMAS_AFTER),
		'src/invoice.ts': INVOICE_AFTER,
		'src/invoice.test.ts': INVOICE_TEST_AFTER,
		'src/log.ts': LOG_AFTER,
		'src/log.test.ts': LOG_TEST,
		'src/money.ts': MONEY_AFTER,
		'src/money.test.ts': MONEY_TEST_AFTER,
		'src/pdf/render.ts': RENDER_AFTER,
		'src/server/app.ts': APP_AFTER,
		'src/server/routes.ts': ROUTES_AFTER,
		'src/server/routes.test.ts': ROUTES_TEST_AFTER,
		'src/store/customers.ts': STORE_CUSTOMERS_AFTER,
		'src/store/invoices.ts': STORE_INVOICES_AFTER,
		'src/store/migrations/004-invoice-currency.sql': MIGRATION_CURRENCY,
		'src/tax.ts': TAX_AFTER,
		'src/tax.test.ts': TAX_TEST_AFTER,
		'src/test-helpers.ts': TEST_HELPERS_AFTER,
		'tests/pdf.test.ts': PDF_TEST_AFTER,
		'tests/__snapshots__/pdf.test.ts.snap': SNAPSHOT_AFTER,
		'tests/smoke.test.ts': SMOKE_TEST
	};
	for (const [path, content] of Object.entries(after)) await repo.write(path, content);
	await repo.setExecutable('scripts/release.sh', true);
}
