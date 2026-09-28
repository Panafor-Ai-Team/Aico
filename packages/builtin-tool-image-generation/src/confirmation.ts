import type { DynamicInterventionResolver } from '@lobechat/types';

/**
 * The image model a user confirmed for a conversation.
 */
export interface ImageGenerationModelChoice {
  model: string;
  provider: string;
}

/**
 * Dynamic intervention resolver id registered by the client and server runtimes.
 * Referenced from the manifest so `generateImage` opens the settings / confirm
 * card before every interactive generation.
 */
export const IMAGE_GENERATION_CONFIRM_AUDIT = 'imageGenerationModelConfirmAudit';

/** Conversations without a topic (e.g. an unsaved first turn) share one slot. */
const NO_TOPIC_SCOPE = '__no_topic__';

const STORAGE_KEY = 'LOBE_IMAGE_GENERATION_CONFIRMED_MODELS';

const memoryStore = new Map<string, ImageGenerationModelChoice>();

const scopeOf = (topicId?: null | string) => topicId?.trim() || NO_TOPIC_SCOPE;

const isChoice = (value: unknown): value is ImageGenerationModelChoice =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as ImageGenerationModelChoice).model === 'string' &&
  typeof (value as ImageGenerationModelChoice).provider === 'string';

/**
 * `localStorage` keeps the confirmation across a browser reload so a long-lived
 * conversation never re-asks. It is unavailable server-side and can throw in
 * private-mode browsers, so every access degrades to the in-memory map.
 */
const getStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

const readPersisted = (): Record<string, ImageGenerationModelChoice> => {
  const storage = getStorage();
  if (!storage) return {};

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, ImageGenerationModelChoice>;
  } catch {
    return {};
  }
};

const writePersisted = (records: Record<string, ImageGenerationModelChoice>) => {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Quota / disabled storage — the in-memory map still covers this session.
  }
};

/**
 * The image model the user already confirmed for this conversation, if any.
 */
export const getConfirmedImageModel = (
  topicId?: null | string,
): ImageGenerationModelChoice | undefined => {
  const scope = scopeOf(topicId);
  const cached = memoryStore.get(scope);
  if (cached) return cached;

  const persisted = readPersisted()[scope];
  if (!isChoice(persisted)) return undefined;

  memoryStore.set(scope, persisted);
  return persisted;
};

/**
 * Record the user's pick so the next confirmation card in this conversation
 * proposes the same model.
 */
export const setConfirmedImageModel = (
  topicId: null | string | undefined,
  choice: ImageGenerationModelChoice,
): void => {
  const scope = scopeOf(topicId);
  memoryStore.set(scope, choice);
  writePersisted({ ...readPersisted(), [scope]: choice });
};

/** Test helper — drops every recorded confirmation. */
export const clearConfirmedImageModels = (): void => {
  memoryStore.clear();
  writePersisted({});
};

/**
 * Every interactive `generateImage` call waits for the confirm card, where the
 * user picks the model, quality and size — whatever their approval mode.
 * Headless runs (bots, scheduled tasks) have no card to answer, so they
 * generate straight away.
 */
export const imageGenerationModelConfirmAudit: DynamicInterventionResolver = async (
  _toolArgs,
  metadata,
) => metadata?.approvalMode !== 'headless';
