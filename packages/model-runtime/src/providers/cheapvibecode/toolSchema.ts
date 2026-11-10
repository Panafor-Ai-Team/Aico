import type { ChatCompletionTool } from '../../types/chat';

/**
 * Some CVC models (verified on `mimo-v2.6-pro`) emit tool calls in a text
 * format, and the gateway converts each top-level parameter to JSON by its
 * declared `type`. A list type such as `["string", "null"]` breaks that
 * conversion: the arguments arrive cut off at `{"details": ` and the whole call
 * leaks into `content` as `<tool_call><function=…><parameter=…>` text, so no
 * tool runs. A plain `"string"` on the same tool converts cleanly.
 *
 * So a top-level `[T, "null"]` is sent as `T`. Losing `null` is harmless: the
 * model can still omit the field, and the tool's own schema still accepts null
 * when its arguments are validated. Nested schemas are left alone because the
 * gateway passes nested values through as JSON (a nested `[T, "null"]` was
 * observed converting fine), and other unions are left alone because none was
 * tested.
 */
const collapseNullableType = (schema: unknown): unknown => {
  if (!schema || typeof schema !== 'object') return schema;
  const { type } = schema as { type?: unknown };
  if (!Array.isArray(type) || !type.includes('null')) return schema;

  const nonNull = type.filter((t) => t !== 'null');
  if (nonNull.length !== 1) return schema;

  return { ...schema, type: nonNull[0] };
};

export const collapseNullableParameterTypes = (
  tools: ChatCompletionTool[] | undefined,
): ChatCompletionTool[] | undefined =>
  tools?.map((tool) => {
    const parameters = tool.function?.parameters as
      { properties?: Record<string, unknown> } | undefined;
    if (!parameters?.properties) return tool;

    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          properties: Object.fromEntries(
            Object.entries(parameters.properties).map(([key, value]) => [
              key,
              collapseNullableType(value),
            ]),
          ),
        },
      },
    };
  });
