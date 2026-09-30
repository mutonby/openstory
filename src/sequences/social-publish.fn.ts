/**
 * Publish to social (#1267) — server functions behind the Download menu's
 * "Publish to social…". Everything goes through Upload-Post
 * (`server/social/upload-post.ts`) on the team's own key (`team_api_keys`,
 * provider `upload_post`), resolved server-side; it never reaches the browser.
 *
 *   - `getSocialPublishingFn`     — `{ enabled }`: whether the team has a key.
 *                                   The menu item only exists when it does.
 *   - `listSocialProfilesFn`      — profiles + their connected platforms.
 *   - `publishSequenceExportFn`   — hand a `ready` export to Upload-Post by URL.
 *   - `getSocialPublishStatusFn`  — per-platform outcome of a publish.
 */

import { getRequest } from '@tanstack/react-start/server';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  sequenceAccessMiddleware,
  teamMemberAccessMiddleware,
} from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { getProductionDeploymentAppUrl } from '@/platform/server/env/environment';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import { publishInputSchema } from '@/sequences/social-publish';
import {
  derivePublishRequestId,
  getUploadPostStatus,
  listUploadPostProfiles,
  publishUploadPostVideo,
} from '@/sequences/server/social/upload-post';

const NO_KEY_MESSAGE =
  'Add an Upload-Post API key in Settings → API Keys to publish to social media.';

type ApiKeysReader = {
  resolveOptionalKey: (
    provider: 'upload_post'
  ) => Promise<{ key: string } | undefined>;
};

async function requireUploadPostKey(apiKeys: ApiKeysReader): Promise<string> {
  const resolved = await apiKeys.resolveOptionalKey('upload_post');
  if (!resolved) throw new Error(NO_KEY_MESSAGE);
  return resolved.key;
}

export const getSocialPublishingFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(zodValidator(z.object({ teamId: ulidSchema })))
  .handler(async ({ context }) => ({
    enabled: await context.scopedDb.apiKeys.hasUsableKey('upload_post'),
  }));

export const listSocialProfilesFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(zodValidator(z.object({ teamId: ulidSchema })))
  .handler(async ({ context }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);
    return listUploadPostProfiles(apiKey);
  });

export const publishSequenceExportFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(publishInputSchema))
  .handler(async ({ context, data }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);

    // The export must belong to the sequence the middleware just authorised —
    // `getById` alone would let a caller publish another team's file.
    const exportRow = await context.scopedDb.sequenceExports.getById(
      data.exportId
    );
    if (!exportRow || exportRow.sequenceId !== context.sequence.id) {
      throw new Error('Export not found for this sequence');
    }
    if (exportRow.status !== 'ready') {
      throw new Error(`Export is ${exportRow.status}, not ready to publish`);
    }

    // Stored URLs are origin-relative (#894). Upload-Post fetches the MP4
    // from its side, so absolutize it: CDN domain in prod, else the app URL.
    const videoUrl = toShareableUrl(
      exportRow.url,
      getProductionDeploymentAppUrl(getRequest())
    );
    if (!videoUrl.startsWith('https://') || isLocalUrl(videoUrl)) {
      throw new Error(
        'This render is not reachable from the internet, so Upload-Post cannot fetch it. Publishing works on a deployed OpenStory.'
      );
    }

    const requestId = await derivePublishRequestId({
      teamId: context.teamId,
      exportId: exportRow.id,
      profile: data.profile,
      platforms: data.platforms,
      title: data.title,
      description: data.description,
      youtubePrivacy: data.youtubePrivacy,
      tiktokPrivacy: data.tiktokPrivacy,
    });

    return publishUploadPostVideo(apiKey, {
      requestId,
      profile: data.profile,
      platforms: data.platforms,
      videoUrl,
      title: data.title,
      description: data.description,
      youtubePrivacy: data.youtubePrivacy,
      tiktokPrivacy: data.tiktokPrivacy,
      externalId: exportRow.id,
    });
  });

export const getSocialPublishStatusFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        teamId: ulidSchema,
        requestId: z.string().regex(/^openstory-[0-9a-f]{32}$/),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);
    return getUploadPostStatus(apiKey, data.requestId);
  });

function isLocalUrl(url: string): boolean {
  const { hostname } = new URL(url);
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.localhost')
  );
}
