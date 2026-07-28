import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeMessage(message) {
  return {
    role: message?.role ?? null,
    name: message?.name ?? null,
    content: message?.content ?? null,
  };
}

export function hashMessage(message) {
  return sha256(canonicalJson(message));
}

export function hashNormalizedMessage(message) {
  return sha256(canonicalJson(normalizeMessage(message)));
}

export function hashPromptSpine(messages) {
  return sha256(canonicalJson(messages));
}
