/**
 * BytePlus Ark (ModelArk) configuration — the native route for Seedance video
 * and Seedream image (#1157).
 *
 * Seedance and Seedream are ByteDance models we have always reached through
 * fal. Ark is the first-party API: BytePlus billing and quota, the full
 * Seedance request surface (reference-media roles, `return_last_frame`,
 * `camera_fixed`), and BytePlus's own model ids. Both routes stay wired — the
 * catalog key is stable and `resolveMediaVia` picks the via per call, so a
 * deployment with no `ARK_API_KEY` keeps working exactly as before.
 *
 * Platform key only: `team_api_keys` stays `'openrouter' | 'fal'`. A team that
 * brought its own fal key is paying fal, so their Seedance keeps going through
 * fal — routing their traffic onto our Ark account would bill us for it.
 */

import { getEnv } from '#env';
import type { MediaVia } from '@/lib/ai/via';

/**
 * Ark data-plane base URL. The adapter defaults to the Asia-Pacific host;
 * `ARK_BASE_URL` overrides it so e2e can point at aimock. Ark keys are
 * region-isolated and Seedance is served only from `ap-southeast`, so an EU
 * key against the default host fails at request time, not at startup.
 */
function getArkBaseUrl(): string | undefined {
  return getEnv().ARK_BASE_URL || undefined;
}

/** The platform Ark key, or undefined when BytePlus is not configured. */
export function getArkApiKey(): string | undefined {
  return getEnv().ARK_API_KEY || undefined;
}

/**
 * True when the platform can submit to Ark at all.
 *
 * E2E is hermetic by construction: aimock intercepts fal through the
 * `x-fal-target-host` header fal-config stamps, and Ark requests carry no such
 * header. Playwright injects the developer's process env into the worker
 * (`CLOUDFLARE_INCLUDE_PROCESS_ENV`), so an `ARK_API_KEY` sitting in a local
 * `.env.local` would silently point the suite at real, billable BytePlus. Under
 * `E2E_TEST` the via therefore stays off unless `ARK_BASE_URL` is also set —
 * i.e. unless someone has deliberately wired a mock host to record against.
 */
export function isBytePlusConfigured(): boolean {
  if (getArkApiKey() === undefined) return false;
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !env.ARK_BASE_URL) return false;
  return true;
}

/**
 * Claim the via for one generation. Stamp this on the job; poll MUST follow
 * the stamp rather than re-running this (an `ARK_API_KEY` added or removed
 * mid-run would send an Ark task id to fal).
 *
 * BytePlus wins when the platform has an Ark key AND the model has a BytePlus
 * id — otherwise fal. `usingOwnFalKey` flips it back to fal for a BYOK team
 * (see the module header): their key, their bill.
 */
export function resolveMediaVia(options: {
  byteplusModelId: string | undefined;
  usingOwnFalKey: boolean;
}): MediaVia {
  if (options.usingOwnFalKey) return 'fal';
  if (!options.byteplusModelId) return 'fal';
  return isBytePlusConfigured() ? 'byteplus' : 'fal';
}

/**
 * Shared Ark adapter config. `timeout` becomes an `AbortSignal` inside the
 * fetch-based video/image adapters, so a stalled Ark connection fails the
 * workflow step instead of hanging it (the same guarantee `createDeadlineFetch`
 * gives the fal path).
 */
export function arkAdapterConfig(
  apiKey: string,
  timeoutMs: number
): { apiKey: string; timeout: number; baseURL?: string } {
  const baseURL = getArkBaseUrl();
  return { apiKey, timeout: timeoutMs, ...(baseURL && { baseURL }) };
}
