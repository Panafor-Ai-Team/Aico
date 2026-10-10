import { type ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { AGENT_RUNTIME_ERROR_SET } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import type { LobeChatDatabase } from '@/database/type';
import { createTraceOptions, initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import {
  AICO_BILLING_CONTEXT_HEADER,
  type AicoBillingContext,
  decodeBillingContextHeader,
  parseAicoBillingContext,
} from '@/server/services/aico/billingContext';
import { getLedgerConfig } from '@/server/services/aico/ledger/config';
import { getManagedChatPricing } from '@/server/services/aico/ledger/pricing';
import { AicoManagedPolicy, AicoManagedPolicyError } from '@/server/services/aico/managedPolicy';
import { resolveManagedPricingContext } from '@/server/services/aico/usageMultiplier';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';
import { type ChatStreamPayload } from '@/types/openai/chat';
import { createErrorResponse } from '@/utils/errorResponse';
import { getTracePayload } from '@/utils/trace';

import { resolveValidWorkspaceIdFromRequest } from '../../_utils/workspace';

// If user don't use fluid compute, will build  failed
// this enforce user to enable fluid compute
export const maxDuration = 300;

// Bounds for the pre-stream setup on the direct chat path. This route does not
// use the agent-runtime context builder, so its per-lookup caps do not apply
// here: a hanging DB read or key repair inside initModelRuntimeFromDB would
// otherwise stall first-token until maxDuration kills the stream mid-sentence.
const SETUP_TIMEOUT_MS = 20_000;
// Cap for waiting on upstream headers (time to first byte). Cleared once the
// stream starts, so long generations are never cut mid-stream.
const CHAT_START_TIMEOUT_MS = 60_000;

const withSetupTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`Chat setup timed out: ${label}`), {
          errorType: ChatErrorType.InternalServerError,
        }),
      );
    }, SETUP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Mid-stream silence means a stalled upstream: tokens flow continuously while
// healthy. Error the stream so the run ends instead of holding the operation
// open until maxDuration kills it. Long generations keep flowing and never
// trip this. Status and headers pass through untouched.
//
// Only real SSE event lines count as activity: gateways send blank lines and
// `: comment` keep-alives to hold the connection, and those bytes must not
// reset the watchdog or a stalled run would look alive forever.
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

const withStreamInactivityGuard = (
  response: Response,
  provider: string,
  model?: string,
): Response => {
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = new ReadableStream({
    async start(controller) {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          reader.cancel().catch(() => {});
          controller.error(
            new Error(
              `Chat stream stalled: no chunk for ${STREAM_INACTIVITY_TIMEOUT_MS}ms (timed out waiting for upstream, model ${model ?? provider})`,
            ),
          );
        }, STREAM_INACTIVITY_TIMEOUT_MS);
      };
      arm();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          carry += decoder.decode(value, { stream: true });
          const lines = carry.split('\n');
          carry = lines.pop() ?? '';
          if (carry.length > 4096) carry = carry.slice(-4096);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith(':')) continue;
            arm();
            break;
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    },
  });
  return new Response(guarded, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const resolveBillingContext = (
  req: Request,
  body: ChatStreamPayload & { aicoBilling?: unknown },
): AicoBillingContext => {
  const header = req.headers.get(AICO_BILLING_CONTEXT_HEADER);
  if (header) return decodeBillingContextHeader(header);
  if (body.aicoBilling !== undefined) return parseAicoBillingContext(body.aicoBilling);
  throw new AicoManagedPolicyError('BILLING_CONTEXT_REQUIRED');
};

/**
 * Records a `usage_logs` row against the billing context that actually paid for
 * the request, and pulls the member's authoritative OpenRouter spend so budgets
 * converge without waiting for a dashboard visit.
 */
const recordManagedUsage = async (params: {
  billing: AicoBillingContext;
  db: LobeChatDatabase;
  /**
   * False under ledger shadow: the hold settle already wrote this request's
   * priced row, so a placeholder here would only add a zero-cost duplicate.
   */
  logRow: boolean;
  modelId: string;
  userId: string;
}): Promise<void> => {
  const { billing, db, logRow, modelId, userId } = params;

  let orgId: string | null = null;
  let orgMemberId: string | null = null;
  const keyService = new AicoOpenRouterKeyService(db);

  if (billing.source === 'organization') {
    orgId = billing.organizationId;
    const members = await new OrganizationModel(db).listMembers(billing.organizationId);
    const me = members.find((m) => m.userId === userId && m.status === 'active');
    if (me) {
      orgMemberId = me.id;
      await keyService.syncMemberCycleUsage(me.id).catch(() => null);
    }
  } else {
    // Settle personal spend against the gateway's own balance, right after the
    // response that caused it. `persist` is what writes `settledUsageMicroUsd`
    // back, so the wallet the user sees falls as they spend instead of only
    // when they happen to open the billing page.
    await keyService.getUserRemaining(userId, { persist: true }).catch(() => null);
  }

  if (!logRow) return;

  await new AicoBillingModel(db).recordUsage({
    billingSource: billing.source,
    completionTokens: 0,
    costMicroUsd: 0,
    modelId,
    orgId,
    orgMemberId,
    promptTokens: 0,
    totalTokens: 0,
    userId,
  });
};

export const POST = checkAuth(async (req: Request, { params, userId, serverDB }) => {
  const provider = (await params)!.provider!;
  // Client-facing error bodies must never reveal the upstream gateway id
  // (openrouter/cheapvibecode): managed traffic is presented as `aico`.
  // Server-side logs below keep the real provider.
  const publicProvider = AicoManagedPolicy.isManagedProvider(provider) ? 'aico' : provider;

  try {
    // Aico product: wallet → provisioned OpenRouter keys only. Never accept
    // direct openai/google/deepseek (BYOK) chat routes.
    if (!AicoManagedPolicy.isManagedProvider(provider)) {
      throw new AicoManagedPolicyError('DIRECT_PROVIDER_NOT_ALLOWED', ChatErrorType.BadRequest);
    }

    const workspaceId = await resolveValidWorkspaceIdFromRequest({ req, serverDB, userId });
    const body = (await req.json()) as ChatStreamPayload & { aicoBilling?: unknown };
    // `aicoBilling` only tells this route who pays; it must never reach the
    // upstream API — strict endpoints (Responses) reject unknown parameters.
    const { aicoBilling: _aicoBilling, ...data } = body;

    let billingContext: AicoBillingContext;
    try {
      billingContext = resolveBillingContext(req, body);
    } catch (error) {
      const code =
        error instanceof Error && error.message.startsWith('BILLING_CONTEXT_')
          ? error.message
          : 'BILLING_CONTEXT_INVALID';
      throw new AicoManagedPolicyError(code);
    }

    // ============  1. init chat model   ============ //
    // Timed so the next first-token stall can be attributed to pre-LLM setup
    // vs mid-stream from logs alone (production saw 5+ min partial stalls).
    const chatSetupStartedAt = Date.now();
    // Single policy boundary: `AicoManagedPolicy` resolves the funded
    // wallet/budget, runs the model allow-list check (assertModelAllowed),
    // and injects the managed key — no env/BYOK fallback.
    const modelRuntime = await withSetupTimeout(
      initModelRuntimeFromDB(serverDB, userId, provider, workspaceId, {
        billingContext,
        modelId: data.model,
      }),
      'init-runtime',
    );

    // ============  2. create chat completion   ============ //

    const tracePayload = getTracePayload(req);

    let traceOptions = {};
    // If user enable trace
    if (tracePayload?.enabled) {
      traceOptions = createTraceOptions(data, { provider, trace: tracePayload });
    }

    // Fail fast when upstream sends no headers (gateway stall). The timer is
    // cleared once chat() resolves at stream start, so the body can stream up
    // to maxDuration without being cut. The race rejects on its own: a hung
    // upstream that ignores abort signals still resolves to an error here.
    const startController = new AbortController();
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const startTimeout = new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => {
        startController.abort(new Error('Chat start timed out: upstream-headers'));
        reject(
          Object.assign(new Error('Chat start timed out: upstream-headers'), {
            errorType: ChatErrorType.InternalServerError,
          }),
        );
      }, CHAT_START_TIMEOUT_MS);
    });
    const chatSignal = req.signal
      ? AbortSignal.any([req.signal, startController.signal])
      : startController.signal;
    let response;
    // Catalog-resolved pricing so dynamic model ids (missing from the static
    // bank) still stream a usage.cost. Best-effort: lookup failure falls back
    // to today's static-bank behavior.
    const managedPricing = await getManagedChatPricing(serverDB, data.model || '').catch(
      (error) => {
        console.warn('[aico] managed chat pricing lookup failed', error?.message);
        return undefined;
      },
    );
    try {
      response = await Promise.race([
        modelRuntime.chat(data, {
          user: userId,
          ...traceOptions,
          // Managed traffic is resold capacity: the cost reported alongside the
          // stream must already carry the platform multiplier.
          pricingContext: {
            ...(await resolveManagedPricingContext(serverDB)),
            ...(managedPricing && data.model
              ? { resolvedPricing: { modelId: data.model, pricing: managedPricing } }
              : {}),
          },
          signal: chatSignal,
        }),
        startTimeout,
      ]);
    } finally {
      clearTimeout(startTimer);
    }

    const chatSetupMs = Date.now() - chatSetupStartedAt;
    if (chatSetupMs > 10_000) {
      console.warn(`Route: [${provider}] slow pre-LLM setup: ${chatSetupMs}ms model=${data.model}`);
    }

    const guardedResponse =
      response instanceof Response
        ? withStreamInactivityGuard(response, provider, data.model)
        : response;

    // Under ledger enforce, `usage_logs` is written when the hold settles and the
    // hold is the spend. Under shadow the settle still writes the priced row, but
    // the key read below is what moves the balance, so it keeps running.
    const ledgerMode = getLedgerConfig().mode;
    if (billingContext && ledgerMode !== 'enforce') {
      // Best-effort and non-blocking. With the ledger off, the row's cost stays
      // 0/`pending`; the gateway's key counter is the source of truth for spend.
      void recordManagedUsage({
        billing: billingContext,
        db: serverDB,
        logRow: ledgerMode === 'off',
        modelId: data.model || provider,
        userId,
      }).catch((err) =>
        console.error(`[aico] post-chat usage recording failed for [${provider}]:`, err),
      );
    }

    return guardedResponse;
  } catch (e) {
    if (e instanceof AicoManagedPolicyError) {
      return createErrorResponse(e.errorType as any, {
        error: e.code || e.message,
        provider: publicProvider,
      });
    }

    const {
      errorType = ChatErrorType.InternalServerError,
      error: errorContent,
      ...res
    } = e as ChatCompletionErrorPayload;

    const error = errorContent || e;

    // track the error at server side
    if (AGENT_RUNTIME_ERROR_SET.has(errorType as string)) {
      console.warn(`Route: [${provider}] ${errorType}:`, error);
    } else {
      console.error(`Route: [${provider}] ${errorType}:`, error);
    }

    return createErrorResponse(errorType, { error, ...res, provider: publicProvider });
  }
});
