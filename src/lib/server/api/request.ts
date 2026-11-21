/**
 * Reading what a request sends, at the API's edge: the body or query with its
 * schema, and a diff's id from the address. A request that does not parse is
 * answered here, so a route only ever sees parsed values.
 */
import type { z } from 'zod';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { badRequest, failure } from './present.ts';

export async function readBody<T>(
	request: Request,
	schema: z.ZodType<T>
): Promise<Result<T, Response>> {
	let json: unknown;
	try {
		json = await request.json();
	} catch {
		return err(badRequest('its body is not JSON'));
	}
	const parsed = schema.safeParse(json);
	if (parsed.success) return ok(parsed.data);
	const issue = parsed.error.issues[0];
	return err(
		badRequest(`${issue?.path.join('.') ?? 'body'}: ${issue?.message ?? 'not as expected'}`)
	);
}

/** A diff's id from the address, or the answer for an address that names none. */
export function diffId(text: string | undefined): Result<ReportId, Response> {
	const id = parseReportId(text ?? '');
	return id.ok
		? ok(id.value)
		: err(
				failure(
					404,
					'ReportNotFound',
					reviewerMessage(
						'There is no diff at this address. Go to the list of diffs to find the one you want.'
					)
				)
			);
}

/** The query of an address, read with its schema; each name once. */
export function readQuery<T>(url: URL, schema: z.ZodType<T>): Result<T, Response> {
	const fields: Record<string, string> = {};
	for (const [name, value] of url.searchParams) fields[name] = value;
	const parsed = schema.safeParse(fields);
	if (parsed.success) return ok(parsed.data);
	const issue = parsed.error.issues[0];
	return err(
		badRequest(`${issue?.path.join('.') ?? 'query'}: ${issue?.message ?? 'not as expected'}`)
	);
}

/** The answer for a path that names no file a diff could have. */
export function unknownPath(): Response {
	return badRequest('the path of the file is not one diff delver wrote');
}
