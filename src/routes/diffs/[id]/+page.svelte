<!--
	A diff's page: what it is, how big and how far its review has got, whether
	its files have changed (with Update) or it is closed, what the last update
	did, anything left out of it; then the diff itself, group by group in
	reading order (or every file once), each file's part with its lines, ticked
	as the reviewer reads, with the next part to read always one key or one
	button away.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto, invalidate } from '$app/navigation';
	import { tick, untrack } from 'svelte';
	import { page as shownPage } from '$app/state';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ChangeCheckResponse, DiffPage, NextSourceOffer } from '#lib/api/schemas.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import { previousRevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import Notice from '#lib/ui/Notice.svelte';
	import { ChangeChecks, type Shown } from '#lib/ui/change-checks.ts';
	import { pageClient } from '#lib/ui/client.ts';
	import type { FileView, GroupKeyView, TallyView } from '#lib/api/schemas.ts';
	import { countOf, describeChanges, describeTally, formatCount } from '#lib/core/viewer/words.ts';
	import { nextShown, previousShown } from '#lib/core/viewer/reading-order.ts';
	import { parsePartIndex, type PartIndex } from '#lib/core/part-index.tiny.ts';
	import FileList from '#lib/ui/viewer/FileList.svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import CopyCommand from '#lib/ui/CopyCommand.svelte';
	import { RUN_COMMAND } from '#lib/ui/run-command.ts';
	import CommentEditor from '#lib/ui/viewer/CommentEditor.svelte';
	import { CommentDraft } from '#lib/ui/viewer/draft-comment.svelte.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import DraftComments from '#lib/ui/viewer/DraftComments.svelte';
	import AgentMarkdown from '#lib/ui/viewer/AgentMarkdown.svelte';
	import Part from '#lib/ui/viewer/Part.svelte';
	import TickRefused from '#lib/ui/viewer/TickRefused.svelte';
	import ProgressBar from '#lib/ui/viewer/ProgressBar.svelte';
	import Shortcuts from '#lib/ui/viewer/Shortcuts.svelte';
	import { isFindKey, shortcutOf } from '#lib/ui/viewer/keys.ts';
	import SearchBar from '#lib/ui/viewer/SearchBar.svelte';
	import type { CurrentMatch } from '#lib/ui/viewer/search.svelte.ts';
	import { whenReaderMoves } from '#lib/ui/viewer/reader-input.ts';
	import {
		done,
		NEXT_BATCH,
		partly,
		showTally,
		Viewer,
		type GroupInfo,
		type PartState,
		type TickTarget
	} from '#lib/ui/viewer/viewer.svelte.ts';
	import { withSetting, type Layout, type SettingChange } from '#lib/core/settings.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Check =
		| { readonly kind: 'checking' }
		| ChangeCheckResponse
		| { readonly kind: 'failed'; readonly message: string };
	let check: Check = $state({ kind: 'checking' });
	let problem = $state('');
	let busy = $state(false);

	/** Wide enough for two sides of code next to each other, with the rail beside them. */
	const WIDE_ENOUGH = '(min-width: 50rem)';

	/** Once a minute while the page is in view, besides whenever the person comes back to it. */
	const LOOK_AGAIN_EVERY = 60_000;
	const REFRESH_REVIEW_EVERY = 5_000;
	const UPDATED_HEADING = 'updated-heading';
	const PAGE_HEADING = 'page-heading';

	const checks = new ChangeChecks();

	function shown(): Shown {
		return { id: data.id, version: data.loaded.ok ? data.loaded.value.summary.version : undefined };
	}

	/**
	 * Asks whether this diff has a newer version than the page shows, and if not,
	 * whether its files have changed. Looking again in the background keeps what
	 * is shown when the answer cannot be had, rather than flickering, and is not
	 * done while a check is under way. An answer for a diff or version the page
	 * no longer shows is dropped (`change-checks.ts`).
	 */
	async function checkForChanges(quietly = false): Promise<void> {
		const ticket = checks.start(shown(), quietly);
		if (ticket === undefined) return;
		const checked = await pageClient().checkForChanges(ticket.shown.id, ticket.shown.version);
		if (!checks.finish(ticket, shown())) return;
		if (checked.ok) check = checked.value;
		else if (!quietly) check = { kind: 'failed', message: describeApiError(checked.error) };
	}

	// Again for each diff and version this page shows: opening another one reuses the page.
	$effect(() => {
		void shown();
		check = { kind: 'checking' };
		void checkForChanges();
	});

	// Changes to the source are offered to the reader. Agent writing, sorting
	// and ticks from another page appear on the version the reader already sees.
	$effect(() => {
		const refresh = (): void => {
			if (document.visibilityState === 'visible' && !busy) void refreshReview();
		};
		const again = (): void => {
			if (document.visibilityState !== 'visible' || busy) return;
			void checkForChanges(true);
			refresh();
		};
		window.addEventListener('focus', again);
		document.addEventListener('visibilitychange', again);
		const checkTimer = setInterval(again, LOOK_AGAIN_EVERY);
		const reviewTimer = setInterval(refresh, REFRESH_REVIEW_EVERY);
		return () => {
			window.removeEventListener('focus', again);
			document.removeEventListener('visibilitychange', again);
			clearInterval(checkTimer);
			clearInterval(reviewTimer);
		};
	});

	/** The notices whose buttons act on the whole diff, by their headings' ids, in the order the page shows them. */
	const NOTICE_HEADINGS = [
		'newer-heading',
		'closed-heading',
		'changed-heading',
		'nothing-left-heading'
	];

	/**
	 * Does what a notice's button asks. The buttons stay usable while it runs, so
	 * focus stays on them, and a press meanwhile does nothing. When the button has
	 * gone with its notice, focus goes to the notice that took its place, or to
	 * the page's heading, never to nowhere.
	 */
	async function act(action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
		if (busy) return;
		busy = true;
		problem = '';
		const done = await action();
		busy = false;
		if (!done.ok) problem = done.message ?? '';
		await tick();
		if (document.activeElement !== null && document.activeElement !== document.body) return;
		const notice = NOTICE_HEADINGS.map((id) => document.getElementById(id)).find((h) => h !== null);
		(notice ?? document.getElementById(PAGE_HEADING))?.focus();
	}

	/** Shows the version the page now has and moves focus to what the update did. */
	async function showNewVersion(): Promise<void> {
		await invalidate('app:diff');
		await tick();
		document.getElementById(UPDATED_HEADING)?.focus();
	}

	async function showNewer(): Promise<void> {
		await act(async () => {
			await showNewVersion();
			return { ok: true };
		});
	}

	async function update(): Promise<void> {
		await act(async () => {
			const updated = await pageClient().updateDiff(data.id);
			if (!updated.ok) return { ok: false, message: describeApiError(updated.error) };
			switch (updated.value.kind) {
				case 'updated':
					await showNewVersion();
					return { ok: true };
				case 'unchanged':
					check = { kind: 'unchanged' };
					return { ok: true };
				case 'nothing-left':
					check = {
						kind: 'nothing-left',
						reason: updated.value.reason,
						next: updated.value.next
					};
					return { ok: true };
			}
		});
	}

	async function setOpen(open: boolean): Promise<void> {
		await act(async () => {
			const client = pageClient();
			const changed = open ? await client.reopenDiff(data.id) : await client.closeDiff(data.id);
			if (!changed.ok) return { ok: false, message: describeApiError(changed.error) };
			await invalidate('app:diff');
			await checkForChanges();
			return { ok: true };
		});
	}

	async function openNext(next: NextSourceOffer, directory: string): Promise<void> {
		await act(async () => {
			const opened = await pageClient().open({ directory, source: next.source });
			if (!opened.ok) return { ok: false, message: describeApiError(opened.error) };
			if (opened.value.kind === 'nothing') return { ok: false, message: opened.value.reason };
			await goto(resolve('/diffs/[id]', { id: opened.value.diff.id }));
			return { ok: true };
		});
	}

	function fileCount(count: number): string {
		return count === 1 ? '1 file' : `${String(count)} files`;
	}

	// ── The viewer ──────────────────────────────────────────────────────────────

	// The rest of a large diff is drawn a batch a frame once the first screen is up.
	$effect(() => {
		const shown = viewer;
		if (shown === undefined) return;
		let frame = 0;
		const more = (): void => {
			if (shown.rendered >= shown.parts.length) return;
			shown.rendered = Math.min(shown.parts.length, shown.rendered + NEXT_BATCH);
			frame = requestAnimationFrame(more);
		};
		frame = requestAnimationFrame(more);
		return () => {
			cancelAnimationFrame(frame);
		};
	});

	const EVERYTHING_REVIEWED = 'everything-reviewed';

	/** Read from the address once, when the page opens: by file, and only what waits. */
	const startByFile = untrack(() => shownPage.url.searchParams.get('view') === 'files');
	const startOnlyWaiting = untrack(() => shownPage.url.searchParams.get('only') === 'unreviewed');

	let byFile = $state(startByFile);
	/** Whether the by-file view has been shown yet: it is made only when first asked for. */
	let fileListMade = $state(startByFile);
	let onlyWaiting = $state(startOnlyWaiting);
	/** How the person likes diffs shown, remembered by diff delver for every diff. */
	let settings = $state(untrack(() => data.settings));
	/** The viewer made last, whose search a newer version's takes over. */
	let lastViewer: Viewer | undefined;
	let refreshed = $state.raw<{ initial: DiffPage; frame: DiffPage }>();
	let staleTick = $state.raw<{
		id: DiffPage['summary']['id'];
		version: DiffPage['summary']['version'];
		message: string;
		part: PartState | undefined;
		group: GroupKeyView | undefined;
	}>();
	let reviewRefresh: Promise<void> | undefined;
	let waitingForCommentSelection = $state.raw<Viewer>();
	let viewportRestore: { viewer: Viewer; stop: () => void } | undefined;
	const viewer = $derived.by(() => {
		if (!data.loaded.ok) return undefined;
		const initial = data.loaded.value;
		const frame = refreshed?.initial === initial ? refreshed.frame : initial;
		const made = untrack(
			() =>
				new Viewer(
					frame,
					onlyWaiting,
					settings,
					pageClient(),
					lastViewer?.search.handOver(),
					frame === initial ? undefined : lastViewer
				)
		);
		lastViewer = made;
		return made;
	});

	async function refreshReview(force = false): Promise<void> {
		if (reviewRefresh !== undefined && !force) return;
		if (reviewRefresh !== undefined) await reviewRefresh;
		reviewRefresh ??= readReview(force).finally(() => (reviewRefresh = undefined));
		await reviewRefresh;
	}

	$effect(() => {
		if (viewer?.assignmentsChanged) void refreshReview(true);
	});

	$effect(() => {
		const shown = viewer;
		return () => {
			if (viewportRestore?.viewer === shown) viewportRestore?.stop();
		};
	});

	async function readReview(force: boolean): Promise<void> {
		const shown = viewer;
		if (shown === undefined || !data.loaded.ok) return;
		const initial = data.loaded.value;
		const frame = await shown.readRefresh(force);
		if (frame === undefined || viewer !== shown) return;
		if (shown.sameLayout(frame)) {
			waitingForCommentSelection = undefined;
			await keepingPlace(() => {
				shown.applyFrame(frame);
			});
			return;
		}
		// A same-version regroup can replace the gutter while the reviewer is
		// choosing lines. The old snapshot still accepts a comment on that range.
		if (document.querySelector('[data-selecting-comment]:not([hidden] *)') !== null) {
			waitingForCommentSelection = shown;
			return;
		}
		waitingForCommentSelection = undefined;

		const active = document.activeElement;
		const focused = partAtElement(shown, active);
		const heading = active?.closest('section.group')?.querySelector('h2')?.id;
		const atTop = window.scrollY === 0;
		const anchor = atTop ? undefined : viewportPart(shown);
		const before = partAtElement(shown, anchor);
		const top = anchor?.getBoundingClientRect().top;
		refreshed = { initial, frame };
		const next = viewer;
		const anchorAt = before === undefined ? undefined : next.nearestPart(before);
		const focusAt = focused === undefined ? anchorAt : next.nearestPart(focused);
		const destination = anchorAt === undefined ? undefined : next.parts[anchorAt];
		let waitingForHeight = false;
		if (before !== undefined && destination?.part.path === before.part.path) {
			destination.open = before.open;
			destination.showLarge = before.showLarge;
			if (top !== undefined && top < 0 && before.showLarge && destination.open) {
				waitingForHeight = true;
				void restoreLargePart(next, destination, top);
			}
		}
		if (anchorAt !== undefined) next.drawUpTo(anchorAt);
		if (focusAt !== undefined) next.drawUpTo(focusAt);
		await tick();
		if (viewer !== next) return;
		const anchorNow = anchorAt === undefined ? null : document.getElementById(`part-${anchorAt}`);
		if (atTop) {
			window.scrollTo(0, 0);
		} else if (anchorNow !== null && top !== undefined && !waitingForHeight) {
			// A neighbouring file gives focus somewhere to go when the old one is
			// gone. Its contents cannot stand in for the old viewport offset.
			if (destination?.part.path === before?.part.path) {
				window.scrollBy(0, anchorNow.getBoundingClientRect().top - top);
			}
		}
		if (focusLost() && (focused !== undefined || heading !== undefined)) {
			const headingNow = heading === undefined ? null : document.getElementById(heading);
			const target =
				(focused === undefined ? headingNow : null) ??
				(focusAt === undefined ? null : document.getElementById(`part-${focusAt}-toggle`)) ??
				document.getElementById(PAGE_HEADING);
			target?.focus({ preventScroll: true });
		}
	}

	/**
	 * A loading placeholder cannot hold a deep scroll offset. Wait for the
	 * replacement table and its chunk placeholders, laying out only this part.
	 * User input and further handovers cancel the restoration without cancelling
	 * the part's ordinary load.
	 */
	async function restoreLargePart(shown: Viewer, part: PartState, top: number): Promise<void> {
		viewportRestore?.stop();
		part.measuring = true;
		const attempt = { stopped: false };
		const stop = (): void => {
			attempt.stopped = true;
			part.measuring = false;
			stopListening();
			if (viewportRestore?.stop === stop) viewportRestore = undefined;
		};
		const stopListening = whenReaderMoves(window, stop);
		viewportRestore = { viewer: shown, stop };
		try {
			await shown.load(part.index);
			await tick();
			if (attempt.stopped || viewer !== shown || part.lines.kind !== 'loaded' || !part.open) return;
			const destination = document.getElementById(`part-${part.index}`);
			if (destination === null || !shown.shows(part.index)) return;
			const box = destination.getBoundingClientRect();
			if (box.height === 0) return;
			// If the relocated part is shorter, keep its end in reach.
			const offset = Math.max(top, Math.min(0, window.innerHeight - box.height));
			window.scrollBy(0, box.top - offset);
		} finally {
			stop();
		}
	}

	function onScreen(element: HTMLElement): boolean {
		const box = element.getBoundingClientRect();
		return box.bottom > 0 && box.top < window.innerHeight;
	}

	function viewportPart(shown: Viewer | undefined): HTMLElement | undefined {
		const current = shown?.current;
		const reading =
			current === undefined ? null : document.getElementById(`part-${String(current)}`);
		if (reading !== null && onScreen(reading)) return reading;
		return [...document.querySelectorAll<HTMLElement>('article.part')].find(onScreen);
	}

	function partAtElement(shown: Viewer, element: Element | null | undefined) {
		const part = element?.closest('article.part');
		if (part === null || part === undefined) return undefined;
		const index = parsePartIndex(Number(part.id.replace(/^part-/, '')));
		return index.ok ? shown.parts[index.value] : undefined;
	}

	/** Whether the window is wide enough for two sides; a narrower one shows one column, nothing lost. */
	let wide = $state(true);
	$effect(() => {
		const query = window.matchMedia(WIDE_ENOUGH);
		wide = query.matches;
		const changed = (): void => {
			wide = query.matches;
		};
		query.addEventListener('change', changed);
		return () => {
			query.removeEventListener('change', changed);
		};
	});
	const layout = $derived<Layout>(wide ? settings.layout : 'unified');
	$effect(() => {
		if (viewer !== undefined) viewer.layout = layout;
	});

	/**
	 * Changes how the diff is drawn without moving the reader: the part at the
	 * top of the screen (or the one they are on, when it is on the screen) stays
	 * where it was, however much taller or shorter its lines are drawn now.
	 */
	async function keepingPlace(change: () => void): Promise<void> {
		const atTop = window.scrollY === 0;
		const anchor = atTop ? undefined : viewportPart(viewer);
		const before = anchor?.getBoundingClientRect().top;
		change();
		await tick();
		if (atTop) {
			window.scrollTo(0, 0);
			return;
		}
		if (anchor === undefined || before === undefined || !anchor.isConnected) return;
		window.scrollBy(0, anchor.getBoundingClientRect().top - before);
	}

	/** Changes a setting on the page at once, and has diff delver remember it for every diff. */
	async function changeSetting(change: SettingChange, said: string): Promise<void> {
		await keepingPlace(() => {
			settings = withSetting(settings, change);
		});
		if (viewer !== undefined) {
			viewer.colouring = settings.colours;
			viewer.hideWhiteSpace = settings.hideWhiteSpace;
			viewer.announcement = said;
		}
		const saved = await pageClient().changeSetting(change);
		if (!saved.ok && viewer !== undefined) {
			viewer.announcement = `${said} It could not be remembered for next time: ${describeApiError(saved.error)}`;
		}
	}

	function setLayout(chosen: Layout): void {
		void changeSetting(
			{ name: 'layout', value: chosen },
			chosen === 'side-by-side'
				? wide
					? 'Changes are shown side by side: before on the left, after on the right.'
					: 'Changes will be shown side by side when the window is wider; it is too narrow now.'
				: 'Changes are shown in one column.'
		);
	}

	function setHideWhiteSpace(hide: boolean): void {
		void changeSetting(
			{ name: 'hide-white-space', value: hide },
			hide
				? 'Changes that only change white space are drawn as unchanged lines. They are still counted, and marking a file reviewed covers them.'
				: 'Changes that only change white space are shown.'
		);
	}

	function setColours(colours: boolean): void {
		void changeSetting(
			{ name: 'colours', value: colours },
			colours ? 'Code is coloured by language.' : 'Code is shown plain.'
		);
	}
	let helpOpen = $state(false);
	/** Whether the section view shows any part, with the filter as it is. */
	const anyShown = $derived(viewer?.parts.some((p) => viewer.shows(p.index)) ?? false);

	/** Keeps the view and the filter in the address, so a reload or a shared link keeps them. */
	function remember(): void {
		const url = new URL(shownPage.url.href);
		if (byFile) url.searchParams.set('view', 'files');
		else url.searchParams.delete('view');
		if (onlyWaiting) url.searchParams.set('only', 'unreviewed');
		else url.searchParams.delete('only');
		history.replaceState(history.state, '', url);
	}

	async function showByFile(files: boolean): Promise<void> {
		byFile = files;
		if (files) fileListMade = true;
		remember();
		await tick();
		if (files) document.getElementById('by-file-heading')?.focus();
	}

	function setOnlyWaiting(only: boolean): void {
		onlyWaiting = only;
		if (viewer !== undefined) viewer.onlyWaiting = only;
		remember();
		if (viewer !== undefined) {
			const left = viewer.waiting.filter(Boolean).length;
			viewer.announcement = only
				? `Showing only what you have not reviewed: ${countOf(left, 'file part', 'file parts')}.`
				: 'Showing everything.';
		}
	}

	/** Moves to a part: shown, opened if asked, focused and at the top of the screen. */
	async function goToPart(at: PartIndex, open: boolean): Promise<void> {
		if (viewer === undefined) return;
		const state = viewer.parts[at];
		if (state === undefined) return;
		if (byFile) {
			byFile = false;
			remember();
		}
		if (!viewer.shows(at)) setOnlyWaiting(false);
		viewer.current = at;
		viewer.drawUpTo(at);
		if (open) state.open = true;
		if (state.open && !viewer.isLarge(state)) void viewer.load(at);
		await tick();
		const toggle = document.getElementById(`part-${String(at)}-toggle`);
		toggle?.focus({ preventScroll: true });
		const part = document.getElementById(`part-${String(at)}`);
		if (part !== null) scrollToTop(part);
	}

	async function nextUnread(): Promise<void> {
		if (viewer === undefined) return;
		const at = viewer.nextUnread();
		if (at === undefined) {
			viewer.announcement = 'Everything is reviewed: there is nothing left to read.';
			await tick();
			document.getElementById(EVERYTHING_REVIEWED)?.focus();
			return;
		}
		await goToPart(at, true);
	}

	/** The next or previous part shown, from where the person is, even a part the filter has just hidden. */
	async function step(forward: boolean): Promise<void> {
		if (viewer === undefined) return;
		const at = forward ? viewer.nextShown() : viewer.previousShown();
		if (at === undefined) {
			viewer.announcement = forward ? 'This is the last file.' : 'This is the first file.';
			return;
		}
		await goToPart(at, false);
	}

	/** The part the person is on, for a key: the one they moved to, or the first shown. */
	function currentPart(): PartIndex | undefined {
		if (viewer === undefined) return undefined;
		return viewer.current ?? nextShown(viewer.shown);
	}

	/** Whether nothing on the page has focus, as when what had it has gone. */
	function focusLost(): boolean {
		return document.activeElement === null || document.activeElement === document.body;
	}

	async function afterTick(
		target: TickTarget,
		outcome: Awaited<ReturnType<Viewer['tick']>>
	): Promise<void> {
		if (viewer === undefined) return;
		switch (outcome.kind) {
			case 'sorting-changed':
				staleTick = {
					id: viewer.id,
					version: viewer.version,
					message: outcome.message,
					part: target.kind === 'part' ? viewer.parts[target.at] : undefined,
					group: target.kind === 'group' ? target.group.key : undefined
				};
				await refreshReview(true);
				return;
			case 'refused':
				if (outcome.outOfDate) await checkForChanges();
				return;
			case 'marked': {
				const beforeRefresh = viewer;
				if (outcome.refresh) await refreshReview(true);
				await tick();
				if (viewer !== beforeRefresh) return;
				if (outcome.allDone) {
					document.getElementById(EVERYTHING_REVIEWED)?.focus();
					return;
				}
				// Finishing a group moves on to the next one that still waits.
				const finished = outcome.groupFinished;
				if (finished !== undefined) {
					const next = viewer.groups.find(
						(g) =>
							g.first > finished.first && g.key.kind !== 'ignored' && !done(viewer.groupTally(g))
					);
					if (next !== undefined) document.getElementById(`${next.anchor}-heading`)?.focus();
				}
				if (byFile || !focusLost()) return;
				// What had focus went from the page with "Only what I have not reviewed": on
				// to the part shown after where it was, or before it when it was the last.
				const place = target.kind === 'part' ? target.at : viewer.current;
				const shown = viewer.shown;
				const next = nextShown(shown, place) ?? previousShown(shown, place);
				if (next !== undefined) await goToPart(next, false);
				else document.getElementById(EVERYTHING_REVIEWED)?.focus();
			}
		}
	}

	async function tickTarget(target: TickTarget, reviewed: boolean): Promise<void> {
		const shown = viewer;
		if (shown === undefined) return;
		staleTick = undefined;
		const outcome = await shown.tick(target, reviewed);
		if (viewer === shown) await afterTick(target, outcome);
	}

	async function tickPart(at: PartIndex, reviewed: boolean): Promise<void> {
		await tickTarget({ kind: 'part', at }, reviewed);
	}

	async function tickGroup(group: GroupInfo, reviewed: boolean): Promise<void> {
		await tickTarget({ kind: 'group', group }, reviewed);
	}

	async function tickFile(file: FileView, reviewed: boolean): Promise<void> {
		await tickTarget({ kind: 'file', path: file.path }, reviewed);
	}

	async function goTo(path: EscapedPath, group: GroupKeyView): Promise<void> {
		const at = viewer?.partOf(group, path);
		if (at !== undefined) await goToPart(at, true);
	}

	// ── Searching the diff ──────────────────────────────────────────────────────

	const SEARCH_INPUT = 'search-input';
	/** What had focus when the search was opened, to go back to when it closes. */
	let searchOpenedFrom: HTMLElement | null = null;
	/** Where the reader was before the search first moved them, to put them back. */
	let beforeSearch:
		| {
				readonly anchor: string;
				readonly top: number;
				readonly y: number;
				readonly byFile: boolean;
		  }
		| undefined;
	/** Moving to a match is under way: the search says it is busy. */
	let movingToMatch = $state(false);

	// A newer version keeps the search open, with what is in the box, searched
	// again; where it moved the reader was in the older one, so is forgotten.
	$effect(() => {
		const shown = viewer;
		if (shown === undefined) return;
		untrack(() => {
			beforeSearch = undefined;
			// What had focus when it opened was drawn for the older version, and is gone.
			if (searchOpenedFrom?.isConnected !== true) searchOpenedFrom = null;
			if (shown.search.open && shown.search.text !== '') void shown.search.search();
		});
	});

	function nextFrame(): Promise<void> {
		return new Promise((resolve) => {
			requestAnimationFrame(() => {
				resolve();
			});
		});
	}

	/**
	 * Takes the reader to a group's heading, at the top of the screen. Focusing it
	 * alone would scroll only until it showed, at the bottom of the screen, where
	 * the parts above it, still filling in their lines, would push it off again.
	 */
	function goToGroupHeading(anchor: string): void {
		const heading = document.getElementById(`${anchor}-heading`);
		if (heading === null) return;
		scrollToTop(heading);
		heading.focus({ preventScroll: true });
	}

	/**
	 * Scrolls an element to the top of the screen, as far as the page goes, and
	 * below the search when it is open: the search stays at the top of the
	 * screen, so whatever its height it would otherwise be drawn over the element.
	 */
	function scrollToTop(element: HTMLElement): void {
		element.scrollIntoView({ block: 'start' });
		const search = document.querySelector('[role="search"]');
		if (search === null) return;
		const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
		const under =
			search.getBoundingClientRect().bottom + margin - element.getBoundingClientRect().top;
		if (under > 0) window.scrollBy(0, -under);
	}

	/** Where the reader is: the part at the top of the screen and how far down it is. */
	function readerPlace(): { readonly anchor: string; readonly top: number; readonly y: number } {
		const parts = [...document.querySelectorAll<HTMLElement>('article.part')];
		const anchor = parts.find((p) => p.getBoundingClientRect().bottom > 0);
		return {
			anchor: anchor?.id ?? '',
			top: anchor?.getBoundingClientRect().top ?? 0,
			y: window.scrollY
		};
	}

	async function openSearch(): Promise<void> {
		if (viewer === undefined) return;
		const active = document.activeElement;
		// Where focus goes back to when the search closes: what had it when the search
		// opened, or, when that went with an older version, what has it now.
		if (!viewer.search.open || (searchOpenedFrom === null && active?.id !== SEARCH_INPUT)) {
			searchOpenedFrom = active instanceof HTMLElement && active !== document.body ? active : null;
			viewer.search.open = true;
		}
		await tick();
		const input = document.getElementById(SEARCH_INPUT);
		if (input instanceof HTMLInputElement) {
			input.focus();
			input.select();
		}
	}

	/** Puts the reader back where they were before the search moved them, in the view they were in. */
	async function putReaderBack(): Promise<void> {
		const place = beforeSearch;
		beforeSearch = undefined;
		if (place === undefined) return;
		if (place.byFile !== byFile) {
			byFile = place.byFile;
			remember();
		}
		await tick();
		const anchor = place.anchor === '' ? null : document.getElementById(place.anchor);
		if (anchor === null) window.scrollTo(0, place.y);
		else window.scrollBy(0, anchor.getBoundingClientRect().top - place.top);
	}

	async function closeSearch(): Promise<void> {
		if (viewer === undefined) return;
		viewer.search.close();
		await putReaderBack();
		const back = searchOpenedFrom;
		searchOpenedFrom = null;
		(back?.isConnected === true ? back : document.getElementById(PAGE_HEADING))?.focus({
			preventScroll: true
		});
	}

	async function searchTyped(text: string): Promise<void> {
		if (viewer === undefined) return;
		if (text !== '') {
			viewer.search.typed(text);
			return;
		}
		viewer.search.text = '';
		await viewer.search.search();
		await putReaderBack();
	}

	/** How long, at most, a match moved to is kept in the middle while what is above it settles. */
	const SETTLE_FRAMES_AT_MOST = 300;

	/**
	 * Scrolls the current match to the middle of the screen once it is drawn,
	 * and keeps it there while what is above it settles: parts coming near the
	 * screen are laid out and their lines come, which moves everything below.
	 * Nothing, once a newer version's viewer has replaced the one moved in.
	 */
	async function showMatch(shown: Viewer, match: CurrentMatch): Promise<void> {
		if (viewer !== shown) return;
		// The search has the part's lines already: one turn draws them, and another
		// the chunk of a long hunk that holds the match.
		await tick();
		await tick();
		if (viewer !== shown) return;
		const element =
			match.place.kind === 'path'
				? document.getElementById(`part-${String(match.at)}-name`)
				: document.querySelector<HTMLElement>(`#part-${String(match.at)} [data-current-match]`);
		if (element === null) {
			// Never silently: the search box says so, the part at least is shown, and
			// the error is seen.
			console.error(`The match moved to in part ${String(match.at)} was not drawn.`);
			shown.search.notShown(match);
			document.getElementById(`part-${String(match.at)}`)?.scrollIntoView({ block: 'start' });
			return;
		}
		const centre = (): void => {
			const box = element.getBoundingClientRect();
			if (Math.abs(box.top + box.height / 2 - window.innerHeight / 2) >= 1) {
				element.scrollIntoView({ block: 'center' });
			}
		};
		centre();
		// Centred again whenever the diff's size changes, until a frame passes with
		// no change and no part above still fetching its lines, or the reader moves
		// on: by their own input (a wheel, a touch, a key, the scroll bar), which
		// the page's own scrolling never makes, or to another part, as with j or k.
		// The bound only ends the keeping of a match already centred, if a part's
		// lines never come.
		const diff = element.closest('.content') ?? document.body;
		const since = { resized: false, readerMoved: false };
		const keeping = (): boolean =>
			!since.readerMoved &&
			movesAsked <= 1 &&
			viewer === shown &&
			shown.search.open &&
			shown.current === match.at;
		const observer = new ResizeObserver(() => {
			since.resized = true;
			if (element.isConnected && keeping()) centre();
		});
		const stopListening = whenReaderMoves(window, () => {
			since.readerMoved = true;
		});
		observer.observe(diff);
		try {
			for (let frame = 0; frame < SETTLE_FRAMES_AT_MOST; frame += 1) {
				await nextFrame();
				if (!keeping()) return;
				const fetching = shown.parts.some((p) => p.index < match.at && p.lines.kind === 'loading');
				if (!since.resized && !fetching) return;
				since.resized = false;
			}
		} finally {
			observer.disconnect();
			stopListening();
		}
	}

	/** Moves under way and asked for, one after another, so a quick Enter is never lost. */
	let searchMoves: Promise<void> = Promise.resolve();
	let movesAsked = 0;

	function stepSearch(forward: boolean): Promise<void> {
		movesAsked += 1;
		movingToMatch = true;
		searchMoves = searchMoves.then(async () => {
			try {
				await moveToMatch(forward);
			} finally {
				movesAsked -= 1;
				if (movesAsked === 0) movingToMatch = false;
			}
		});
		return searchMoves;
	}

	/** Moves to the next match, or the previous; nothing once a newer version replaces the viewer. */
	async function moveToMatch(forward: boolean): Promise<void> {
		if (viewer === undefined) return;
		const shown = viewer;
		const search = shown.search;
		// Enter pressed before the search that typing started: search now.
		const found = search.found;
		if (search.text !== '' && (found.kind !== 'found' || found.text !== search.text)) {
			await search.search();
		}
		if (viewer !== shown || search.found.kind !== 'found') return;
		if (search.totals.matches === 0) {
			shown.announcement = 'No matches.';
			return;
		}
		beforeSearch ??= { ...readerPlace(), byFile };
		const moved = await search.step(forward);
		// The part numbers of an older version are not this one's: show nothing.
		if (moved === undefined || viewer !== shown) return;
		if (byFile) {
			byFile = false;
			remember();
		}
		await showMatch(shown, moved);
	}

	function setSearchOption(
		option: 'match-case' | 'changed-only' | 'skip-closed',
		on: boolean
	): void {
		if (viewer === undefined) return;
		const search = viewer.search;
		const change: SettingChange =
			option === 'match-case'
				? { name: 'search-match-case', value: on }
				: option === 'changed-only'
					? { name: 'search-changed-only', value: on }
					: { name: 'search-skip-closed', value: on };
		settings = withSetting(settings, change);
		search.matchCase = settings.searchMatchCase;
		search.changedOnly = settings.searchChangedOnly;
		search.skipClosed = settings.searchSkipClosed;
		if (search.text !== '') void search.search();
		void pageClient()
			.changeSetting(change)
			.then((saved) => {
				if (!saved.ok) {
					viewer.announcement = `The option could not be remembered for next time: ${describeApiError(saved.error)}`;
				}
			});
	}

	function onKey(event: KeyboardEvent): void {
		if (viewer === undefined || helpOpen) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (isFindKey(event, target?.id === SEARCH_INPUT)) {
			event.preventDefault();
			void openSearch();
			return;
		}
		const action = shortcutOf({
			key: event.key,
			ctrlKey: event.ctrlKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			target:
				target === null
					? null
					: {
							tagName: target.tagName,
							...(target instanceof HTMLInputElement ? { type: target.type } : {}),
							isContentEditable: target.isContentEditable
						}
		});
		if (action === undefined) return;
		event.preventDefault();
		const at = currentPart();
		const state = at === undefined ? undefined : viewer.parts[at];
		switch (action) {
			case 'next-unread':
				void nextUnread();
				return;
			case 'next-part':
				void step(true);
				return;
			case 'previous-part':
				void step(false);
				return;
			case 'toggle-reviewed':
				if (byFile || at === undefined || state === undefined) return;
				if (state.part.group.kind === 'ignored') {
					viewer.announcement = 'Ignored changes need no review, so they have no tick.';
					return;
				}
				void (async () => {
					const shown = viewer;
					await goToPart(at, false);
					if (viewer === shown) await tickPart(at, !done(state.part.tally));
				})();
				return;
			case 'toggle-open':
				if (byFile || at === undefined || state === undefined) return;
				state.open = !state.open;
				void goToPart(at, false);
				return;
			case 'whole-file':
				if (byFile || at === undefined) return;
				void goToPart(at, true).then(() => viewer.wholeFile(at));
				return;
			case 'only-unreviewed':
				setOnlyWaiting(!onlyWaiting);
				return;
			case 'white-space':
				setHideWhiteSpace(!settings.hideWhiteSpace);
				return;
			case 'side-by-side':
				setLayout(settings.layout === 'side-by-side' ? 'unified' : 'side-by-side');
				return;
			case 'search':
				void openSearch();
				return;
			case 'help':
				helpOpen = true;
				return;
		}
	}

	/** Which part has focus, so keys act on the part the person is in. */
	function onFocusIn(event: FocusEvent): void {
		if (viewer === undefined || !(event.target instanceof Element)) return;
		const part = partAtElement(viewer, event.target);
		if (part !== undefined) viewer.current = part.index;
	}

	/** How far a group has got, after its name: "all reviewed", "2 of 5 changes reviewed". */
	function groupProgress(tally: TallyView): string {
		return done(tally) ? 'all reviewed' : describeTally(tally);
	}

	function progressText(reviewed: number, units: number): string {
		if (units === 0) return 'Nothing to review: every change is ignored';
		if (reviewed === 0) return `Not started: ${describeChanges(units)} to review`;
		if (reviewed === units) return `Everything reviewed: ${describeChanges(units)}`;
		return `${formatCount(reviewed)} of ${describeChanges(units)} reviewed`;
	}
	let draftsControl = $state<HTMLButtonElement>();
	const drafts = new SvelteMap<ReportId, CommentDraft>();
	function draftFor(id: ReportId): CommentDraft {
		return untrack(() => {
			const existing = drafts.get(id);
			if (existing !== undefined) return existing;
			const draft = new CommentDraft();
			drafts.set(id, draft);
			return draft;
		});
	}
</script>

<svelte:head>
	<title>
		{data.loaded.ok
			? `${data.loaded.value.summary.title} in ${data.loaded.value.summary.repository} – diff delver`
			: 'Delve not found – diff delver'}
	</title>
</svelte:head>

{#if !data.loaded.ok || viewer === undefined}
	<h1>This Delve cannot be shown</h1>
	<p>{data.loaded.ok ? '' : describeApiError(data.loaded.error)}</p>
	<p><a href={resolve('/')}>See all your Delves</a></p>
{:else}
	{@const page = data.loaded.value}
	{@const summary = viewer.summary}
	{@const draft = draftFor(summary.id)}
	{@const updated = page.update}
	{@const overall = viewer.overall}
	{@const allDone = overall.units > 0 && overall.reviewed === overall.units}
	{@const previousVersion = previousRevisionNumber(summary.version)}
	{@const ignoredUnits = summary.progress.ignored}
	{@const stale =
		staleTick?.id === viewer.id && staleTick.version === viewer.version ? staleTick : undefined}
	{@const staleAt = stale?.part === undefined ? undefined : viewer.nearestPart(stale.part)}
	{@const staleGroup = stale?.group === undefined ? undefined : viewer.groupWithKey(stale.group)}
	<div class="viewer">
		<div class="top">
			<div class="heading">
				<h1 id={PAGE_HEADING} tabindex="-1">{summary.title}</h1>
				<span class="state {summary.state.kind}">
					{summary.state.kind === 'open' ? 'Open' : 'Closed'}
				</span>
			</div>
			<p class="details">
				<span>{summary.repository}</span>
				<span>{summary.sizeText}</span>
				{#if summary.version > 1}
					<span>Version {summary.version}</span>
				{/if}
				<span>Last active {describeTimeAgo(summary.lastActivityAt, page.now)}</span>
			</p>

			{#if check.kind === 'updated'}
				<Notice heading="This Delve has a newer version" headingId="newer-heading">
					<p>
						It was updated to version {check.version} while this page was open, so what you see here,
						version
						{summary.version}, is out of date.
					</p>
					{#snippet actions()}
						<button type="button" aria-disabled={busy} onclick={showNewer}>
							Show the new version
						</button>
					{/snippet}
				</Notice>
			{:else if summary.state.kind === 'closed'}
				<Notice heading="This Delve is closed" headingId="closed-heading">
					<p>{summary.state.reason} You can still read it.</p>
					{#snippet actions()}
						<button type="button" aria-disabled={busy} onclick={() => setOpen(true)}>
							Reopen this Delve
						</button>
					{/snippet}
				</Notice>
			{:else if check.kind === 'changed'}
				<Notice heading="Your files have changed" headingId="changed-heading">
					<p>
						What you see here is how they were before.
						{check.files === 0
							? 'None of the changes this diff shows are different, so updating brings nothing new to review.'
							: `Update to see the ${fileCount(check.files)} that changed as they are now. Lines you marked as reviewed stay marked, unless they or the lines close to them changed.`}
					</p>
					{#snippet actions()}
						<button type="button" aria-disabled={busy} onclick={update}>Update</button>
					{/snippet}
				</Notice>
			{:else if check.kind === 'nothing-left'}
				{@const next = check.next}
				<Notice heading="Nothing is left to review here" headingId="nothing-left-heading">
					<p>{check.reason}</p>
					{#snippet actions()}
						{#if next !== null}
							<button
								type="button"
								aria-disabled={busy}
								onclick={() => openNext(next, page.directory)}
							>
								{next.offer}
							</button>
						{/if}
						<button type="button" aria-disabled={busy} onclick={() => setOpen(false)}>
							Close this Delve
						</button>
					{/snippet}
				</Notice>
			{/if}
			{#if summary.state.kind === 'open'}
				<p class="checked" role="status">
					{#if busy && check.kind === 'changed'}
						Updating to your files as they are now…
					{:else if check.kind === 'checking'}
						Checking for changes in the repository…
					{:else if check.kind === 'unchanged'}
						{summary.version === 1
							? 'No changes in the repository since you opened it.'
							: 'No changes in the repository since this version was taken.'}
					{:else if check.kind === 'failed'}
						Could not check for changes: {check.message}
					{/if}
				</p>
			{/if}
			{#if problem !== ''}
				<Notice tone="danger" heading="That did not work">
					<p>{problem}</p>
				</Notice>
			{/if}

			{#if updated !== null}
				<Notice
					tone="info"
					headingId={UPDATED_HEADING}
					heading="Updated to version {updated.version} {describeTimeAgo(updated.at, page.now)}"
				>
					<p>{updated.text}</p>
				</Notice>
			{/if}

			{#if page.leftOut.length > 0}
				<Notice heading="Some files could not be included">
					<ul>
						{#each page.leftOut as reason (reason)}
							<li>{reason}</li>
						{/each}
					</ul>
				</Notice>
			{/if}

			{#if allDone}
				<Notice tone="info" headingId={EVERYTHING_REVIEWED} heading="Everything is reviewed">
					<p>
						You have marked all {describeChanges(overall.units)} as reviewed.{ignoredUnits > 0
							? ` The ${describeChanges(ignoredUnits)} under Ignored need no review.`
							: ''}
					</p>
				</Notice>
			{/if}
		</div>

		<aside class="rail" aria-label="Your review">
			<h2 class="rail-heading">Your review</h2>
			<p class="progress-text">{progressText(overall.reviewed, overall.units)}</p>
			<ProgressBar
				tally={overall}
				label="Your review"
				text={progressText(overall.reviewed, overall.units)}
			/>
			{#if ignoredUnits > 0}
				<p class="ignored-text">{describeChanges(ignoredUnits)} ignored, not counted</p>
			{/if}
			<p class="what-counts">
				Each added line, removed line and change to a file itself, such as a rename, is one change.
			</p>
			{#if !allDone && overall.units > 0}
				<button type="button" class="primary" onclick={nextUnread}>
					{overall.reviewed === 0 ? 'Start reviewing' : 'Next unread'}
					<kbd aria-hidden="true">n</kbd>
				</button>
			{/if}
			<div class="finders">
				<button type="button" onclick={openSearch}>
					Search <kbd aria-hidden="true">/</kbd>
				</button>
			</div>
			{#if viewer.overview !== null}
				<details class="agent-overview" open>
					<summary>Agent overview</summary>
					<AgentMarkdown markdown={viewer.overview} />
				</details>
			{/if}
			<nav aria-label="Groups">
				<ol class="groups">
					{#each viewer.groups as group (group.id)}
						{@const tally = viewer.groupTally(group)}
						<li>
							<a
								href="#{group.anchor}"
								onclick={(event) => {
									event.preventDefault();
									if (byFile) void showByFile(false);
									void tick().then(() => {
										goToGroupHeading(group.anchor);
									});
								}}
							>
								{group.name}
							</a>
							<span class="group-tally">
								{group.key.kind === 'ignored'
									? `${fileCount(group.count)}, not counted`
									: groupProgress(tally)}
							</span>
						</li>
					{/each}
				</ol>
			</nav>
			<div class="controls">
				<div class="switch" role="group" aria-label="Show the diff">
					<button type="button" aria-pressed={!byFile} onclick={() => showByFile(false)}>
						By section
					</button>
					<button type="button" aria-pressed={byFile} onclick={() => showByFile(true)}>
						By file
					</button>
				</div>
				<button
					type="button"
					aria-pressed={onlyWaiting}
					onclick={() => {
						setOnlyWaiting(!onlyWaiting);
					}}
				>
					Only what I have not reviewed
				</button>
				<div class="switch" role="group" aria-label="Show changes">
					<button
						type="button"
						aria-pressed={settings.layout === 'unified'}
						onclick={() => {
							setLayout('unified');
						}}
					>
						Unified
					</button>
					<button
						type="button"
						aria-pressed={settings.layout === 'side-by-side'}
						onclick={() => {
							setLayout('side-by-side');
						}}
					>
						Side by side <kbd aria-hidden="true">s</kbd>
					</button>
				</div>
				{#if settings.layout === 'side-by-side' && !wide}
					<p class="narrow">
						The window is too narrow for two sides, so changes are in one column.
					</p>
				{/if}
				<button
					type="button"
					aria-pressed={settings.hideWhiteSpace}
					onclick={() => {
						setHideWhiteSpace(!settings.hideWhiteSpace);
					}}
				>
					Hide white-space changes <kbd aria-hidden="true">w</kbd>
				</button>
				<button
					type="button"
					aria-pressed={settings.colours}
					onclick={() => {
						setColours(!settings.colours);
					}}
				>
					Colour the code
				</button>
				<button type="button" class="quiet" onclick={() => (helpOpen = true)}>
					Keyboard shortcuts <kbd aria-hidden="true">?</kbd>
				</button>
			</div>
		</aside>

		<div class="content" role="presentation" onfocusin={onFocusIn}>
			{#if stale !== undefined && (byFile || (staleAt === undefined && staleGroup === undefined))}
				<TickRefused message={stale.message} behind={false} onshownewer={showNewer} />
			{/if}
			{#if viewer.search.open}
				<SearchBar
					search={viewer.search}
					busy={movingToMatch}
					ontext={searchTyped}
					onstep={stepSearch}
					onclose={closeSearch}
					onoption={setSearchOption}
				/>
			{/if}
			{#if waitingForCommentSelection === viewer}
				<p role="status">Finish choosing lines to see the updated sections.</p>
			{/if}
			{#if data.canReview}
				{#key summary.id}
					<DraftComments
						id={summary.id}
						version={summary.version}
						changes={draft.changes}
						bind:control={draftsControl}
					/>
					<CommentEditor
						{draft}
						id={summary.id}
						version={summary.version}
						open={summary.state.kind === 'open'}
						{showNewer}
						ondiscard={() => {
							draftsControl?.focus();
						}}
					/>
				{/key}
			{:else}
				<Notice heading="Enable draft comments">
					<p>Run this in a terminal in your repository, using the same data folder as the agent.</p>
					<CopyCommand command={`${RUN_COMMAND} choose`} label="Copy the command" />
					<p>Let the command open a tab in this browser. Then return here and reload this Delve.</p>
					{#snippet actions()}
						<button
							type="button"
							onclick={() => {
								location.reload();
							}}
						>
							Reload this Delve
						</button>
					{/snippet}
				</Notice>
			{/if}

			<!-- Keep the by-file list mounted through regrouping of the same version. -->
			{#key page}
				{#if fileListMade}
					<div hidden={!byFile}>
						<FileList {viewer} ontick={tickFile} ongo={goTo} onshownewer={showNewer} />
					</div>
				{/if}
			{/key}
			<!-- New versions and regrouped parts are drawn afresh. -->
			{#key viewer}
				<div hidden={byFile}>
					{#if !anyShown}
						<p class="empty">
							{onlyWaiting
								? 'You have reviewed everything: nothing is left to show with “Only what I have not reviewed”.'
								: 'There is nothing to show.'}
						</p>
					{/if}
					{#each viewer.groups as group (group.id)}
						{@const tally = viewer.groupTally(group)}
						{@const parts = viewer.parts.slice(group.first, group.first + group.count)}
						{@const shown = parts.filter((p) => viewer.shows(p.index) && viewer.drawn(p.index))}
						{#if shown.length > 0 || (!onlyWaiting && group.count === 0)}
							<section class="group" id={group.anchor} aria-labelledby="{group.anchor}-heading">
								<div class="group-head">
									<h2 id="{group.anchor}-heading" tabindex="-1">{group.name}</h2>
									<span class="group-tally">
										{fileCount(group.count)}{group.key.kind === 'ignored'
											? ', not counted'
											: `, ${groupProgress(tally)}`}
									</span>
									{#if group.key.kind !== 'ignored' && tally.units > 0}
										<label class="tick">
											<input
												type="checkbox"
												aria-label="All reviewed: {group.name}"
												checked={done(tally)}
												indeterminate={partly(tally)}
												onchange={async (event) => {
													const box = event.currentTarget;
													await tickGroup(group, box.checked);
													if (box.isConnected) showTally(box, viewer.groupTally(group));
												}}
											/>
											All reviewed
										</label>
									{/if}
								</div>
								{#if stale !== undefined && staleGroup?.id === group.id}
									<TickRefused message={stale.message} behind={false} onshownewer={showNewer} />
								{:else if viewer.refused?.kind === 'group' && viewer.refused.key === group.id}
									{@const refused = viewer.refused}
									<TickRefused
										message={refused.message}
										behind={refused.behind}
										onshownewer={showNewer}
									/>
								{/if}
								{#if group.summary !== null}
									<AgentMarkdown markdown={group.summary} label="Agent summary" />
								{:else if group.key.kind === 'uncategorised'}
									<p class="explain">
										{viewer.sorted
											? 'The agent did not place these, so they are listed here.'
											: 'No agent has sorted this diff into sections, so every file is listed here.'}
									</p>
								{:else if group.key.kind === 'ignored'}
									<p class="explain">
										These need no review and are not counted; each says why. Open one to read it.
									</p>
								{/if}
								{#each shown as state (state.key)}
									<Part
										{viewer}
										{state}
										{previousVersion}
										canComment={data.canReview && summary.state.kind === 'open'}
										{draft}
										sortingProblem={staleAt === state.index ? stale?.message : undefined}
										ontick={tickPart}
										ongo={goTo}
										onshownewer={showNewer}
									/>
								{/each}
							</section>
						{/if}
					{/each}
				</div>
			{/key}
			<p class="all-diffs"><a href={resolve('/')}>See all your Delves</a></p>
		</div>
	</div>
	<div class="visually-hidden" aria-live="polite">{viewer.announcement}</div>
	<Shortcuts bind:open={helpOpen} />
{/if}

<svelte:window onkeydown={onKey} />

<style>
	:global(main:has(.viewer)) {
		max-width: 92rem;
	}

	.viewer {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		grid-template-areas: 'top top' 'rail content';
		gap: 0 2rem;
	}

	.top {
		grid-area: top;
	}

	.rail {
		grid-area: rail;
		position: sticky;
		top: 1rem;
		align-self: start;
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		padding: 0.25rem 0.25rem 1rem;
		font-size: 0.875rem;
	}

	.content {
		grid-area: content;
		min-width: 0;
		margin-top: 1rem;
	}

	@media (max-width: 60rem) {
		.viewer {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'top' 'rail' 'content';
		}

		.rail {
			position: static;
			max-height: none;
		}
	}

	.heading {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
	}

	.state {
		font-size: 0.875rem;
		font-weight: 700;
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.6rem;
	}

	.state.open {
		color: var(--color-added);
		border-color: var(--color-added);
	}

	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin: 0.5rem 0 0;
		color: var(--color-muted);
	}

	.checked {
		margin: 0.5rem 0 0;
		min-height: 1.5rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.rail-heading {
		font-size: 1rem;
		margin: 1rem 0 0.25rem;
	}

	.progress-text {
		margin: 0 0 0.35rem;
		font-weight: 700;
	}

	.ignored-text,
	.what-counts {
		margin: 0.35rem 0 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.primary {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin-top: 0.75rem;
		padding: 0.4rem 0.9rem;
		background: var(--color-primary-button);
		border-color: var(--color-primary-button);
		color: var(--color-on-primary-button);
	}

	.primary:hover {
		background: var(--color-primary-button-hover);
	}

	kbd {
		font-size: 0.75rem;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-weight: 400;
		opacity: 0.8;
	}

	.finders {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.finders button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.agent-overview {
		border-block-start: 1px solid var(--color-border);
		margin-block-start: 1rem;
		padding-block-start: 0.65rem;
	}

	.agent-overview summary {
		cursor: pointer;
		font-weight: 700;
	}

	.groups {
		list-style: none;
		margin: 1rem 0 0;
		padding: 0;
		border-top: 1px solid var(--color-border);
	}

	.groups li {
		display: flex;
		flex-direction: column;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--color-border);
	}

	.groups a {
		font-weight: 700;
	}

	.group-tally {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.groups .group-tally::first-letter {
		text-transform: uppercase;
	}

	.controls {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.switch {
		display: flex;
	}

	.switch button:first-child {
		border-radius: 6px 0 0 6px;
	}

	.switch button:last-child {
		border-radius: 0 6px 6px 0;
		border-left: 0;
	}

	button[aria-pressed='true'] {
		background: var(--color-selected-button);
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.quiet {
		font-weight: 400;
	}

	.narrow {
		margin: 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.group {
		margin-bottom: 1.5rem;
	}

	.group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.25rem;
	}

	.group-head h2 {
		font-size: 1.125rem;
		margin: 0;
		scroll-margin-top: 1rem;
	}

	.group-head .tick {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-weight: 700;
		font-size: 0.875rem;
	}

	.tick input {
		width: 1rem;
		height: 1rem;
		margin: 0;
	}

	.explain {
		margin: 0 0 0.75rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.empty {
		color: var(--color-muted);
	}

	.all-diffs {
		margin-top: 2rem;
	}
</style>
