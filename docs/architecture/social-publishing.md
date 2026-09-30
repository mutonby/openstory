# Publishing to social (#1267)

"Publish to social…" sends a finished render to a team's own TikTok,
Instagram, YouTube, LinkedIn, Facebook, X, Threads and Bluesky accounts
through [Upload-Post](https://www.upload-post.com).

## Opt-in per team

- The team adds an Upload-Post key in **Settings → API Keys → Publishing**
  (`team_api_keys`, provider `upload_post`). There is no platform key:
  `platformKeyFor('upload_post')` is `undefined`, so a team without its own
  key has no publishing at all.
- Without a key the Download menu has no "Publish to social…" item and the
  product looks exactly as before. `getSocialPublishingFn` answers that.
- The item is disabled until the current cut has a ready render, like
  "Copy link".

## Flow

1. `listSocialProfilesFn` — the Upload-Post profiles and which platforms each
   has connected. Only connected platforms are offered.
2. The dialog collects profile, platforms, caption, description and the
   YouTube / TikTok visibility, then shows a **review** of exactly those
   values. Publishing sends the reviewed values; editing means reviewing
   again.
3. `publishSequenceExportFn` checks the export belongs to the sequence and is
   `ready`, absolutizes its URL (`toShareableUrl`) and hands it to Upload-Post
   **by URL** with `async_upload=true`. Upload-Post fetches the MP4 itself and
   answers in seconds, so the Worker never streams the file (#1893) and never
   waits on the platforms. A render served from `localhost` cannot be
   fetched, so publishing is refused there with a clear message.
4. `getSocialPublishStatusFn` — the dialog polls the per-platform outcome.

## Never twice

Publishing is a public side effect, so the rules are:

- The request id is **derived** from team, export, profile, platforms, text
  and visibility (`derivePublishRequestId`). The same publish always has the
  same id; changing anything makes a new one.
- The id is sent as `request_id` **and** `Idempotency-Key`, and it is looked
  up before sending: if Upload-Post already has it, the call returns
  `resumed` and sends nothing. This holds after the provider's 24-hour
  idempotency window too, because the lookup reads Upload-Post's own record.
- Only a 4xx that proves the request was refused (400, 401, 402, 403, 404,
  413, 422, 429) is a failure. A 5xx, a timeout, a dropped connection or an
  unreadable reply says nothing about whether the post exists, so it returns
  `unconfirmed`: the dialog keeps polling the same id and never offers to
  publish again.
- Upload-Post briefly caches "not found", and an unconfirmed call may still be
  registering, so the dialog waits two minutes before saying the post could
  not be confirmed.
