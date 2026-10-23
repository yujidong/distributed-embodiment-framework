/**
 * Vision LLM client factory for the floorplan importer (B-D).
 *
 * Kept in its own module so `floorplan-vision.ts` stays free of runtime
 * imports from llm-integration (type-only there) and the scenario module's
 * import cost stays near zero until a caller actually builds a client.
 *
 * Configuration (env vars, overridable per flag in the CLI):
 * - `EAF_VISION_PROVIDER`: 'openai-compatible' (default) | 'siliconflow'
 * - `EAF_VISION_MODEL`:    vision model id (e.g.
 *                          'Qwen/Qwen2.5-VL-7B-Instruct'); defaults to
 *                          DEFAULT_VISION_MODEL — deliberately NOT the
 *                          LLM_MODEL text model the platform uses for agent
 *                          decisions.
 * - `EAF_VISION_BASE_URL`: required for 'openai-compatible'
 *   (e.g. http://localhost:8000/v1); API key from OPENAI_API_KEY when set.
 * - siliconflow uses SILICONFLOW_API_KEY (provider built-in).
 */

import { LLMClient } from '@active-collaboration/llm-integration';

import { FloorplanVisionError, type VisionChatClient } from './floorplan-vision.js';

export interface VisionClientOptions {
  provider?: string;
  model?: string;
  baseURL?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Default VISION model (Fix-6, usability F-07): the platform's agent-decision
 * model (`LLM_MODEL`) is typically a TEXT model — sending it an image yields a
 * confusing 404/error. Floor-plan recognition needs a vision-capable model;
 * override with EAF_VISION_MODEL or --model.
 */
export const DEFAULT_VISION_MODEL = 'Qwen/Qwen2.5-VL-7B-Instruct';

/** Build the vision chat client from env vars + explicit overrides. */
export function createVisionClientFromEnv(
  env: Env = process.env,
  overrides: VisionClientOptions = {},
): VisionChatClient {
  const provider = overrides.provider ?? env.EAF_VISION_PROVIDER ?? 'openai-compatible';
  const model = overrides.model ?? env.EAF_VISION_MODEL;
  const baseURL = overrides.baseURL ?? env.EAF_VISION_BASE_URL;

  switch (provider) {
    case 'openai-compatible': {
      if (!baseURL) {
        throw new FloorplanVisionError(
          'vision provider "openai-compatible" needs a base URL — set EAF_VISION_BASE_URL or pass --base-url',
        );
      }
      return new LLMClient('openai-compatible', {
        baseURL,
        model: model ?? DEFAULT_VISION_MODEL,
        // Vision models are slow; give them room.
        timeout: 180_000,
      });
    }
    case 'siliconflow':
      return new LLMClient('siliconflow', {
        // SiliconFlowProvider reads SILICONFLOW_API_KEY itself; the config
        // type requires the key field, so forward the env value (possibly
        // undefined → the provider throws its own actionable error).
        apiKey: env.SILICONFLOW_API_KEY ?? '',
        ...(model !== undefined ? { model } : {}),
      });
    default:
      throw new FloorplanVisionError(
        `unknown vision provider "${provider}" — expected openai-compatible | siliconflow`,
      );
  }
}
