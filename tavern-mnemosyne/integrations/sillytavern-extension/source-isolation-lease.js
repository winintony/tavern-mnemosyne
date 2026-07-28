const AUTHOR_SOURCE_POLICY = 'remove_absorbed_author_source';
const PLACEHOLDER_PREFIX = '\uE000MNEMOSYNE-SOURCE-LEASE:';
const PLACEHOLDER_SUFFIX = ':\uE001';

function isolationError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

function stringMessageContent(message) {
  return typeof message?.content === 'string'
    ? message.content
    : null;
}

function authorizedSourceEntries(promptTrace, internalMessages) {
  const entries = promptTrace?.prompt_manager?.entries;
  if (!Array.isArray(entries) || !Array.isArray(internalMessages)) {
    throw isolationError(
      'host_source_isolation_input_invalid',
      'Source isolation requires a prompt trace and internal messages.',
    );
  }

  return entries
    .filter(entry => (
      entry?.retention_policy === AUTHOR_SOURCE_POLICY
    ))
    .map(entry => {
      const internal = internalMessages[entry.order];
      const content = stringMessageContent(internal);
      if (!Number.isInteger(entry.order) || entry.order < 0) {
        throw isolationError(
          'host_source_isolation_order_invalid',
          'An authorized author source has no internal order.',
        );
      }
      if (!content) {
        throw isolationError(
          'host_source_isolation_content_invalid',
          'An authorized author source has no isolatable text content.',
        );
      }
      if (
        entry?.removal_authorization?.prompt_message_hash
          !== entry.prompt_message_hash
      ) {
        throw isolationError(
          'host_source_isolation_grant_hash_mismatch',
          'An author-source isolation entry no longer matches its grant.',
        );
      }
      return {
        identifier: entry.identifier,
        internal_order: entry.order,
        prompt_message_hash: entry.prompt_message_hash,
        source_label: entry.source_label,
        content,
      };
    });
}

function findOccurrences(messages, content) {
  const occurrences = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const messageContent = stringMessageContent(messages[messageIndex]);
    if (messageContent === null) continue;
    let start = messageContent.indexOf(content);
    while (start >= 0) {
      occurrences.push({
        message_index: messageIndex,
        start,
        end: start + content.length,
      });
      start = messageContent.indexOf(content, start + 1);
    }
  }
  return occurrences;
}

function randomLeaseId(randomUUID) {
  const value = String(randomUUID?.() ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '');
  if (!value) {
    throw isolationError(
      'host_source_isolation_nonce_invalid',
      'Source isolation requires a non-empty random lease id.',
    );
  }
  return value;
}

function assertNoOverlaps(entries) {
  const byMessage = new Map();
  for (const entry of entries) {
    const spans = byMessage.get(entry.message_index) ?? [];
    spans.push(entry);
    byMessage.set(entry.message_index, spans);
  }
  for (const spans of byMessage.values()) {
    spans.sort((left, right) => (
      left.start - right.start
      || left.end - right.end
    ));
    for (let index = 1; index < spans.length; index += 1) {
      if (spans[index].start < spans[index - 1].end) {
        throw isolationError(
          'host_source_isolation_span_overlap',
          'Authorized author-source spans overlap in the host working copy.',
        );
      }
    }
  }
}

function replaceSpans(messages, entries, replacementFor) {
  const result = structuredClone(messages);
  const byMessage = new Map();
  for (const entry of entries) {
    const spans = byMessage.get(entry.message_index) ?? [];
    spans.push(entry);
    byMessage.set(entry.message_index, spans);
  }
  for (const [messageIndex, spans] of byMessage) {
    spans.sort((left, right) => right.start - left.start);
    let content = result[messageIndex].content;
    for (const span of spans) {
      const expected = span.content;
      if (content.slice(span.start, span.end) !== expected) {
        throw isolationError(
          'host_source_isolation_span_drift',
          'An author-source span changed before isolation.',
        );
      }
      content = (
        content.slice(0, span.start)
        + replacementFor(span)
        + content.slice(span.end)
      );
    }
    result[messageIndex].content = content;
  }
  return result;
}

export function createAbsorbedSourceIsolationLease({
  workingMessages,
  internalMessages,
  promptTrace,
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!Array.isArray(workingMessages)) {
    throw isolationError(
      'host_source_isolation_input_invalid',
      'Source isolation requires the host working message array.',
    );
  }
  const sources = authorizedSourceEntries(
    promptTrace,
    internalMessages,
  );
  if (sources.length === 0) {
    return {
      messages: structuredClone(workingMessages),
      lease: null,
    };
  }

  const leaseId = randomLeaseId(randomUUID);
  const sourceEntries = sources.map(source => {
    const occurrences = findOccurrences(
      workingMessages,
      source.content,
    );
    if (occurrences.length !== 1) {
      throw isolationError(
        occurrences.length === 0
          ? 'host_source_isolation_mapping_missing'
          : 'host_source_isolation_mapping_ambiguous',
        'An authorized author source does not map to one working-copy span.',
      );
    }
    const placeholder = (
      `${PLACEHOLDER_PREFIX}${leaseId}:`
      + `${source.internal_order}${PLACEHOLDER_SUFFIX}`
    );
    if (
      workingMessages.some(message => (
        stringMessageContent(message)?.includes(placeholder)
      ))
    ) {
      throw isolationError(
        'host_source_isolation_placeholder_collision',
        'The source-isolation placeholder already exists in the working copy.',
      );
    }
    return {
      ...source,
      ...occurrences[0],
      placeholder,
    };
  });
  assertNoOverlaps(sourceEntries);

  return {
    messages: replaceSpans(
      workingMessages,
      sourceEntries,
      entry => entry.placeholder,
    ),
    lease: Object.freeze({
      schema: 'mnemosyne.host-source-isolation-lease.v1',
      lease_id: leaseId,
      source_entries: Object.freeze(
        sourceEntries.map(entry => Object.freeze({
          ...entry,
        })),
      ),
    }),
  };
}

export function restoreAbsorbedSourceIsolationLease({
  workingMessages,
  lease,
} = {}) {
  if (
    !Array.isArray(workingMessages)
    || lease?.schema
      !== 'mnemosyne.host-source-isolation-lease.v1'
    || !Array.isArray(lease.source_entries)
    || lease.source_entries.length === 0
  ) {
    throw isolationError(
      'host_source_isolation_lease_invalid',
      'Source restoration requires one valid active lease.',
    );
  }

  const restored = structuredClone(workingMessages);
  const restoredEntries = [];
  for (const source of lease.source_entries) {
    const occurrences = findOccurrences(
      restored,
      source.placeholder,
    );
    if (occurrences.length !== 1) {
      throw isolationError(
        occurrences.length === 0
          ? 'host_source_isolation_placeholder_missing'
          : 'host_source_isolation_placeholder_ambiguous',
        'A source-isolation placeholder was not preserved exactly once.',
      );
    }
    const occurrence = occurrences[0];
    const content = restored[occurrence.message_index].content;
    restored[occurrence.message_index].content = (
      content.slice(0, occurrence.start)
      + source.content
      + content.slice(occurrence.end)
    );
    restoredEntries.push({
      identifier: source.identifier,
      internal_order: source.internal_order,
      prompt_message_hash: source.prompt_message_hash,
      source_label: source.source_label,
      provider_index: occurrence.message_index,
      provider_content_start: occurrence.start,
      provider_content_end:
        occurrence.start + source.content.length,
    });
  }

  for (const source of lease.source_entries) {
    if (
      restored.some(message => (
        stringMessageContent(message)?.includes(source.placeholder)
      ))
    ) {
      throw isolationError(
        'host_source_isolation_placeholder_survived',
        'A source-isolation placeholder survived restoration.',
      );
    }
  }

  restoredEntries.sort((left, right) => (
    left.internal_order - right.internal_order
  ));
  return {
    messages: restored,
    receipt: {
      schema: 'mnemosyne.host-source-isolation-receipt.v1',
      status: 'restored',
      source_count: restoredEntries.length,
      sources: restoredEntries,
    },
  };
}
