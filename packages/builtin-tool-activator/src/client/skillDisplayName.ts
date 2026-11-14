import { type TFunction } from 'i18next';

/**
 * Name of the builtin platform-management skill (`LobeHubIdentifier` in
 * `@lobechat/builtin-skills`). The name is the skill's identifier — persisted in
 * tool calls and resolved by the server — so only the label users see changes.
 */
const PLATFORM_SKILL_NAME = 'lobehub';

/**
 * Label for a skill chip/card: the skill's friendly title when it has one, a
 * localized product-neutral label for the platform skill, else the skill name.
 */
export const getSkillDisplayName = (
  t: TFunction<'plugin'>,
  name?: string,
  title?: string,
): string | undefined => {
  if (title) return title;
  if (name === PLATFORM_SKILL_NAME) return t('builtins.lobe-activator.skillName.lobehub');

  return name;
};
