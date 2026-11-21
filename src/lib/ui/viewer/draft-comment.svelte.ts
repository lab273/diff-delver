import { describeApiError } from '#lib/api/client.ts';
import type { AddDraftComment } from '#lib/api/schemas.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { pageClient } from '#lib/ui/client.ts';

type CommentLocation = Omit<AddDraftComment, 'body'>;

/** One unsaved comment, owned by the Delve page above any particular viewer. */
export class CommentDraft {
	location = $state.raw<CommentLocation>();
	body = $state('');
	problem = $state('');
	replacing = $state(false);
	behind = $state(false);
	saving = $state(false);
	changes = $state(0);
	saved = $state(false);

	compose(location: CommentLocation): void {
		if (this.saving || (this.location !== undefined && !this.replacing)) return;
		this.location = location;
		this.problem = '';
		this.replacing = false;
		this.behind = false;
		this.saved = false;
	}

	discard(): void {
		if (this.saving) return;
		this.location = undefined;
		this.body = '';
		this.problem = '';
		this.replacing = false;
		this.behind = false;
	}

	async save(id: ReportId, shown: RevisionNumber): Promise<void> {
		const location = this.location;
		if (this.saving || this.replacing || this.behind || location?.version !== shown) return;
		if (this.body.trim() === '') {
			this.problem = 'Write a comment before saving.';
			return;
		}
		this.problem = '';
		this.saving = true;
		const result = await pageClient().addDraftComment(id, { ...location, body: this.body });
		this.saving = false;
		if (!result.ok) {
			this.problem = describeApiError(result.error);
			this.behind = result.error.kind === 'refused' && result.error.reason === 'VersionOutOfDate';
			return;
		}
		this.discard();
		this.saved = true;
		this.changes += 1;
	}
}
