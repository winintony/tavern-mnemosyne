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

export function adaptOpenAiCompatibleRequest({
  requestBody,
  endpoint,
}) {
  const adapted = structuredClone(requestBody);
  if (isDeepSeekV4ThinkingEndpoint({
    endpoint,
    model: adapted?.model,
  })) {
    // DeepSeek V4 thinking mode supports tools but rejects tool_choice.
    // Apply this before the request is hashed, budgeted, or capability-sealed.
    delete adapted.tool_choice;
  }
  return adapted;
}
