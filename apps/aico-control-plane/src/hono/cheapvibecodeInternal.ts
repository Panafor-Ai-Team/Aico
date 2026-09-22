import { Hono } from 'hono';

// The concrete module, not the barrel: the control plane has no business
// importing the OpenRouter factory the barrel pulls in.
import {
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
