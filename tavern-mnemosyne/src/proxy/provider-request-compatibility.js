function isDeepSeekV4ThinkingEndpoint({
  endpoint,
  model,
}) {
  let url;
  try {
    url = new URL(String(endpoint ?? ''));
  } catch {
    return false;
  }
  return (
    url.hostname.toLowerCase() === 'api.deepseek.com'
    && /^deepseek-v4-(?:pro|flash)$/i.test(String(model ?? ''))
  );
}

export function createDeepSeekV4ToolCallRetryRequest({
  requestBody,
  endpoint,
  toolChoice,
}) {
  if (!isDeepSeekV4ThinkingEndpoint({
    endpoint,
    model: requestBody?.model,
  })) {
    return null;
  }
  return {
    ...structuredClone(requestBody),
    thinking: { type: 'disabled' },
    tool_choice: (
      toolChoice == null || toolChoice === ''
        ? 'required'
        : structuredClone(toolChoice)
    ),
  };
}

export function adaptOpenAiCompatibleRequest({
  requestBody,
  endpoint,
  requestKind = 'generic',
}) {
  const adapted = structuredClone(requestBody);
  if (isDeepSeekV4ThinkingEndpoint({
    endpoint,
    model: adapted?.model,
  })) {
    // DeepSeek V4 rejects tool_choice in thinking mode. Internal structured
    // extraction does not benefit from hidden reasoning and must reserve its
    // bounded output for the required tool arguments, so explicitly select
    // non-thinking mode before the request is integrity-sealed.
    delete adapted.tool_choice;
    if (requestKind === 'structured_extraction') {
      adapted.thinking = { type: 'disabled' };
    }
  }
  return adapted;
}
