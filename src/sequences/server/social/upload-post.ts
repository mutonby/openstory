/**
 * Upload-Post client (#1267) — the HTTP layer behind "Publish to social".
 * Upload-Post (https://www.upload-post.com) fans one video out to TikTok,
 * Instagram, YouTube, X, LinkedIn, … from a single request, so the app never
 * talks to the platforms' own APIs.
 *
 * The video is handed over by URL with `async_upload=true`: Upload-Post
 * fetches the rendered MP4 itself and answers within seconds, so the Worker
 * never streams the file and never waits on the platforms.
 *
 * A publish must not happen twice. The request id is derived from exactly
 * what the user confirmed (export, profile, platforms, text), is sent as the
 * `Idempotency-Key`, and is looked up before anything is sent. Only a 4xx
 * that proves the request was refused is reported as a failure; a 5xx, a
 * dropped connection or an unreadable reply says nothing about whether the
 * post was created, so it is reported as `unconfirmed` and never retried.
 *
 * Server-only: the caller resolves the team's `upload_post` key and passes it
 * in. Nothing here touches D1.
 */

import {
  isSocialPlatform,
  SOCIAL_PLATFORMS,
  type PlatformPublishResult,
  type PublishOutcome,
  type PublishStatus,
  type SocialPlatform,
  type SocialProfile,
} from '@/sequences/social-publish';

const UPLOAD_POST_API_URL = 'https://api.upload-post.com';

// The publish call hands over a URL, so Upload-Post answers in seconds; a
// call still open after this is treated as unconfirmed rather than failed.
const PUBLISH_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 15_000;

/**
 * Statuses that prove Upload-Post refused the request before creating
 * anything. Everything else non-2xx (5xx, 408, 409, …) is ambiguous.
 */
const DEFINITIVE_REJECTIONS = new Set([400, 401, 402, 403, 404, 413, 422, 429]);

export class UploadPostRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'UploadPostRejectedError';
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  // Upload-Post keys use the `Apikey` scheme, never `Bearer`.
  return { Authorization: `Apikey ${apiKey}` };
}

function readString(obj: object, key: string): string | null {
  const value: unknown = Reflect.get(obj, key);
  return typeof value === 'string' && value !== '' ? value : null;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const message =
        readString(parsed, 'message') ?? readString(parsed, 'error');
      if (message) return message;
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return text.slice(0, 300) || `Upload-Post returned ${response.status}`;
}

/**
 * Stable id for one publish: the same export, profile, platforms and text
 * always yield the same id, so a double click, a retry or a re-opened dialog
 * finds the earlier request instead of posting again. Anything the user
 * changes yields a new id, i.e. a new, separately confirmed publish.
 */
export async function derivePublishRequestId(input: {
  teamId: string;
  exportId: string;
  profile: string;
  platforms: readonly SocialPlatform[];
  title: string;
  description?: string;
  youtubePrivacy: string;
  tiktokPrivacy: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    v: 1,
    teamId: input.teamId,
    exportId: input.exportId,
    profile: input.profile,
    platforms: [...input.platforms].sort(),
    title: input.title,
    description: input.description ?? '',
    youtubePrivacy: input.youtubePrivacy,
    tiktokPrivacy: input.tiktokPrivacy,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return `openstory-${hex.slice(0, 32)}`;
}

/**
 * Parse `GET /api/uploadposts/users`. A platform counts as connected when its
 * entry is a non-null object — Upload-Post returns `""`/`null` for a platform
 * that was added to the profile but never linked.
 */
export function parseProfiles(payload: unknown): SocialProfile[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('profiles' in payload) ||
    !Array.isArray(payload.profiles)
  ) {
    return [];
  }
  const order = SOCIAL_PLATFORMS.map((p) => p.id);
  const profiles: SocialProfile[] = [];
  for (const entry of payload.profiles) {
    if (typeof entry !== 'object' || entry === null) continue;
    const username = readString(entry, 'username');
    if (!username) continue;
    const accounts: unknown = Reflect.get(entry, 'social_accounts');
    const platforms =
      typeof accounts === 'object' && accounts !== null
        ? Object.entries(accounts)
            .filter(
              ([, account]) => typeof account === 'object' && account !== null
            )
            .map(([platform]) => platform)
            .filter(isSocialPlatform)
            .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        : [];
    profiles.push({ username, platforms });
  }
  return profiles;
}

export async function listUploadPostProfiles(
  apiKey: string
): Promise<SocialProfile[]> {
  const response = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/users`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Could not load Upload-Post profiles: ${await readErrorMessage(response)}`
    );
  }
  return parseProfiles(await response.json());
}

function parsePlatformResult(entry: object): PlatformPublishResult | null {
  const platform = readString(entry, 'platform');
  if (!platform) return null;
  const rawUrl = readString(entry, 'post_url') ?? readString(entry, 'url');
  const url = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : null;
  const inbox = Reflect.get(entry, 'fallback_to_inbox') === true;
  const note = inbox
    ? 'Sent to the TikTok inbox as a draft — publish it from the TikTok app.'
    : url
      ? null
      : rawUrl;
  const error =
    readString(entry, 'error_message') ?? readString(entry, 'error');

  let state: PlatformPublishResult['state'];
  const perPlatform = readString(entry, 'status');
  if (Reflect.get(entry, 'skipped') === true || perPlatform === 'skipped') {
    state = 'skipped';
  } else if (perPlatform === 'queued' || perPlatform === 'processing') {
    state = 'pending';
  } else if (perPlatform === 'retryable') {
    // Upload-Post retries these itself.
    state = 'pending';
  } else {
    state = Reflect.get(entry, 'success') === true ? 'published' : 'failed';
  }
  return {
    platform,
    state,
    url,
    note: state === 'skipped' ? 'No account connected on this profile.' : note,
    error: state === 'failed' ? (error ?? 'Publishing failed') : null,
  };
}

/**
 * Parse `GET /api/uploadposts/status`. Platforms still in flight may not be
 * listed yet; the top-level status says whether more are coming.
 */
export function parsePublishStatus(payload: unknown): PublishStatus {
  if (typeof payload !== 'object' || payload === null) {
    return { state: 'running', message: null, results: [] };
  }
  const raw = readString(payload, 'status');
  const results: PlatformPublishResult[] = [];
  const rawResults: unknown = Reflect.get(payload, 'results');
  if (Array.isArray(rawResults)) {
    for (const entry of rawResults) {
      if (typeof entry !== 'object' || entry === null) continue;
      const parsed = parsePlatformResult(entry);
      if (parsed) results.push(parsed);
    }
  }
  const state: PublishStatus['state'] =
    raw === 'not_found'
      ? 'not_found'
      : raw === 'completed' || raw === 'failed'
        ? 'done'
        : 'running';
  return { state, message: readString(payload, 'message'), results };
}

export async function getUploadPostStatus(
  apiKey: string,
  requestId: string
): Promise<PublishStatus> {
  const url = new URL(`${UPLOAD_POST_API_URL}/api/uploadposts/status`);
  url.searchParams.set('request_id', requestId);
  const response = await fetch(url, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return { state: 'not_found', message: null, results: [] };
  }
  if (!response.ok) {
    throw new Error(
      `Could not read publish status: ${await readErrorMessage(response)}`
    );
  }
  return parsePublishStatus(await response.json());
}

export type PublishVideoInput = {
  requestId: string;
  /** Upload-Post profile username. */
  profile: string;
  platforms: SocialPlatform[];
  /** Publicly fetchable MP4 URL — Upload-Post downloads it itself. */
  videoUrl: string;
  title: string;
  description?: string;
  youtubePrivacy: string;
  /** `account_default` sends nothing and keeps the account's own setting. */
  tiktokPrivacy: string;
  /** Echoed back by Upload-Post's status and history. */
  externalId: string;
};

/**
 * Hand the export to Upload-Post, at most once per request id.
 *
 * 1. Look the request id up first: if Upload-Post already has it, report
 *    `resumed` and send nothing.
 * 2. Otherwise POST with the same id as `request_id` and `Idempotency-Key`.
 * 3. A definitive 4xx throws `UploadPostRejectedError`. A 5xx, a timeout or a
 *    dropped connection returns `unconfirmed` — the caller keeps polling the
 *    id and never offers to send it again.
 */
export async function publishUploadPostVideo(
  apiKey: string,
  input: PublishVideoInput
): Promise<PublishOutcome> {
  const { requestId } = input;

  const existing = await getUploadPostStatus(apiKey, requestId).catch(
    () => null
  );
  if (existing && existing.state !== 'not_found') {
    return { requestId, state: 'resumed' };
  }

  const form = new FormData();
  form.set('user', input.profile);
  for (const platform of input.platforms) form.append('platform[]', platform);
  form.set('video', input.videoUrl);
  form.set('title', input.title);
  if (input.description) form.set('description', input.description);
  if (input.platforms.includes('youtube')) {
    form.set('privacyStatus', input.youtubePrivacy);
  }
  if (
    input.platforms.includes('tiktok') &&
    input.tiktokPrivacy !== 'account_default'
  ) {
    form.set('privacy_level', input.tiktokPrivacy);
  }
  form.set('external_id', input.externalId);
  form.set('request_id', requestId);
  // Every OpenStory export is AI-generated: TikTok, Instagram, YouTube and X
  // show their AI label from this one flag.
  form.set('is_ai_generated', 'true');
  form.set('async_upload', 'true');

  let response: Response;
  try {
    response = await fetch(`${UPLOAD_POST_API_URL}/api/upload`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Idempotency-Key': requestId },
      body: form,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch {
    // The request may have reached Upload-Post before the connection dropped.
    return { requestId, state: 'unconfirmed' };
  }

  // Any 2xx means accepted, even with an empty or non-JSON body.
  if (response.ok) return { requestId, state: 'submitted' };

  if (DEFINITIVE_REJECTIONS.has(response.status)) {
    throw new UploadPostRejectedError(
      await readErrorMessage(response),
      response.status
    );
  }
  return { requestId, state: 'unconfirmed' };
}
