import { BRANDING_NAME } from '@lobechat/business-const';

/**
 * Market and built-in skills carry the upstream author names `LobeHub` /
 * `LobeHub Market` as data. Show them under the product name (D-018).
 */
export const formatSkillAuthor = (author?: string) => {
  if (!author) return author;
  if (author === 'LobeHub') return BRANDING_NAME;
  if (author === 'LobeHub Market') return `${BRANDING_NAME} Market`;
  return author;
};
