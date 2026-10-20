import type {
  LobehubSkillProviderType,
  TaskTemplateConnectorReference,
  TaskTemplateConnectorSource,
} from '@lobechat/const';
import { getComposioAppByIdentifier, getLobehubSkillProviderById } from '@lobechat/const';

export interface ConnectorProviderMeta {
  icon: LobehubSkillProviderType['icon'];
  identifier: string;
  label: string;
  source: TaskTemplateConnectorSource;
}

export interface ConnectorProviderOptions {
  /**
   * Resolve a `lobehub`-sourced spec through Composio when the same tool exists
   * there. Used by deployments that run Composio without LobeHub Market auth:
   * a Market recommendation tagged `lobehub` (e.g. GitHub) must connect through
   * Composio instead of requiring a Market sign-in that can never succeed.
   */
  preferComposio?: boolean;
}

export const resolveConnectorSource = (
  spec: TaskTemplateConnectorReference,
  options: ConnectorProviderOptions = {},
): TaskTemplateConnectorSource =>
  options.preferComposio && getComposioAppByIdentifier(spec.identifier) ? 'composio' : spec.source;

export const getProviderMeta = (
  spec: TaskTemplateConnectorReference,
  options: ConnectorProviderOptions = {},
): ConnectorProviderMeta | undefined => {
  if (resolveConnectorSource(spec, options) === 'lobehub') {
    const p = getLobehubSkillProviderById(spec.identifier);
    if (!p) return undefined;
    return { icon: p.icon, identifier: spec.identifier, label: p.label, source: 'lobehub' };
  }
  const p = getComposioAppByIdentifier(spec.identifier);
  if (!p) return undefined;
  return { icon: p.icon, identifier: spec.identifier, label: p.label, source: 'composio' };
};

export const findNextUnconnectedSpec = (
  specs: TaskTemplateConnectorReference[] | undefined,
  isConnected: (spec: TaskTemplateConnectorReference) => boolean,
  options: ConnectorProviderOptions = {},
): ConnectorProviderMeta | undefined => {
  if (!specs || specs.length === 0) return undefined;
  for (const spec of specs) {
    if (isConnected(spec)) continue;
    const meta = getProviderMeta(spec, options);
    if (!meta) continue;
    return meta;
  }
  return undefined;
};
