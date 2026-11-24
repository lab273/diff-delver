/**
 * The reviewer's comments as the page holds them (`comments.svelte.ts`),
 * against a real daemon through the typed client the page uses: what is being
 * written is kept whatever the daemon answers, and a new comment follows the
 * reviewer to lines of the version the page shows.
 */
import { describe, expect, it } from 'vitest';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { escapedRepoPath, type EscapedPath } from '#lib/core/path-bytes.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { browserClient, testDaemon } from '../../../../tests/support/daemons.ts';
import { defineFixture, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { Comments, type CommentPlace } from './comments.svelte.ts';

const commented = defineFixture('viewer-comments', async (repo) => {
	await repo.write('src/a.ts', 'one\ntwo\nthree\nfour\n');
	await repo.write('src/b.ts', 'first\n');
	await repo.commit('base');
	await repo.write('src/a.ts', 'one\nTWO\nthree\nfour\n');
	await repo.write('src/b.ts', 'first\nsecond\n');
});

function version(n: number): RevisionNumber {
	return value(parseRevisionNumber(n));
}

function path(text: string): EscapedPath {
	return escapedRepoPath(value(parseRepoPath(text)));
}

function place(on: number, file: string, first: number, last = first): CommentPlace {
	return {
		version: version(on),
		anchor: {
			path: path(file),
			side: 'new',
			first: lineNumberOf(first),
			last: lineNumberOf(last)
		}
	};
}

async function opened() {
	const repo = await useFixture(commented);
	const daemon = await testDaemon();
	const client = await browserClient(daemon);
	const started = value(await client.start({ directory: repo.dir }));
	if (started.kind !== 'opened') throw new Error(started.kind);
	const comments = new Comments(started.diff.id, client);
	await comments.load();
	return { repo, client, comments, id: started.diff.id };
}

describe('the comments a page holds', () => {
	it('starts one box for each run of lines, and goes back to the one that is there', async () => {
		const { comments } = await opened();
		expect(comments.saved).toEqual([]);
		const first = comments.start(place(1, 'src/a.ts', 2));
		first.body = 'Why capitals?';
		expect(comments.start(place(1, 'src/a.ts', 2))).toBe(first);
		expect(first.focusAsked).toBe(2);
		const range = comments.start(place(1, 'src/a.ts', 2, 3));
		const other = comments.start(place(1, 'src/b.ts', 2));
		expect(new Set([first, range, other]).size).toBe(3);
		expect(comments.writing).toEqual([first, range, other]);
		expect(first.body).toBe('Why capitals?');

		// A file's lines draw what is on that file and that version, and nothing else.
		expect(comments.on(version(1), path('src/a.ts')).writing).toEqual([first, range]);
		expect(comments.on(version(1), path('src/b.ts')).writing).toEqual([other]);
		expect(comments.on(version(2), path('src/a.ts')).writing).toEqual([]);

		// Only what has words in it is worth keeping from a careless press.
		expect(first.worthKeeping).toBe(true);
		expect(range.worthKeeping).toBe(false);
		comments.discard(range);
		expect(comments.writing).toEqual([first, other]);
	});

	it('saves a comment where it was written, and keeps one that cannot be saved as typed', async () => {
		const { comments } = await opened();
		const writing = comments.start(place(1, 'src/a.ts', 2, 3));
		expect(await comments.save(writing, version(1))).toEqual({ kind: 'not-saved' });
		expect(writing.problem).toBe('Write a comment before saving.');
		writing.body = 'x'.repeat(10_001);
		expect(await comments.save(writing, version(1))).toEqual({ kind: 'not-saved' });
		expect(writing.problem).toMatch(/too long to save/);
		expect(comments.writing).toEqual([writing]);

		// Lines the file does not have: the daemon says so, and the words stay.
		const beyond = comments.start(place(1, 'src/a.ts', 40));
		beyond.body = 'Past the end.';
		expect(await comments.save(beyond, version(1))).toEqual({ kind: 'not-saved' });
		expect(beyond.problem).toMatch(/Those lines are unavailable/);
		expect(beyond.behindOn).toBeUndefined();
		expect(beyond.body).toBe('Past the end.');
		comments.discard(beyond);

		writing.body = 'Two and three belong together.';
		const outcome = await comments.save(writing, version(1));
		expect(outcome).toMatchObject({
			kind: 'saved',
			comment: { body: 'Two and three belong together.', version: 1 }
		});
		expect(comments.writing).toEqual([]);
		expect(comments.said).toBe('Comment saved.');
		await comments.load();
		expect(comments.saved).toMatchObject([
			{ anchor: { path: 'src/a.ts', side: 'new', first: 2, last: 3 }, editedAt: null }
		]);
		expect(comments.now).toBeDefined();
		expect(comments.on(version(1), path('src/a.ts')).saved).toHaveLength(1);
		expect(comments.on(version(1), path('src/b.ts')).saved).toHaveLength(0);
	});

	it('keeps a comment refused by a newer version, and moves it to lines of that version', async () => {
		const { repo, client, comments, id } = await opened();
		const writing = comments.start(place(1, 'src/a.ts', 2));
		writing.body = 'Typed before the update.';
		await repo.write('src/a.ts', 'one\nTWO\nthree\nFOUR\n');
		expect(value(await client.updateDiff(id)).kind).toBe('updated');

		// The page still shows version 1: the save is refused, and says the Delve moved on.
		expect(await comments.save(writing, version(1))).toEqual({ kind: 'not-saved' });
		expect(writing.behindOn).toBe(1);
		expect(writing.problem).toMatch(/updated to version 2/);
		expect(writing.body).toBe('Typed before the update.');
		expect(comments.waitingForLines(version(1))).toEqual([]);

		// The page shows version 2: it waits for lines there, and cannot be saved on the old ones.
		expect(comments.waitingForLines(version(2))).toEqual([writing]);
		expect(await comments.save(writing, version(2))).toEqual({ kind: 'not-saved' });
		expect(comments.saved).toEqual([]);

		// The reviewer presses a line of version 2: the comment that waits moves there with its words.
		expect(comments.start(place(2, 'src/a.ts', 4))).toBe(writing);
		expect(writing.place).toEqual(place(2, 'src/a.ts', 4));
		expect(writing.problem).toBe('');
		expect(writing.behindOn).toBeUndefined();
		expect(comments.waitingForLines(version(2))).toEqual([]);
		expect(await comments.save(writing, version(2))).toMatchObject({
			kind: 'saved',
			comment: { body: 'Typed before the update.', version: 2 }
		});
		// With nothing waiting, the next line pressed starts a comment of its own.
		const next = comments.start(place(2, 'src/a.ts', 2));
		expect(next).not.toBe(writing);
		expect(next.body).toBe('');
	});

	it('says why when the draft cannot be read, and reads it again when asked', async () => {
		const { comments, client, id } = await opened();
		value(await client.deleteDiff(id));
		await comments.load();
		expect(comments.problem).toMatch(/not in diff delver any more/);
		expect(comments.saved).toEqual([]);
	});
});
