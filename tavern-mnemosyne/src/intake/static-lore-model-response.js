function unwrapProviderToolArguments(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== '$PARAMETER_NAME') {
    return value;
  }
  const wrapped = value[keys[0]];
  return (
    wrapped
    && typeof wrapped === 'object'
    && !Array.isArray(wrapped)
  )
    ? wrapped
    : value;
}

// Providers sometimes emit tool-call arguments whose JSON string literals
// carry an unescaped ASCII double quote from verbatim source text. Escaping
// exactly those quotes is deterministic. Callers still have to validate
// repaired arguments against their own tool contract.
function repairUnescapedJsonStringQuotes(raw) {
  let repaired = '';
  let repairs = 0;
  let inString = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (!inString) {
      inString = character === '"';
      repaired += character;
      continue;
    }
    if (character === '\\') {
      repaired += character + (raw[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character !== '"') {
      repaired += character;
      continue;
    }
    let lookahead = index + 1;
    while (lookahead < raw.length && /\s/u.test(raw[lookahead])) {
      lookahead += 1;
    }
    if (lookahead >= raw.length || /[,}\]:]/u.test(raw[lookahead])) {
      inString = false;
      repaired += character;
      continue;
    }
    repairs += 1;
    repaired += '\\"';
  }
  return { text: repaired, repairs };
}

export function parseModelToolArguments(
  rawArguments,
  { onRepair } = {},
) {
  try {
    return typeof rawArguments === 'string'
      ? JSON.parse(rawArguments)
      : structuredClone(rawArguments);
  } catch (originalError) {
    if (typeof rawArguments === 'string') {
      const repaired = repairUnescapedJsonStringQuotes(rawArguments);
      if (repaired.repairs > 0) {
        try {
          const parsed = JSON.parse(repaired.text);
          onRepair?.(repaired.repairs);
          return parsed;
        } catch {
          // Preserve the original parser error for stable diagnostics.
        }
      }
    }
    throw originalError;
  }
}

export function parseStaticLoreToolArguments(
  rawArguments,
  { onRepair } = {},
) {
  return unwrapProviderToolArguments(parseModelToolArguments(
    rawArguments,
    { onRepair },
  ));
}
