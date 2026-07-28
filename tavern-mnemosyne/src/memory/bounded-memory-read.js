import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  canonicalJson,
  sha256,
} from '../contracts/hash.js';
import {
  parseMemoryReference,
} from './memory-reference.js';

const CURSOR_PREFIX = 'memory://continuation/';
const CURSOR_SCHEMA = 'mnemosyne.memory-read-cursor.v2';
const CURSOR_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
export const DEFAULT_MAX_MEMORY_READ_TOKENS = 8_192;
export const MAX_MEMORY_READ_TOKENS = Number.MAX_SAFE_INTEGER;
export const MAX_MEMORY_READ_SELECTOR_LENGTH = 4_096;
export const RETRIEVAL_CONTRACT_VERSION =
  'mnemosyne.retrieval-contract.v2';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function cursorScope(scope) {
  if (
    typeof scope?.chat_id !== 'string'
    || !scope.chat_id
    || typeof scope?.run_id !== 'string'
    || !scope.run_id
    || typeof scope?.branch_id !== 'string'
    || !scope.branch_id
    || !Number.isSafeInteger(scope?.branch_epoch)
    || scope.branch_epoch < 0
    || !Number.isSafeInteger(scope?.turn_index)
    || scope.turn_index < 0
  ) {
    fail(
      'memory_read_cursor_scope_invalid',
      'Memory read continuation cursors require a complete run scope.',
    );
  }
  return {
    chat_id_hash: sha256(scope.chat_id),
    run_id: scope.run_id,
    branch_id: scope.branch_id,
    branch_epoch: scope.branch_epoch,
    turn_index: scope.turn_index,
  };
}

function cursorSecretBytes(cursorSecret) {
  const secret = typeof cursorSecret === 'string'
    ? Buffer.from(cursorSecret, 'utf8')
    : cursorSecret;
  if (!Buffer.isBuffer(secret) || secret.byteLength < 32) {
    fail(
      'memory_read_cursor_secret_invalid',
      'Memory read continuation cursors require a stable signing secret.',
    );
  }
  return secret;
}

function cursorPayload({
  ref,
  nextCodepointOffset,
  memoryHash,
  scope,
  retrievalContractVersion,
}) {
  if (
    typeof retrievalContractVersion !== 'string'
    || !retrievalContractVersion
  ) {
    fail(
      'memory_read_cursor_contract_invalid',
      'Memory read continuation cursors require a retrieval contract version.',
    );
  }
  return {
    schema: CURSOR_SCHEMA,
    retrieval_contract_version: retrievalContractVersion,
    scope: cursorScope(scope),
    ref,
    next_codepoint_offset: nextCodepointOffset,
    memory_hash: memoryHash,
  };
}

function cursorSignature(payload, cursorSecret) {
  return createHmac('sha256', cursorSecretBytes(cursorSecret))
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

function encodeCursor({
  ref,
  nextCodepointOffset,
  memoryHash,
  cursorSecret,
  scope,
  retrievalContractVersion,
}) {
  const payload = cursorPayload({
    ref,
    nextCodepointOffset,
    memoryHash,
    scope,
    retrievalContractVersion,
  });
  return (
    CURSOR_PREFIX
    + Buffer.from(
      canonicalJson({
        payload,
        signature: cursorSignature(payload, cursorSecret),
      }),
      'utf8',
    ).toString('base64url')
  );
}

export function parseMemoryReadSelector(selector, {
  cursorSecret = null,
  scope = null,
  retrievalContractVersion = null,
} = {}) {
  if (
    typeof selector !== 'string'
    || !selector
    || selector.length > MAX_MEMORY_READ_SELECTOR_LENGTH
  ) {
    fail(
      'memory_ref_invalid',
      'Memory read requires a supported memory reference or cursor.',
    );
  }
  if (!selector.startsWith(CURSOR_PREFIX)) {
    if (!parseMemoryReference(selector)) {
      fail(
        'memory_ref_invalid',
        'Memory read requires a supported memory reference or cursor.',
        { ref: selector },
      );
    }
    return {
      selector,
      ref: selector,
      start_codepoint_offset: 0,
      expected_memory_hash: null,
    };
  }

  const encoded = selector.slice(CURSOR_PREFIX.length);
  let envelope;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    envelope = JSON.parse(decoded);
    if (
      Buffer.from(decoded, 'utf8').toString('base64url') !== encoded
    ) {
      throw new Error('cursor encoding is not canonical');
    }
  } catch {
    fail(
      'memory_read_cursor_invalid',
      'Memory read continuation cursor is invalid.',
    );
  }
  const parsed = envelope?.payload;
  const signature = envelope?.signature;
  if (
    !envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',')
      !== ['payload', 'signature'].sort().join(',')
    || !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',')
      !== [
        'memory_hash',
        'next_codepoint_offset',
        'ref',
        'retrieval_contract_version',
        'schema',
        'scope',
      ].sort().join(',')
    || parsed.schema !== CURSOR_SCHEMA
    || parsed.retrieval_contract_version !== retrievalContractVersion
    || canonicalJson(parsed.scope) !== canonicalJson(cursorScope(scope))
    || !parseMemoryReference(parsed.ref)
    || !Number.isSafeInteger(parsed.next_codepoint_offset)
    || parsed.next_codepoint_offset < 0
    || !/^[a-f0-9]{64}$/.test(parsed.memory_hash ?? '')
    || !CURSOR_SIGNATURE_PATTERN.test(signature ?? '')
  ) {
    fail(
      'memory_read_cursor_invalid',
      'Memory read continuation cursor fields are invalid.',
    );
  }
  const expectedSignature = cursorSignature(parsed, cursorSecret);
  if (!timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex'),
  )) {
    fail(
      'memory_read_cursor_invalid',
      'Memory read continuation cursor signature is invalid.',
    );
  }
  return {
    selector,
    ref: parsed.ref,
    start_codepoint_offset: parsed.next_codepoint_offset,
    expected_memory_hash: parsed.memory_hash,
  };
}

function defaultSerializedResultTokenMeasure(result) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function measuredResult(result, measureSerializedResultTokens) {
  const measured = structuredClone(result);
  let usedTokens = 0;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    measured.budget.used_tokens = usedTokens;
    const next = measureSerializedResultTokens(measured);
    if (!Number.isSafeInteger(next) || next < 0) {
      fail(
        'memory_read_budget_measure_invalid',
        'Memory read token measurement must return a non-negative integer.',
      );
    }
    if (next === usedTokens) {
      return { result: measured, usedTokens: next };
    }
    usedTokens = next;
  }
  fail(
    'memory_read_budget_measure_unstable',
    'Memory read token measurement did not reach a stable result.',
  );
}

function contextPack(maxTokens, missingRefs = []) {
  return {
    schema: 'mnemosyne.memory-context-pack.v2',
    entries: [],
    missing_refs: [...new Set(missingRefs)],
    omissions: [],
    continuation_cursors: [],
    budget: {
      requested_tokens: maxTokens,
      accounting: 'final-serialized-tool-result.v1',
      used_tokens: 0,
    },
  };
}

function pagedEntry({
  memory,
  codepoints,
  selector,
  end,
  memoryHash,
  cursorSecret,
  scope,
  retrievalContractVersion,
}) {
  const truncated = end < codepoints.length;
  const nextCursor = truncated
    ? encodeCursor({
        ref: selector.ref,
        nextCodepointOffset: end,
        memoryHash,
        cursorSecret,
        scope,
        retrievalContractVersion,
      })
    : null;
  return {
    entry: {
      ...structuredClone(memory),
      content: codepoints
        .slice(selector.start_codepoint_offset, end)
        .join(''),
      memory_hash: memoryHash,
      content_range: {
        start_codepoint: selector.start_codepoint_offset,
        end_codepoint: end,
        total_codepoints: codepoints.length,
      },
      truncated,
      continuation_cursor: nextCursor,
    },
    nextCursor,
  };
}

export function createBoundedMemoryReadResult({
  selectors,
  readResults,
  maxTokens,
  cursorSecret = null,
  scope = null,
  retrievalContractVersion = null,
  measureSerializedResultTokens = defaultSerializedResultTokenMeasure,
  maxAllowedTokens = DEFAULT_MAX_MEMORY_READ_TOKENS,
} = {}) {
  if (
    !Array.isArray(selectors)
    || !Array.isArray(readResults)
    || selectors.length === 0
    || selectors.length !== readResults.length
    || !Number.isInteger(maxTokens)
    || maxTokens < 1
    || !Number.isSafeInteger(maxAllowedTokens)
    || maxAllowedTokens < 1
    || maxAllowedTokens > MAX_MEMORY_READ_TOKENS
    || maxTokens > maxAllowedTokens
    || typeof measureSerializedResultTokens !== 'function'
  ) {
    fail(
      'memory_read_budget_invalid',
      `Memory read max_tokens must be between 1 and ${maxAllowedTokens}.`,
    );
  }

  const descriptors = [];
  const missingRefs = [];

  for (let index = 0; index < selectors.length; index += 1) {
    const selector = selectors[index];
    const result = readResults[index];
    if (
      !selector
      || typeof selector !== 'object'
      || result?.schema !== 'mnemosyne.memory-read-result.v2'
      || !['ready', 'unavailable'].includes(result.status)
      || result?.ref !== selector.ref
    ) {
      fail(
        'memory_read_result_invalid',
        'Memory read result does not match its requested selector.',
      );
    }
    if (result.status !== 'ready') {
      missingRefs.push(selector.ref);
      continue;
    }

    const memory = result.memory;
    const content = String(memory?.content ?? '');
    const memoryHash = sha256(canonicalJson(memory));
    const codepoints = Array.from(content);
    if (
      selector.expected_memory_hash !== null
      && selector.expected_memory_hash !== memoryHash
    ) {
      fail(
        'memory_read_cursor_stale',
        'Memory changed after the continuation cursor was issued.',
        { ref: selector.ref },
      );
    }
    if (selector.start_codepoint_offset > codepoints.length) {
      fail(
        'memory_read_cursor_invalid',
        'Memory read cursor points outside the active memory body.',
        { ref: selector.ref },
      );
    }
    descriptors.push({
      selector,
      memory,
      memoryHash,
      codepoints,
    });
  }

  let sealed = measuredResult(
    contextPack(maxTokens, missingRefs),
    measureSerializedResultTokens,
  );
  if (sealed.usedTokens > maxTokens) {
    fail(
      'memory_read_budget_too_small',
      'Memory read budget cannot fit the result envelope.',
      { minimum_required_tokens: sealed.usedTokens },
    );
  }

  for (const descriptor of descriptors) {
    const {
      selector,
      memory,
      memoryHash,
      codepoints,
    } = descriptor;
    const start = selector.start_codepoint_offset;
    let low = codepoints.length === start ? start : start + 1;
    let high = codepoints.length;
    let best = null;

    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const page = pagedEntry({
        memory,
        codepoints,
        selector,
        end,
        memoryHash,
        cursorSecret,
        scope,
        retrievalContractVersion,
      });
      const candidate = structuredClone(sealed.result);
      candidate.entries.push(page.entry);
      if (page.nextCursor) {
        candidate.continuation_cursors.push(page.nextCursor);
      }
      const measured = measuredResult(
        candidate,
        measureSerializedResultTokens,
      );
      if (measured.usedTokens <= maxTokens) {
        best = measured;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }

    if (best === null) {
      if (sealed.result.entries.length > 0) {
        const omitted = structuredClone(sealed.result);
        omitted.omissions.push({
          ref: selector.ref,
          reason_code: 'memory_read_budget_exhausted',
        });
        const measuredOmission = measuredResult(
          omitted,
          measureSerializedResultTokens,
        );
        if (measuredOmission.usedTokens <= maxTokens) {
          sealed = measuredOmission;
        }
        continue;
      }
      fail(
        'memory_read_budget_too_small',
        'Memory read budget cannot fit the next bounded memory entry.',
        {
          ref: selector.ref,
          start_codepoint_offset: selector.start_codepoint_offset,
        },
      );
    }
    sealed = best;
  }

  return sealed.result;
}
