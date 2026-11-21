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
	return err(badRequest(describeIssue(parsed.error.issues[0])));
}

/**
 * What was wrong with a request, from the first issue its schema found: the
 * field and what is wrong with it, or only what is wrong when it is about the
 * whole request, such as a range given the wrong way round.
 */
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
	if (issue === undefined) return 'it is not as expected';
	const field = issue.path.map(String).join('.');
	return field === '' ? issue.message : `${field}: ${issue.message}`;
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
						'There is no Delve at this address. Go to the list of Delves to find the one you want.'
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
	return err(badRequest(describeIssue(parsed.error.issues[0])));
}

/** The answer for a path that names no file a diff could have. */
export function unknownPath(): Response {
	return badRequest('the path of the file is not one diff delver wrote');
}
