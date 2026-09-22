import { Hono } from 'hono';

// The concrete module, not the barrel: the control plane has no business
// importing the OpenRouter factory the barrel pulls in.
import {
  CheapVibeCodeAmbiguousEditError,
  CheapVibeCodeApiError,
  type CheapVibeCodeKeyEdit,
  EDIT_OUTCOME_UNKNOWN,
  HttpCheapVibeCodeClient,
  isManagedKeyCapacityError,
  MANAGED_KEY_CAPACITY,
} from '@/server/services/managedProvider/cheapvibecode';

import { assertBearerServiceToken } from './serviceToken';

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 401,
  });

const missingKey = () =>
  new Response(JSON.stringify({ error: 'cheapvibecode_not_configured' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 503,
  });

/**
 * Token-gated CheapVibeCode proxy for the product server.
 * Path prefix: /internal/cheapvibecode
 *
 * Only the operations that need the primary credential are proxied. Reading
 * a member key's balance is NOT here: CVC scopes `GET /v1/balance` to whichever
 * key authenticates it, so the product server does that directly with the key it
 * already holds. Narrower proxy, same containment.
 */
export const createCheapVibeCodeInternalApp = () => {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!assertBearerServiceToken(c.req.raw)) return unauthorized();
    return next();
  });

  const client = () => {
    const key = process.env.CHEAPVIBECODE_MANAGEMENT_API_KEY;
    return key ? new HttpCheapVibeCodeClient(key) : null;
  };

  app.post('/v1/keys', async (c) => {
    const cvc = client();
    if (!cvc) return missingKey();

    const body = (await c.req.json()) as {
      allowed_models?: string[];
      name?: string;
      token_limit?: number;
    };

    // The product server has already converted USD to CVC tokens at its own
    // boundary, so the limit is passed through verbatim. Re-deriving it from USD
    // here would floor a second time and would make the minted limit depend on
    // both processes agreeing on `AICO_CVC_TOKENS_PER_USD`.
    const tokenLimit = Number(body.token_limit ?? 0);
    if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) {
      return c.json({ error: 'token_limit must be a positive number' }, 400);
    }

    let created: Awaited<ReturnType<HttpCheapVibeCodeClient['createKeyWithTokenLimit']>>;
    try {
      created = await cvc.createKeyWithTokenLimit({
        allowedModels: body.allowed_models,
        name: String(body.name ?? 'aico'),
        tokenLimit,
      });
    } catch (error) {
      // Typed so the product server can tell "account full" from a transient fault.
      if (isManagedKeyCapacityError(error)) return c.json({ error: MANAGED_KEY_CAPACITY }, 409);
      throw error;
    }

    // Mirror CVC's own create shape so both clients share one parser.
    return c.json({
      key: created.key,
      meta: {
        id: created.hash,
        is_active: !created.disabled,
        name: created.name,
        token_limit: tokenLimit,
        tokens_used: 0,
      },
    });
  });

  /**
   * Freeze, unfreeze or delete one delegated key. The product server sends the
   * target's secret because CVC addresses edits by secret; it is never logged.
   * Only those two shapes pass — no limit change, no transfer — and the primary
   * key is refused by `editKey` itself.
   */
  app.post('/v1/keys/edit', async (c) => {
    const cvc = client();
    if (!cvc) return missingKey();

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const key = body?.key;
    if (typeof key !== 'string' || !key.startsWith('sk-')) {
      return c.json({ error: 'key must be a CheapVibeCode secret' }, 400);
    }

    let edit: CheapVibeCodeKeyEdit;
    if (body?.delete === true && !('active' in body)) edit = { delete: true, key };
    else if (typeof body?.active === 'boolean' && !('delete' in body)) {
      edit = { active: body.active, key };
    } else {
      return c.json({ error: 'send exactly one of active (boolean) or delete: true' }, 400);
    }

    try {
      await cvc.editKey(edit);
    } catch (error) {
      if (error instanceof CheapVibeCodeAmbiguousEditError) {
        return c.json({ error: EDIT_OUTCOME_UNKNOWN }, 502);
      }
      if (error instanceof CheapVibeCodeApiError && error.status < 500) {
        return c.json({ error: error.code ?? 'cheapvibecode_rejected' }, error.status as 400);
      }
      if (error instanceof Error && error.message.includes('primary key')) {
        return c.json({ error: 'primary_key_not_editable' }, 403);
      }
      throw error;
    }
    return c.json({ ok: true });
  });

  /**
   * The catalog. Proxied because listing models needs a CVC credential and the
   * only unscoped one is the primary key, which lives here. Returns cards already
   * mapped to our shape, so the product server never sees a raw coefficient it
   * could convert with a different token rate.
   */
  app.get('/v1/models', async (c) => {
    const cvc = client();
    if (!cvc) return missingKey();
    return c.json(await cvc.listModels());
  });

  app.get('/v1/balance', async (c) => {
    const cvc = client();
    if (!cvc) return missingKey();
    return c.json({ balanceUsd: await cvc.getAccountBalanceUsd() });
  });

  return app;
};
