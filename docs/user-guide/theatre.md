---
title: Theatre
description: Preview and export your final merged video
section: User Guide
order: 6
---

The **Theatre** tab is where you preview and share your final video. It displays the merged video that combines all your scene motion clips with the generated music track.

## Video Player

When a merged video is available, it displays in a full video player sized to your sequence's aspect ratio. The player is centered in the viewport and constrained to fit the screen height.

### Share Menu

A share button (top-right corner of the player) opens a dropdown with:

- **Copy video URL** — Copies the direct video URL to your clipboard
- **Download video** — Downloads the `.mp4` file with a filename based on your sequence title (e.g., `My_Sequence_openstory.mp4`)

### Publish to social

If your team has added an Upload-Post key in **Settings → API Keys**, the Download menu also offers **Publish to social…** once the current cut has been rendered. Pick an Upload-Post profile, the platforms to post to (only the accounts connected to that profile are listed), a caption and an optional description. YouTube uploads default to private; TikTok uses your account's default unless you pick "Only me".

You review exactly what will be posted before anything is sent, then follow each platform's result — a link to the post, or the reason it failed. Publishing the same thing twice is detected and not posted again.

## Video States

### Completed

The full video player is shown with playback controls and the share menu.

### Merging

A spinner with "Merging video segments..." text. The page polls every 2 seconds for status updates.

### Failed

An error message is displayed with the failure reason and a **Retry Merge** button.

### Pending

When no merged video exists yet:

> "No merged video yet. The merged video will be generated automatically once all motion segments are complete."

A **Generate Now** button is available if you want to trigger the merge manually.

## Aspect Ratio Sizing

The theatre player automatically sizes based on your sequence's aspect ratio:

| Ratio    | Behavior                                    |
| -------- | ------------------------------------------- |
| **16:9** | Full width, standard widescreen             |
| **9:16** | Narrow, tall — optimized for mobile preview |
| **1:1**  | Square, centered                            |

All ratios are constrained to `calc(100dvh - 15rem)` maximum height to fit within the viewport alongside the header and navigation tabs.
