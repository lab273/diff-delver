/**
 * How the command words an error from the daemon it found: from a newer
 * daemon, an answer it cannot read, or a request the daemon could not, means
 * this copy is too old.
 */
import { describe, expect, it } from 'vitest';
import { describeApiError, type ApiError } from '#lib/api/client.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { version } from '../../../../tests/support/daemons.ts';
import { describerFor } from './outcome.ts';

const CLONE = '/home/someone/src/diff-delver/bin/diff-delver.js';
const MINE = version('0.2.0+bbbbbbbbbbbb');
const NEWER = version('0.3.0+aaaaaaaaaaaa');

const unreadable: ApiError = { kind: 'unreadable', status: 200, detail: 'kind: not as expected' };
const badRequest: ApiError = {
	kind: 'refused',
	status: 400,
	reason: 'BadRequest',
	message: reviewerMessage('diff delver could not read this request (directory: required).')
};
const notFound: ApiError = {
	kind: 'refused',
	status: 404,
	reason: 'ReportNotFound',
	message: reviewerMessage('That diff is not here any more.')
};
const unreachable: ApiError = { kind: 'unreachable', detail: 'ECONNREFUSED' };

describe('how the command words errors from the daemon it found', () => {
	it('says this copy is too old when a newer daemon and it do not understand each other', () => {
		const describe = describerFor({ kind: 'newer', version: NEWER }, MINE, CLONE);
		const tooOld =
			'This copy of diff delver, 0.2.0, is too old for the newer one that is running, 0.3.0: it answered in a way this copy cannot read. To run the newest release, see "Upgrading" in the README (https://github.com/lab273/diff-delver#upgrading).';
		expect(describe(unreadable)).toBe(tooOld);
		expect(describe(badRequest)).toBe(tooOld);
	});

	it("says a newer daemon's other errors as they are", () => {
		const describe = describerFor({ kind: 'newer', version: NEWER }, MINE, CLONE);
		expect(describe(notFound)).toBe(describeApiError(notFound));
		expect(describe(unreachable)).toBe(describeApiError(unreachable));
	});

	it("says every error as it is from the command's own daemon, or one that replaced another", () => {
		for (const found of [
			{ kind: 'own' },
			{ kind: 'replaced', version: version('0.1.0+cccccccccccc') }
		] as const) {
			const describe = describerFor(found, MINE, CLONE);
			for (const error of [unreadable, badRequest, notFound, unreachable]) {
				expect(describe(error)).toBe(describeApiError(error));
			}
		}
	});
});
