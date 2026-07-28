import path from 'node:path';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import { serializeOkfConcept } from '../okf/bundle.js';
import {
  OKF_ENTITY_PREFIXES,
  OKF_TYPE_DIRECTORIES,
} from '../okf/schema.js';
import {
  canonicalTypedRecordEntityRef,
  isCanonicalTypedRecordKind,
  validateCanonicalTypedPayload,
} from './typed-turn-delta.js';

export const CANONICAL_DYNAMIC_WRITER_OWNER =
  'mnemosyne.memory-writer.v1';

const OKF_ENTITY_REF_PATTERN =
  /^okf:\/\/entity\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function isCanonicalDynamicRecordKind(recordKind) {
  return isCanonicalTypedRecordKind(recordKind);
}

export function canonicalDynamicEntityRef({
  recordKind,
  turnId,
  candidateId,
  sequenceIndex,
} = {}) {
  return canonicalTypedRecordEntityRef({
    recordKind,
    turnId,
    candidateId,
    sequenceIndex,
  });
}

function quoteBlock(value) {
  return String(value)
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function listSection(title, values) {
  return [
    `# ${title}`,
    '',
    ...(values.length === 0
      ? ['_None recorded._']
      : values.map(value => `- \`${value}\``)),
  ];
}

export function compileCanonicalDynamicConcept({
  recordId,
  record,
  patchId,
  turnIndex,
  turnId,
  candidateId,
  committedAt,
  sequenceIndex,
  authorityEdit = null,
} = {}) {
  if (
    !isCanonicalDynamicRecordKind(record?.kind)
    || typeof recordId !== 'string'
    || !recordId
    || typeof patchId !== 'string'
    || !patchId
    || !Number.isInteger(turnIndex)
    || turnIndex < 0
    || typeof turnId !== 'string'
    || !turnId
    || typeof candidateId !== 'string'
    || !candidateId
    || typeof committedAt !== 'string'
    || !committedAt
    || !Number.isInteger(sequenceIndex)
    || sequenceIndex < 0
  ) {
    throw new Error('Canonical dynamic concept input is invalid.');
  }
  const entityMatch = record.entity_ref?.match(OKF_ENTITY_REF_PATTERN);
  const entityId = entityMatch?.[1] ?? null;
  const expectedPrefix = `${OKF_ENTITY_PREFIXES[record.kind]}_`;
  const expectedEntityRef = canonicalDynamicEntityRef({
    recordKind: record.kind,
    turnId,
    candidateId,
    sequenceIndex,
  });
  const authorityEditValid = authorityEdit === null || (
    typeof authorityEdit === 'object'
    && !Array.isArray(authorityEdit)
    && typeof authorityEdit.edit_id === 'string'
    && authorityEdit.edit_id
    && authorityEdit.base_entity_ref === record.entity_ref
    && record.source_ref.startsWith('edit://')
  );
  if (
    !entityId
    || !entityId.startsWith(expectedPrefix)
    || !authorityEditValid
    || (
      authorityEdit === null
      && record.entity_ref !== expectedEntityRef
    )
    || typeof record.source_ref !== 'string'
    || !record.source_ref
    || typeof record.source_span?.quote !== 'string'
    || !record.source_span.quote
  ) {
    throw new Error('Canonical dynamic record identity is invalid.');
  }

  const digest = entityId.slice(expectedPrefix.length);
  if (record.kind !== 'scene_event') {
    const payload = validateCanonicalTypedPayload({
      recordKind: record.kind,
      payload: record.payload,
      sequenceIndex,
    });
    const slug = [
      'turn',
      record.kind.replaceAll('_', '-'),
      digest,
    ].join('-');
    const relativePath = path.posix.join(
      'story-memory',
      OKF_TYPE_DIRECTORIES[record.kind],
      `${slug}.md`,
    );
    const conceptRelativePath = relativePath.slice(
      'story-memory/'.length,
    );
    const label = record.kind
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    const subjectRef = (
      payload.subject_ref
      ?? payload.owner_ref
      ?? payload.relationship_ref
      ?? payload.thread_ref
      ?? payload.scene_ref
      ?? null
    );
    const frontmatter = {
      type: record.kind,
      title: `${label} · Turn ${turnIndex}`,
      timestamp: committedAt,
      entity_id: entityId,
      slug,
      aliases: [],
      status: 'active',
      source_refs: [record.source_ref],
      links: [],
      no_links_reason:
        'Typed entity refs remain explicit until readable OKF paths are resolved.',
      canonical_writer_owner: CANONICAL_DYNAMIC_WRITER_OWNER,
      record_id: recordId,
      record_kind: record.kind,
      turn_id: turnId,
      candidate_id: candidateId,
      patch_id: patchId,
      support_strength: record.source_span.support_strength,
      ...(authorityEdit === null
        ? {}
        : {
            authority_edit_id: authorityEdit.edit_id,
            provenance: 'user_edit',
          }),
      ...(subjectRef === null ? {} : { subject_ref: subjectRef }),
      typed_payload: structuredClone(payload),
    };
    const body = [
      '# Recorded Change',
      '',
      record.summary,
      '',
      '# Typed Fields',
      '',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
      '',
      '# Evidence',
      '',
      quoteBlock(record.source_span.quote),
      '',
      `Source: \`${record.source_ref}\``,
    ].join('\n');
    const document = serializeOkfConcept({ frontmatter, body });
    const versionHash = sha256(document);
    return {
      recordId,
      entityId,
      patchId,
      sequenceIndex,
      relativePath,
      conceptRelativePath,
      document,
      versionHash,
      contractHash: sha256(canonicalJson({
        record_id: recordId,
        entity_id: entityId,
        relative_path: conceptRelativePath,
        version_hash: versionHash,
        patch_id: patchId,
      })),
    };
  }

  if (!record.event) {
    throw new Error('Canonical scene event payload is invalid.');
  }
  const slug = `turn-event-${digest}`;
  const relativePath = path.posix.join(
    'story-memory',
    OKF_TYPE_DIRECTORIES.scene_event,
    `${slug}.md`,
  );
  const conceptRelativePath = relativePath.slice(
    'story-memory/'.length,
  );
  const frontmatter = {
    type: 'scene_event',
    title: `Scene Event · Turn ${turnIndex}`,
    timestamp: committedAt,
    entity_id: entityId,
    slug,
    aliases: [],
    status: 'active',
    source_refs: [record.source_ref],
    links: [],
    no_links_reason:
      'Entity refs remain explicit until their readable OKF paths are resolved.',
    canonical_writer_owner: CANONICAL_DYNAMIC_WRITER_OWNER,
    record_id: recordId,
    record_kind: record.kind,
    turn_id: turnId,
    candidate_id: candidateId,
    patch_id: patchId,
    support_strength: record.source_span.support_strength,
    ...(authorityEdit === null
      ? {}
      : {
          authority_edit_id: authorityEdit.edit_id,
          provenance: 'user_edit',
        }),
    what_happened: record.event.what_happened,
    participants: structuredClone(record.event.participants),
    story_time: record.event.story_time,
    location_ref: record.event.location_ref,
    outcome: record.event.outcome,
    causes: structuredClone(record.event.causes),
    consequences: structuredClone(record.event.consequences),
    ...(Object.hasOwn(record.event, 'beat_type')
      ? {
          beat_type: record.event.beat_type,
          scene_turn: structuredClone(record.event.scene_turn),
        }
      : {}),
  };
  const body = [
    '# What Happened',
    '',
    record.event.what_happened,
    '',
    '# Outcome',
    '',
    record.event.outcome,
    '',
    ...listSection('Participants', record.event.participants),
    '',
    '# Story Time',
    '',
    record.event.story_time,
    '',
    '# Location',
    '',
    record.event.location_ref === null
      ? '_No stable location ref recorded._'
      : `\`${record.event.location_ref}\``,
    '',
    ...listSection('Causes', record.event.causes),
    '',
    ...listSection('Consequences', record.event.consequences),
    '',
    '# Evidence',
    '',
    quoteBlock(record.source_span.quote),
    '',
    `Source: \`${record.source_ref}\``,
  ].join('\n');
  const document = serializeOkfConcept({ frontmatter, body });
  return {
    recordId,
    entityId,
    patchId,
    sequenceIndex,
    relativePath,
    conceptRelativePath,
    document,
    versionHash: sha256(document),
    contractHash: sha256(canonicalJson({
      record_id: recordId,
      entity_id: entityId,
      relative_path: conceptRelativePath,
      version_hash: sha256(document),
      patch_id: patchId,
    })),
  };
}
