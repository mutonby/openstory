/**
 * Publish to social (#1267) — the client-safe half: which platforms the dialog
 * offers, the input schema, and the shapes the server fns return. The HTTP
 * client lives in `server/social/upload-post.ts`; the server fns in
 * `social-publish.fn.ts`.
 *
 * Publishing is opt-in per team: nothing here is reachable until the team has
 * saved an Upload-Post key in Settings → API Keys.
 */

import { z } from 'zod';

/**
 * Video platforms the dialog offers. Upload-Post supports more (Pinterest,
 * Reddit, …) but those need extra per-platform fields this first cut doesn't
 * collect. The id is Upload-Post's `platform[]` value and doubles as the key
 * of a profile's `social_accounts` map.
 */
export const SOCIAL_PLATFORMS = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'threads', label: 'Threads' },
  { id: 'bluesky', label: 'Bluesky' },
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]['id'];
const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id);

export function isSocialPlatform(value: string): value is SocialPlatform {
  return SOCIAL_PLATFORM_IDS.some((id) => id === value);
}

export function socialPlatformLabel(id: string): string {
  return SOCIAL_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}

export const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'] as const;

/**
 * TikTok decides per account which visibilities exist, so the only choices
 * offered are the account's own default and "only me" (always available).
 */
export const TIKTOK_PRIVACY = ['account_default', 'SELF_ONLY'] as const;

// YouTube caps titles at 100 characters; the other platforms take far longer
// captions, so the cap only applies when YouTube is selected.
export const YOUTUBE_TITLE_MAX = 100;
const TITLE_MAX = 2200;
const DESCRIPTION_MAX = 5000;

export const publishInputSchema = z
  .object({
    sequenceId: z.string(),
    exportId: z.string(),
    profile: z.string().trim().min(1, 'Pick an Upload-Post profile'),
    platforms: z
      .array(z.enum(SOCIAL_PLATFORM_IDS))
      .min(1, 'Pick at least one platform'),
    title: z.string().trim().min(1, 'A caption is required').max(TITLE_MAX),
    description: z.string().trim().max(DESCRIPTION_MAX).optional(),
    youtubePrivacy: z.enum(YOUTUBE_PRIVACY).default('private'),
    tiktokPrivacy: z.enum(TIKTOK_PRIVACY).default('account_default'),
  })
  .refine(
    (input) =>
      !input.platforms.includes('youtube') ||
      input.title.length <= YOUTUBE_TITLE_MAX,
    {
      message: `YouTube titles are limited to ${YOUTUBE_TITLE_MAX} characters`,
      path: ['title'],
    }
  );
export type PublishInput = z.input<typeof publishInputSchema>;

export type SocialProfile = {
  username: string;
  /** Platforms with a connected account, in `SOCIAL_PLATFORMS` order. */
  platforms: SocialPlatform[];
};

/**
 * Outcome of the publish call itself (not of each platform):
 *   - `submitted`   Upload-Post accepted the request.
 *   - `resumed`     the same publish (same export, profile, platforms and
 *                   text) was already sent; nothing was sent again.
 *   - `unconfirmed` the call errored in a way that doesn't say whether
 *                   Upload-Post got it (5xx, dropped connection). Nothing is
 *                   re-sent; the dialog keeps polling the same request id.
 */
export type PublishOutcome = {
  requestId: string;
  state: 'submitted' | 'resumed' | 'unconfirmed';
};

export type PlatformPublishResult = {
  platform: string;
  state: 'published' | 'failed' | 'skipped' | 'pending';
  /** Public post URL, when the platform returned one. */
  url: string | null;
  /** Why there is no URL (e.g. a private post, a TikTok inbox draft). */
  note: string | null;
  error: string | null;
};

export type PublishStatus = {
  /** `running` until every platform has an outcome. */
  state: 'running' | 'done' | 'not_found';
  message: string | null;
  results: PlatformPublishResult[];
};
