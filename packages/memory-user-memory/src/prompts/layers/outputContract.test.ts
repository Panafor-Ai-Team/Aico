import { CONTEXT_OBJECT_TYPES, CONTEXT_SUBJECT_TYPES } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { activityPrompt } from './activity';
import { contextPrompt } from './context';
import { experiencePrompt } from './experience';
import { identityPrompt } from './identity';
import { preferencePrompt } from './preference';

/**
 * @example
 * All memory-list prompts instruct the model to return `{ "memories": [...] }`.
 */
describe('memory layer prompt output contracts', () => {
  /**
   * @example
   * An empty extraction is returned as `{ "memories": [] }`, never `[]`.
   */
  it.each([
    ['activity', activityPrompt],
    ['context', contextPrompt],
    ['experience', experiencePrompt],
    ['preference', preferencePrompt],
  ])('%s prompt matches the memory-list schema', (_layer, prompt) => {
    /**
     * @example
     * `{ "memories": [] }` is present while contradictory bare-array instructions are absent.
     */
    expect({
      hasEmptyObjectExample: prompt.includes('{ "memories": [] }'),
      hasMemoryLayerField: prompt.includes('memoryLayer'),
      requestsBareArray: /Return (?:an|a JSON) \*{0,2}array/i.test(prompt),
    }).toEqual({
      hasEmptyObjectExample: true,
      hasMemoryLayerField: false,
      requestsBareArray: false,
    });
  });

  /**
   * @example
   * Identity actions are direct root properties.
   */
  it('matches the identity actions schema', () => {
    /**
     * @example
     * The prompt contains `{ "add": [], "update": [], "remove": [] }` without a wrapper.
     */
    expect({
      hasActionsExample: identityPrompt.includes('{ "add": [], "update": [], "remove": [] }'),
      hasLegacyWrapper: identityPrompt.includes('withIdentities'),
      hasUnexpectedActionsWrapper: identityPrompt.includes('{ "actions":'),
    }).toEqual({
      hasActionsExample: true,
      hasLegacyWrapper: false,
      hasUnexpectedActionsWrapper: false,
    });
  });

  /**
   * @example
   * The model returned `type: "event"` and scores like 7 because the prompt only said `type (string)`.
   */
  it('tells the context extractor the allowed association types and the 0-1 score scale', () => {
    expect({
      listsObjectTypes: contextPrompt.includes(
        `associatedObjects type: ${CONTEXT_OBJECT_TYPES.join(', ')}`,
      ),
      listsSubjectTypes: contextPrompt.includes(
        `associatedSubjects type: ${CONTEXT_SUBJECT_TYPES.join(', ')}`,
      ),
      statesScoreScale: /scoreImpact and scoreUrgency are decimals from 0 to 1/.test(contextPrompt),
    }).toEqual({ listsObjectTypes: true, listsSubjectTypes: true, statesScoreScale: true });
  });
});
