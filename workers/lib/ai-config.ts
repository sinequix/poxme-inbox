// Copyright (c) 2026 Sinequix
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// poxme integration — configurable Workers AI model selection.
//
// Upstream agentic-inbox hard-coded model IDs, several of which Cloudflare has
// since deprecated (e.g. @cf/meta/llama-3.1-8b-instruct-fast, deprecated
// 2026-05-30). This indirection lets each model be overridden via a Worker var
// without a code change, and ships current defaults.
//
// Override by setting AI_MODEL_CHAT / AI_MODEL_INJECTION / AI_MODEL_VERIFY in
// wrangler.jsonc `vars` (or as secrets).

import type { Env } from "../types";

export interface AiModels {
	/** General chat + auto-draft agent model. */
	chat: string;
	/** Small, fast instruct model for the yes/no prompt-injection classifier. */
	injection: string;
	/** Capable instruct model for proofreading/verifying outgoing drafts. */
	verify: string;
}

// Defaults verified current against the Workers AI catalogue on 2026-07-06.
// kimi-k2.5 is aliased to k2.6 (safe); llama-3.2-3b replaces the deprecated
// llama-3.1-8b-instruct-fast; llama-4-scout is still listed (not deprecated).
const DEFAULT_CHAT = "@cf/moonshotai/kimi-k2.5";
const DEFAULT_INJECTION = "@cf/meta/llama-3.2-3b-instruct";
const DEFAULT_VERIFY = "@cf/meta/llama-4-scout-17b-16e-instruct";

export function getAiModels(env: Env): AiModels {
	return {
		chat: env.AI_MODEL_CHAT || DEFAULT_CHAT,
		injection: env.AI_MODEL_INJECTION || DEFAULT_INJECTION,
		verify: env.AI_MODEL_VERIFY || DEFAULT_VERIFY,
	};
}
