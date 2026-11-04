/**
 * Aico: server-default heterogeneous agents (Desktop CLI agents through the deployment's
 * LobeHub relay) are opt-in. The relay runtime is not Aico's managed provider, so its usage
 * is not metered against Aico wallets; it stays off unless the operator sets
 * `ENABLE_SERVER_DEFAULT_HETEROGENEOUS_AGENT=1`. Upstream treats it as on unless `'0'`.
 */
export const isServerDefaultHeterogeneousAgentEnabled = () =>
  process.env.ENABLE_SERVER_DEFAULT_HETEROGENEOUS_AGENT === '1';
