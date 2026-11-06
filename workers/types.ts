// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// LOGTO_ENDPOINT and API_AUDIENCE are declared in wrangler.jsonc `vars`, so they
// are already part of the generated Cloudflare.Env — do not redeclare them here
// (that would widen the generated literal types and conflict).
export interface Env extends Cloudflare.Env {
	// Legacy Cloudflare Access vars — retired in favour of Logto (see Phase 3).
	POLICY_AUD?: string;
	TEAM_DOMAIN?: string;

	// Shared secret trusting internal calls from the api-worker service binding.
	INTERNAL_SECRET?: string;

	// Overridable Workers AI model IDs (see workers/lib/ai-config.ts).
	AI_MODEL_CHAT?: string;
	AI_MODEL_INJECTION?: string;
	AI_MODEL_VERIFY?: string;

	// Shared secret gating the one-time /admin/migrate import (Phase 6).
	ADMIN_MIGRATE_SECRET?: string;

	// Direct stateful surfaces stay disabled until each DO instance is
	// cryptographically bound to the authenticated Logto subject.
	MCP_ENABLED?: string;
	AGENT_WEBSOCKET_ENABLED?: string;
}
