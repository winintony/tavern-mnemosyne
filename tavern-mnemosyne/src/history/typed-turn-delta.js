import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { parseMemoryScopeReference } from '../memory/memory-reference.js';
import { OKF_ENTITY_PREFIXES } from '../okf/schema.js';
import {
  isCommittedBodySegmentRef,
  resolveCommittedBodySegmentRef,
} from './committed-body-segments.js';

const SOURCE_MODES = new Set(['narration', 'dialogue', 'mixed']);
const ENTITY_REF_PATTERN = /^okf:\/\/entity\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PROVIDER_CORRECTION_ISSUES = 16;
const CORRECTION_FIELD_PATH_PATTERN = (
  /^records\[\d+\](?:\.[A-Za-z][A-Za-z0-9_]*|\[\d+\])+$/
);
const CORRECTION_ACTIONS = new Set([
  'replace_with_expected_enum',
  'replace_with_unique_exact_committed_body_span',
  'use_published_committed_body_segment_ref',
  'use_trusted_canonical_ref',
]);
const EVIDENCE_QUOTE_WRAPPERS = new Map([
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]);

export const CANONICAL_TYPED_RECORD_KINDS = Object.freeze([
  'character',
  'character_cognition',
  'relationship',
  'scene_event',
  'world_lore',
  'plot_thread',
  'scene_state',
]);

const CANONICAL_TYPED_RECORD_KIND_SET = new Set(
  CANONICAL_TYPED_RECORD_KINDS,
);

// M-D2 craft field batch: language-neutral stable beat codes. Display labels
// are an i18n concern; this closed list is the ledger vocabulary.
export const BEAT_TYPES = Object.freeze([
  'conflict',
  'revelation',
  'chase',
  'escape',
  'reconciliation',
  'quiet_moment',
  'decision',
  'setback',
  'intimacy',
  'suspense_hook',
  'negotiation',
  'other',
]);
const BEAT_TYPE_SET = new Set(BEAT_TYPES);
export const SCENE_TURN_NULL_SCENE = 'null_scene';
export const SCENE_TURN_POLARITIES = Object.freeze([
  'positive',
  'negative',
]);

const COMMITTED_BODY_EVIDENCE_SCHEMA = Object.freeze({
  type: 'array',
  minItems: 1,
  maxItems: 1,
  items: {
    type: 'object',
    additionalProperties: false,
    required: [
      'source_kind',
      'quote_or_ref',
      'source_mode',
      'support_strength',
    ],
    properties: {
      source_kind: {
        type: 'string',
        enum: ['committed_body'],
      },
      quote_or_ref: {
        type: 'string',
        minLength: 1,
        description: (
          'Prefer one ref from the current story_commit segment_directory. '
          + 'A legacy unique exact quote from the committed body is also valid.'
        ),
      },
      source_mode: {
        type: 'string',
        enum: ['narration', 'dialogue', 'mixed'],
      },
      support_strength: {
        type: 'string',
        enum: ['explicit'],
      },
    },
  },
});

const SCENE_EVENT_EVIDENCE_SCHEMA = Object.freeze({
  ...COMMITTED_BODY_EVIDENCE_SCHEMA,
  items: {
    ...COMMITTED_BODY_EVIDENCE_SCHEMA.items,
    properties: {
      ...COMMITTED_BODY_EVIDENCE_SCHEMA.items.properties,
      source_mode: {
        type: 'string',
        enum: ['narration'],
      },
    },
  },
});

const ENTITY_REF_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^okf://entity/[A-Za-z0-9][A-Za-z0-9._-]*$',
});
const SCENE_REF_SCHEMA = Object.freeze({
  anyOf: [
    ENTITY_REF_SCHEMA,
    {
      type: 'string',
      pattern: '^mnemosyne://chat/[^/]+/active-scene$',
      description: (
        'The canonical active-scene ref from this run Continuity Payload. '
        + 'The runtime rejects refs belonging to another chat.'
      ),
    },
  ],
});
const NULLABLE_ENTITY_REF_SCHEMA = Object.freeze({
  anyOf: [
    ENTITY_REF_SCHEMA,
    { type: 'null' },
  ],
});
const STRING_ARRAY_SCHEMA = Object.freeze({
  type: 'array',
  maxItems: 32,
  items: { type: 'string', minLength: 1 },
});
const ENTITY_REF_ARRAY_SCHEMA = Object.freeze({
  type: 'array',
  maxItems: 32,
  items: ENTITY_REF_SCHEMA,
});
const NULLABLE_STRING_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'string', minLength: 1 },
    { type: 'null' },
  ],
});
const NULLABLE_SCORE_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'number', minimum: -1, maximum: 1 },
    { type: 'null' },
  ],
});
const ATTRIBUTE_VALUE_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    {
      type: 'array',
      maxItems: 32,
      items: { type: 'string' },
    },
  ],
});
const TRACKED_ITEM_VALUE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'item_ref',
    'label',
    'quantity',
    'unit',
    'affordances',
    'visibility',
    'salience',
    'expires_if',
  ],
  properties: {
    item_ref: NULLABLE_ENTITY_REF_SCHEMA,
    label: { type: 'string', minLength: 1 },
    quantity: {
      anyOf: [
        { type: 'number' },
        { type: 'null' },
      ],
    },
    unit: NULLABLE_STRING_SCHEMA,
    affordances: STRING_ARRAY_SCHEMA,
    visibility: {
      type: 'string',
      enum: ['public', 'private', 'hidden', 'unknown'],
    },
    salience: {
      type: 'string',
      enum: ['ambient', 'latent', 'medium', 'high'],
    },
    expires_if: NULLABLE_STRING_SCHEMA,
  },
});
const CURRENT_STATE_VALUE_SCHEMA = Object.freeze({
  anyOf: [
    ...ATTRIBUTE_VALUE_SCHEMA.anyOf,
    TRACKED_ITEM_VALUE_SCHEMA,
    { type: 'null' },
  ],
});
const BEAT_TYPE_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'string', enum: [...BEAT_TYPES] },
    { type: 'null' },
  ],
  description:
    'Closed beat vocabulary for rhythm accounting; null means unlabeled.',
});
const SCENE_TURN_SCHEMA = Object.freeze({
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['core_state', 'polarity'],
      properties: {
        core_state: { type: 'string', minLength: 1 },
        polarity: {
          type: 'string',
          enum: [...SCENE_TURN_POLARITIES],
        },
      },
    },
    { type: 'string', enum: [SCENE_TURN_NULL_SCENE] },
    { type: 'null' },
  ],
  description:
    'The core state this scene changed with its polarity; '
    + `"${SCENE_TURN_NULL_SCENE}" declares no state change; `
    + 'null means unlabeled.',
});
const DUE_BY_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'integer', minimum: 0 },
    { type: 'null' },
  ],
  description:
    'Turn-index deadline for this obligation; null means no deadline.',
});
const OBLIGATION_SALIENCE_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'integer', minimum: 1, maximum: 3 },
    { type: 'null' },
  ],
  description: 'Declared importance 1-3; null means undeclared.',
});

function recordSchema(kind, required, properties, {
  evidence = COMMITTED_BODY_EVIDENCE_SCHEMA,
  includeSummary = true,
} = {}) {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'kind',
      ...required,
      ...(includeSummary ? ['summary'] : []),
      'evidence',
    ],
    properties: {
      kind: { type: 'string', enum: [kind] },
      ...properties,
      ...(includeSummary
        ? { summary: { type: 'string', minLength: 1 } }
        : {}),
      evidence,
    },
  });
}

export const PROVIDER_TYPED_RECORD_SCHEMAS = Object.freeze([
  recordSchema('current_state', [
    'entity_ref',
    'state_domain',
    'state_key',
    'value',
    'operation',
  ], {
    entity_ref: ENTITY_REF_SCHEMA,
    state_domain: { type: 'string', minLength: 1 },
    state_key: { type: 'string', minLength: 1 },
    value: CURRENT_STATE_VALUE_SCHEMA,
    operation: { type: 'string', enum: ['set', 'unset'] },
  }),
  recordSchema('attribute_value', [
    'subject_ref',
    'attribute_id',
    'value',
  ], {
    subject_ref: ENTITY_REF_SCHEMA,
    attribute_id: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$',
    },
    value: ATTRIBUTE_VALUE_SCHEMA,
  }),
  recordSchema('character', [
    'subject_ref',
    'change_kind',
    'value',
  ], {
    subject_ref: ENTITY_REF_SCHEMA,
    change_kind: {
      type: 'string',
      enum: [
        'appearance',
        'personality',
        'voice',
        'values',
        'desires',
        'fears',
        'abilities',
        'background',
        'current_presentation',
        'arc_state',
      ],
    },
    value: { type: 'string', minLength: 1 },
  }),
  recordSchema('character_cognition', [
    'owner_ref',
    'about_ref',
    'record_kind',
    'knowledge_state',
    'subjective_content',
    'perceived_via',
    'salience',
    'fidelity',
    'recall_cues',
  ], {
    owner_ref: ENTITY_REF_SCHEMA,
    about_ref: NULLABLE_ENTITY_REF_SCHEMA,
    record_kind: {
      type: 'string',
      enum: [
        'knowledge_state',
        'memory',
        'belief',
        'misunderstanding',
        'perception',
        'intention',
      ],
    },
    knowledge_state: {
      anyOf: [
        {
          type: 'string',
          enum: [
            'knows',
            'believes',
            'suspects',
            'misunderstands',
            'does_not_know',
            'intends',
          ],
        },
        { type: 'null' },
      ],
    },
    subjective_content: { type: 'string', minLength: 1 },
    perceived_via: { type: 'string', minLength: 1 },
    salience: {
      type: 'string',
      enum: ['ambient', 'low', 'medium', 'high'],
    },
    fidelity: {
      type: 'string',
      enum: ['exact', 'gist', 'distorted', 'uncertain'],
    },
    recall_cues: STRING_ARRAY_SCHEMA,
  }),
  recordSchema('relationship', [
    'relationship_ref',
    'endpoints',
    'relation_kind',
    'public_status',
    'private_status',
    'trust',
    'intimacy',
    'tension',
    'debt',
    'hidden_feelings',
    'current_direction',
  ], {
    relationship_ref: ENTITY_REF_SCHEMA,
    endpoints: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: ENTITY_REF_SCHEMA,
    },
    relation_kind: { type: 'string', minLength: 1 },
    public_status: NULLABLE_STRING_SCHEMA,
    private_status: NULLABLE_STRING_SCHEMA,
    trust: NULLABLE_SCORE_SCHEMA,
    intimacy: NULLABLE_SCORE_SCHEMA,
    tension: NULLABLE_SCORE_SCHEMA,
    debt: NULLABLE_STRING_SCHEMA,
    hidden_feelings: NULLABLE_STRING_SCHEMA,
    current_direction: {
      type: 'string',
      enum: [
        'warming',
        'cooling',
        'escalating',
        'stabilizing',
        'fracturing',
        'unknown',
      ],
    },
  }),
  recordSchema('scene_event', [
    'what_happened',
    'participants',
    'story_time',
    'location_ref',
    'outcome',
    'causes',
    'consequences',
    'beat_type',
    'scene_turn',
  ], {
    what_happened: { type: 'string', minLength: 1 },
    participants: {
      ...ENTITY_REF_ARRAY_SCHEMA,
      minItems: 1,
      maxItems: 16,
    },
    story_time: { type: 'string', minLength: 1 },
    location_ref: NULLABLE_ENTITY_REF_SCHEMA,
    outcome: { type: 'string', minLength: 1 },
    causes: STRING_ARRAY_SCHEMA,
    consequences: STRING_ARRAY_SCHEMA,
    beat_type: BEAT_TYPE_SCHEMA,
    scene_turn: SCENE_TURN_SCHEMA,
  }, {
    evidence: SCENE_EVENT_EVIDENCE_SCHEMA,
    includeSummary: false,
  }),
  recordSchema('world_lore', [
    'subject_ref',
    'lore_kind',
    'scope',
    'rule_or_fact',
    'constraints',
    'exceptions',
    'static_or_dynamic',
    'priority',
  ], {
    subject_ref: ENTITY_REF_SCHEMA,
    lore_kind: {
      type: 'string',
      enum: [
        'location',
        'rule',
        'culture',
        'faction',
        'item',
        'artifact',
        'ability_system',
        'technology',
        'other',
      ],
    },
    scope: { type: 'string', minLength: 1 },
    rule_or_fact: { type: 'string', minLength: 1 },
    constraints: STRING_ARRAY_SCHEMA,
    exceptions: STRING_ARRAY_SCHEMA,
    static_or_dynamic: {
      type: 'string',
      enum: ['static', 'dynamic'],
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'critical'],
    },
  }),
  recordSchema('plot_thread', [
    'thread_ref',
    'thread_kind',
    'status',
    'stakes',
    'open_question',
    'setup_refs',
    'blockers',
    'payoff_conditions',
    'current_pressure',
    'due_by',
    'salience',
  ], {
    thread_ref: ENTITY_REF_SCHEMA,
    thread_kind: {
      type: 'string',
      enum: [
        'promise',
        'mystery',
        'threat',
        'conflict',
        'goal',
        'foreshadowing',
        'open_question',
      ],
    },
    status: {
      type: 'string',
      enum: ['open', 'blocked', 'progressing', 'resolved', 'failed'],
    },
    stakes: { type: 'string', minLength: 1 },
    open_question: NULLABLE_STRING_SCHEMA,
    setup_refs: ENTITY_REF_ARRAY_SCHEMA,
    blockers: STRING_ARRAY_SCHEMA,
    payoff_conditions: STRING_ARRAY_SCHEMA,
    current_pressure: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'critical'],
    },
    due_by: DUE_BY_SCHEMA,
    salience: OBLIGATION_SALIENCE_SCHEMA,
  }),
  recordSchema('scene_state', [
    'scene_ref',
    'time',
    'location_ref',
    'participants',
    'positions',
    'props',
    'local_constraints',
    'mood',
    'beat_type',
    'scene_turn',
  ], {
    scene_ref: SCENE_REF_SCHEMA,
    time: { type: 'string', minLength: 1 },
    location_ref: NULLABLE_ENTITY_REF_SCHEMA,
    participants: ENTITY_REF_ARRAY_SCHEMA,
    positions: STRING_ARRAY_SCHEMA,
    props: STRING_ARRAY_SCHEMA,
    local_constraints: STRING_ARRAY_SCHEMA,
    mood: { type: 'string', minLength: 1 },
    beat_type: BEAT_TYPE_SCHEMA,
    scene_turn: SCENE_TURN_SCHEMA,
  }),
]);

const PROVIDER_KIND_SCHEMAS = new Map(
  PROVIDER_TYPED_RECORD_SCHEMAS.map(schema => [
    schema.properties.kind.enum[0],
    schema,
  ]),
);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function assertExactKeys(value, keys, {
  recordIndex,
  label,
}) {
  if (
    !isObject(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))
  ) {
    fail(
      'turn_delta_record_invalid',
      `${label} has missing or unexpected fields.`,
      { record_index: recordIndex },
    );
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function entityRef(value) {
  return typeof value === 'string' && ENTITY_REF_PATTERN.test(value);
}

function sceneRef(value, {
  chatId,
  enforceActiveSceneChat = false,
} = {}) {
  if (entityRef(value)) return true;
  const parsed = parseMemoryScopeReference(value);
  if (parsed?.kind !== 'active_scene_scope') return false;
  return !enforceActiveSceneChat || (
    nonEmptyString(chatId)
    && parsed.chatId === chatId
  );
}

function stringArray(value, {
  min = 0,
  max = 32,
} = {}) {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(nonEmptyString);
}

function entityRefArray(value, options) {
  return stringArray(value, options) && value.every(entityRef);
}

function nullableString(value) {
  return value === null || nonEmptyString(value);
}

function nullableScore(value) {
  return value === null
    || (
      typeof value === 'number'
      && Number.isFinite(value)
      && value >= -1
      && value <= 1
    );
}

function nullableBeatType(value) {
  return value === null || BEAT_TYPE_SET.has(value);
}

function sceneTurnValue(value) {
  if (value === null || value === SCENE_TURN_NULL_SCENE) return true;
  return (
    isObject(value)
    && Object.keys(value).length === 2
    && nonEmptyString(value.core_state)
    && SCENE_TURN_POLARITIES.includes(value.polarity)
  );
}

function nullableDueBy(value) {
  return value === null
    || (Number.isInteger(value) && value >= 0);
}

function nullableObligationSalience(value) {
  return value === null || [1, 2, 3].includes(value);
}

// M-D2 craft field batch compatibility: records and canonical payloads sealed
// before this batch may have no craft keys. Only normalized-artifact validation
// accepts that legacy all-absent shape so replay can preserve recorded bytes.
// Live provider intake is strict and must supply every required craft key,
// including an explicit null when the model abstains from labeling it.
const CRAFT_FIELD_KEYS = new Map([
  ['plot_thread', Object.freeze(['due_by', 'salience'])],
  ['scene_event', Object.freeze(['beat_type', 'scene_turn'])],
  ['scene_state', Object.freeze(['beat_type', 'scene_turn'])],
]);

export function craftFieldKeysFor(recordKind) {
  return CRAFT_FIELD_KEYS.get(recordKind) ?? [];
}

function serializableJson(value, recordIndex) {
  try {
    canonicalJson(value);
  } catch {
    fail(
      'turn_delta_record_invalid',
      'Typed record values must be JSON serializable.',
      { record_index: recordIndex },
    );
  }
}

export function isCanonicalTypedRecordKind(recordKind) {
  return CANONICAL_TYPED_RECORD_KIND_SET.has(recordKind);
}

export function canonicalTypedRecordEntityRef({
  recordKind,
  turnId,
  candidateId,
  sequenceIndex,
} = {}) {
  if (
    !isCanonicalTypedRecordKind(recordKind)
    || !nonEmptyString(turnId)
    || !nonEmptyString(candidateId)
    || !Number.isInteger(sequenceIndex)
    || sequenceIndex < 0
  ) {
    throw new Error('Canonical typed record identity input is invalid.');
  }
  const prefix = OKF_ENTITY_PREFIXES[recordKind];
  const digest = sha256(canonicalJson({
    turn_id: turnId,
    candidate_id: candidateId,
    sequence_index: sequenceIndex,
    kind: recordKind,
  })).slice(0, 24);
  return `okf://entity/${prefix}_${digest}`;
}

function validateProviderRecord(record, recordIndex) {
  const kind = record?.kind;
  const schema = PROVIDER_KIND_SCHEMAS.get(kind);
  if (!schema) {
    fail(
      'unsupported_claim',
      'The requested memory record kind is not supported.',
      { record_index: recordIndex, kind: kind ?? null },
    );
  }
  assertExactKeys(record, schema.required, {
    recordIndex,
    label: kind,
  });
  if (
    Object.hasOwn(schema.properties, 'summary')
    && !nonEmptyString(record.summary)
  ) {
    fail(
      'turn_delta_record_invalid',
      'Typed record summary must be non-empty.',
      { record_index: recordIndex },
    );
  }
  return kind;
}

function normalizeEvidenceQuote(quote, committedBody) {
  if (committedBody.includes(quote) || quote.length < 3) {
    return quote;
  }
  const expectedClosing = EVIDENCE_QUOTE_WRAPPERS.get(quote[0]);
  if (expectedClosing !== quote.at(-1)) return quote;
  const unwrapped = quote.slice(1, -1);
  return committedBody.includes(unwrapped) ? unwrapped : quote;
}

function evidenceSpan(
  record,
  committedBody,
  recordIndex,
  {
    committedBodyCommitId = null,
    committedBodyHash = null,
    committedBodySegmentDirectory = null,
  } = {},
) {
  if (
    !Array.isArray(record.evidence)
    || record.evidence.length !== 1
  ) {
    fail(
      'unsupported_claim',
      'Each changed record needs exactly one committed-body evidence item.',
      { record_index: recordIndex },
    );
  }
  const evidence = record.evidence[0];
  assertExactKeys(evidence, [
    'source_kind',
    'quote_or_ref',
    'source_mode',
    'support_strength',
  ], {
    recordIndex,
    label: 'Committed-body evidence',
  });
  if (
    evidence.source_kind !== 'committed_body'
    || !nonEmptyString(evidence.quote_or_ref)
    || !SOURCE_MODES.has(evidence.source_mode)
    || evidence.support_strength !== 'explicit'
  ) {
    fail(
      'turn_delta_record_invalid',
      'Committed-body evidence is invalid.',
      { record_index: recordIndex },
    );
  }
  if (
    record.kind === 'scene_event'
    && evidence.source_mode !== 'narration'
  ) {
    fail(
      'turn_delta_event_invalid',
      'scene_event evidence must be objective narration.',
      {
        record_index: recordIndex,
        field_path:
          `records[${recordIndex}].evidence[0].source_mode`,
        expected: 'narration',
        action: 'replace_with_expected_enum',
      },
    );
  }
  const segmentRefCandidate = (
    evidence.quote_or_ref.startsWith(
      'mnemosyne://committed-body-segment/',
    )
  );
  if (segmentRefCandidate) {
    let segment = null;
    try {
      if (isCommittedBodySegmentRef(evidence.quote_or_ref)) {
        segment = resolveCommittedBodySegmentRef({
          directory: committedBodySegmentDirectory,
          body: committedBody,
          ref: evidence.quote_or_ref,
          commitId: committedBodyCommitId,
          bodyHash: committedBodyHash,
        });
      }
    } catch {
      fail(
        'turn_delta_record_invalid',
        'The committed-body segment directory is not valid for this locked body.',
        {
          record_index: recordIndex,
          field_path:
            `records[${recordIndex}].evidence[0].quote_or_ref`,
          action:
            'use_published_committed_body_segment_ref',
        },
      );
    }
    if (!segment) {
      fail(
        'unsupported_claim',
        'The committed-body segment ref is not published by this story commit.',
        {
          record_index: recordIndex,
          field_path:
            `records[${recordIndex}].evidence[0].quote_or_ref`,
          action:
            'use_published_committed_body_segment_ref',
        },
      );
    }
    return {
      start: segment.start,
      end: segment.end,
      quote: segment.text,
      source_mode: evidence.source_mode,
      support_strength: evidence.support_strength,
    };
  }
  const quote = normalizeEvidenceQuote(
    evidence.quote_or_ref,
    committedBody,
  );
  const quoteCorrectionAction = committedBodySegmentDirectory
    ? 'use_published_committed_body_segment_ref'
    : 'replace_with_unique_exact_committed_body_span';
  const start = committedBody.indexOf(quote);
  if (start < 0) {
    fail(
      'unsupported_claim',
      'The cited evidence does not occur in the committed body.',
      {
        record_index: recordIndex,
        field_path:
          `records[${recordIndex}].evidence[0].quote_or_ref`,
        action: quoteCorrectionAction,
      },
    );
  }
  if (committedBody.indexOf(quote, start + quote.length) >= 0) {
    fail(
      'source_quote_ambiguous',
      'The cited evidence occurs more than once in the committed body.',
      {
        record_index: recordIndex,
        field_path:
          `records[${recordIndex}].evidence[0].quote_or_ref`,
        action: quoteCorrectionAction,
      },
    );
  }
  return {
    start,
    end: start + quote.length,
    quote,
    source_mode: evidence.source_mode,
    support_strength: evidence.support_strength,
  };
}

function assertCharacter(record, recordIndex) {
  if (
    !entityRef(record.subject_ref)
    || ![
      'appearance',
      'personality',
      'voice',
      'values',
      'desires',
      'fears',
      'abilities',
      'background',
      'current_presentation',
      'arc_state',
    ].includes(record.change_kind)
    || !nonEmptyString(record.value)
  ) {
    fail(
      'turn_delta_record_invalid',
      'character records require a supported field change.',
      { record_index: recordIndex },
    );
  }
}

function assertCognition(record, recordIndex) {
  if (
    !entityRef(record.owner_ref)
    || !(record.about_ref === null || entityRef(record.about_ref))
    || ![
      'knowledge_state',
      'memory',
      'belief',
      'misunderstanding',
      'perception',
      'intention',
    ].includes(record.record_kind)
    || ![
      'knows',
      'believes',
      'suspects',
      'misunderstands',
      'does_not_know',
      'intends',
      null,
    ].includes(record.knowledge_state)
    || !nonEmptyString(record.subjective_content)
    || !nonEmptyString(record.perceived_via)
    || !['ambient', 'low', 'medium', 'high'].includes(record.salience)
    || !['exact', 'gist', 'distorted', 'uncertain'].includes(record.fidelity)
    || !stringArray(record.recall_cues)
  ) {
    fail(
      'turn_delta_record_invalid',
      'character_cognition records require a complete subjective boundary.',
      { record_index: recordIndex },
    );
  }
}

function assertRelationship(record, recordIndex) {
  if (
    !entityRef(record.relationship_ref)
    || !entityRefArray(record.endpoints, { min: 2, max: 2 })
    || new Set(record.endpoints).size !== 2
    || !nonEmptyString(record.relation_kind)
    || !nullableString(record.public_status)
    || !nullableString(record.private_status)
    || !nullableScore(record.trust)
    || !nullableScore(record.intimacy)
    || !nullableScore(record.tension)
    || !nullableString(record.debt)
    || !nullableString(record.hidden_feelings)
    || ![
      'warming',
      'cooling',
      'escalating',
      'stabilizing',
      'fracturing',
      'unknown',
    ].includes(record.current_direction)
  ) {
    fail(
      'turn_delta_record_invalid',
      'relationship records require two endpoints and a complete state.',
      { record_index: recordIndex },
    );
  }
}

function assertSceneEvent(record, recordIndex) {
  if (
    !nonEmptyString(record.what_happened)
    || !entityRefArray(record.participants, { min: 1, max: 16 })
    || !nonEmptyString(record.story_time)
    || !(record.location_ref === null || entityRef(record.location_ref))
    || !nonEmptyString(record.outcome)
    || !stringArray(record.causes, { max: 16 })
    || !stringArray(record.consequences, { max: 16 })
    || !(record.beat_type === undefined || nullableBeatType(record.beat_type))
    || !(record.scene_turn === undefined || sceneTurnValue(record.scene_turn))
  ) {
    fail(
      'turn_delta_record_invalid',
      'scene_event records require complete grounded event fields.',
      { record_index: recordIndex },
    );
  }
}

function assertWorldLore(record, recordIndex) {
  if (
    !entityRef(record.subject_ref)
    || ![
      'location',
      'rule',
      'culture',
      'faction',
      'item',
      'artifact',
      'ability_system',
      'technology',
      'other',
    ].includes(record.lore_kind)
    || !nonEmptyString(record.scope)
    || !nonEmptyString(record.rule_or_fact)
    || !stringArray(record.constraints)
    || !stringArray(record.exceptions)
    || !['static', 'dynamic'].includes(record.static_or_dynamic)
    || !['low', 'medium', 'high', 'critical'].includes(record.priority)
  ) {
    fail(
      'turn_delta_record_invalid',
      'world_lore records require a complete rule or fact.',
      { record_index: recordIndex },
    );
  }
}

function assertPlotThread(record, recordIndex) {
  if (
    !entityRef(record.thread_ref)
    || ![
      'promise',
      'mystery',
      'threat',
      'conflict',
      'goal',
      'foreshadowing',
      'open_question',
    ].includes(record.thread_kind)
    || !['open', 'blocked', 'progressing', 'resolved', 'failed'].includes(
      record.status,
    )
    || !nonEmptyString(record.stakes)
    || !nullableString(record.open_question)
    || !entityRefArray(record.setup_refs)
    || !stringArray(record.blockers)
    || !stringArray(record.payoff_conditions)
    || !['low', 'medium', 'high', 'critical'].includes(
      record.current_pressure,
    )
    || !(record.due_by === undefined || nullableDueBy(record.due_by))
    || !(
      record.salience === undefined
      || nullableObligationSalience(record.salience)
    )
  ) {
    fail(
      'turn_delta_record_invalid',
      'plot_thread records require a complete obligation state.',
      { record_index: recordIndex },
    );
  }
}

function assertSceneState(record, recordIndex, options) {
  if (!sceneRef(record.scene_ref, options)) {
    const expectedRef = (
      options?.enforceActiveSceneChat
      && nonEmptyString(options?.chatId)
    )
      ? (
          'mnemosyne://chat/'
          + `${encodeURIComponent(options.chatId)}/active-scene`
        )
      : null;
    fail(
      'turn_delta_record_invalid',
      'scene_state.scene_ref must use a trusted canonical scene reference.',
      {
        record_index: recordIndex,
        field_path: `records[${recordIndex}].scene_ref`,
        ...(expectedRef ? { expected_ref: expectedRef } : {}),
        action: 'use_trusted_canonical_ref',
      },
    );
  }
  if (
    !nonEmptyString(record.time)
    || !(record.location_ref === null || entityRef(record.location_ref))
    || !entityRefArray(record.participants)
    || !stringArray(record.positions)
    || !stringArray(record.props)
    || !stringArray(record.local_constraints)
    || !nonEmptyString(record.mood)
    || !(record.beat_type === undefined || nullableBeatType(record.beat_type))
    || !(record.scene_turn === undefined || sceneTurnValue(record.scene_turn))
  ) {
    fail(
      'turn_delta_record_invalid',
      'scene_state records require a complete stage state.',
      { record_index: recordIndex },
    );
  }
}

function safeCorrectionIssue(error) {
  const details = isObject(error?.details) ? error.details : {};
  const issue = {
    reason_code: String(error?.reasonCode ?? ''),
    message: String(error?.message ?? ''),
  };
  if (Number.isInteger(details.record_index)) {
    issue.record_index = details.record_index;
  }
  if (
    typeof details.field_path === 'string'
    && CORRECTION_FIELD_PATH_PATTERN.test(details.field_path)
  ) {
    issue.field_path = details.field_path;
  }
  if (details.expected === 'narration') {
    issue.expected = details.expected;
  }
  if (
    typeof details.expected_ref === 'string'
    && sceneRef(details.expected_ref)
  ) {
    issue.expected_ref = details.expected_ref;
  }
  if (CORRECTION_ACTIONS.has(details.action)) {
    issue.action = details.action;
  }
  return Object.freeze(issue);
}

function assertStateValue(record, recordIndex) {
  serializableJson(record.value, recordIndex);
  if (isObject(record.value)) {
    assertExactKeys(record.value, [
      'item_ref',
      'label',
      'quantity',
      'unit',
      'affordances',
      'visibility',
      'salience',
      'expires_if',
    ], {
      recordIndex,
      label: 'Tracked inventory item',
    });
    if (
      !(record.value.item_ref === null || entityRef(record.value.item_ref))
      || !nonEmptyString(record.value.label)
      || !(
        record.value.quantity === null
        || (
          typeof record.value.quantity === 'number'
          && Number.isFinite(record.value.quantity)
        )
      )
      || !nullableString(record.value.unit)
      || !stringArray(record.value.affordances)
      || !['public', 'private', 'hidden', 'unknown'].includes(
        record.value.visibility,
      )
      || !['ambient', 'latent', 'medium', 'high'].includes(
        record.value.salience,
      )
      || !nullableString(record.value.expires_if)
    ) {
      fail(
        'turn_delta_record_invalid',
        'Tracked inventory item value is incomplete.',
        { record_index: recordIndex },
      );
    }
    return;
  }
  if (
    Array.isArray(record.value)
    && (
      record.value.length > 32
      || record.value.some(value => typeof value !== 'string')
    )
  ) {
    fail(
      'turn_delta_record_invalid',
      'State array values must contain at most 32 strings.',
      { record_index: recordIndex },
    );
  }
  if (
    record.value !== null
    && !['string', 'number', 'boolean'].includes(typeof record.value)
    && !Array.isArray(record.value)
  ) {
    fail(
      'turn_delta_record_invalid',
      'State values must use a supported typed shape.',
      { record_index: recordIndex },
    );
  }
}

function canonicalPayload(record, recordIndex, options) {
  switch (record.kind) {
    case 'character':
      assertCharacter(record, recordIndex);
      return {
        subject_ref: record.subject_ref,
        change_kind: record.change_kind,
        value: record.value,
      };
    case 'character_cognition':
      assertCognition(record, recordIndex);
      return {
        owner_ref: record.owner_ref,
        about_ref: record.about_ref,
        record_kind: record.record_kind,
        knowledge_state: record.knowledge_state,
        subjective_content: record.subjective_content,
        perceived_via: record.perceived_via,
        salience: record.salience,
        fidelity: record.fidelity,
        recall_cues: structuredClone(record.recall_cues),
      };
    case 'relationship':
      assertRelationship(record, recordIndex);
      return {
        relationship_ref: record.relationship_ref,
        endpoints: structuredClone(record.endpoints),
        relation_kind: record.relation_kind,
        public_status: record.public_status,
        private_status: record.private_status,
        trust: record.trust,
        intimacy: record.intimacy,
        tension: record.tension,
        debt: record.debt,
        hidden_feelings: record.hidden_feelings,
        current_direction: record.current_direction,
      };
    case 'world_lore':
      assertWorldLore(record, recordIndex);
      return {
        subject_ref: record.subject_ref,
        lore_kind: record.lore_kind,
        scope: record.scope,
        rule_or_fact: record.rule_or_fact,
        constraints: structuredClone(record.constraints),
        exceptions: structuredClone(record.exceptions),
        static_or_dynamic: record.static_or_dynamic,
        priority: record.priority,
      };
    case 'plot_thread':
      assertPlotThread(record, recordIndex);
      return {
        thread_ref: record.thread_ref,
        thread_kind: record.thread_kind,
        status: record.status,
        stakes: record.stakes,
        open_question: record.open_question,
        setup_refs: structuredClone(record.setup_refs),
        blockers: structuredClone(record.blockers),
        payoff_conditions: structuredClone(record.payoff_conditions),
        current_pressure: record.current_pressure,
        ...(Object.hasOwn(record, 'due_by')
          ? { due_by: record.due_by }
          : {}),
        ...(Object.hasOwn(record, 'salience')
          ? { salience: record.salience }
          : {}),
      };
    case 'scene_state':
      assertSceneState(record, recordIndex, options);
      return {
        scene_ref: record.scene_ref,
        time: record.time,
        location_ref: record.location_ref,
        participants: structuredClone(record.participants),
        positions: structuredClone(record.positions),
        props: structuredClone(record.props),
        local_constraints: structuredClone(record.local_constraints),
        mood: record.mood,
        ...(Object.hasOwn(record, 'beat_type')
          ? { beat_type: record.beat_type }
          : {}),
        ...(Object.hasOwn(record, 'scene_turn')
          ? { scene_turn: structuredClone(record.scene_turn) }
          : {}),
      };
    default:
      return null;
  }
}

export function validateCanonicalTypedPayload({
  recordKind,
  payload,
  sequenceIndex,
} = {}) {
  if (!isCanonicalTypedRecordKind(recordKind) || recordKind === 'scene_event') {
    throw new Error('Canonical typed payload kind is invalid.');
  }
  const syntheticRecord = {
    kind: recordKind,
    ...(isObject(payload) ? structuredClone(payload) : {}),
  };
  const schema = PROVIDER_KIND_SCHEMAS.get(recordKind);
  const payloadKeys = schema.required.filter(key => (
    !['kind', 'summary', 'evidence'].includes(key)
  ));
  // Sealed payloads written before the craft field batch keep their legacy
  // key shape; payloads must carry either all craft keys or none of them.
  const craftKeys = craftFieldKeysFor(recordKind);
  const presentCraftKeys = isObject(payload)
    ? craftKeys.filter(key => Object.hasOwn(payload, key))
    : [];
  if (
    presentCraftKeys.length !== 0
    && presentCraftKeys.length !== craftKeys.length
  ) {
    fail(
      'turn_delta_record_invalid',
      `${recordKind} payload has a partial craft field set.`,
      { record_index: sequenceIndex },
    );
  }
  const expectedKeys = presentCraftKeys.length === 0
    ? payloadKeys.filter(key => !craftKeys.includes(key))
    : payloadKeys;
  assertExactKeys(payload, expectedKeys, {
    recordIndex: sequenceIndex,
    label: `${recordKind} payload`,
  });
  return canonicalPayload(syntheticRecord, sequenceIndex);
}

export function normalizeProviderTurnRecords(
  records,
  committedBody,
  {
    chatId,
    turnId,
    candidateId,
    committedBodyCommitId = null,
    committedBodyHash = null,
    committedBodySegmentDirectory = null,
  } = {},
) {
  if (!Array.isArray(records)) {
    fail(
      'turn_delta_records_invalid',
      'Memory writeback records must be an array.',
    );
  }
  if (typeof committedBody !== 'string') {
    fail(
      'turn_delta_records_invalid',
      'Memory writeback requires the exact committed body.',
    );
  }
  const normalizeRecord = (record, recordIndex) => {
    const operationCompatibleRecord = (
      record?.kind === 'current_state'
      && record.operation === undefined
    )
      ? { ...record, operation: 'set' }
      : record;
    const kind = validateProviderRecord(
      operationCompatibleRecord,
      recordIndex,
    );
    const sourceSpan = evidenceSpan(
      operationCompatibleRecord,
      committedBody,
      recordIndex,
      {
        committedBodyCommitId,
        committedBodyHash,
        committedBodySegmentDirectory,
      },
    );

    if (kind === 'current_state') {
      if (
        !entityRef(operationCompatibleRecord.entity_ref)
        || !nonEmptyString(operationCompatibleRecord.state_domain)
        || !nonEmptyString(operationCompatibleRecord.state_key)
        || !['set', 'unset'].includes(operationCompatibleRecord.operation)
        || (
          operationCompatibleRecord.operation === 'unset'
          && operationCompatibleRecord.value !== null
        )
        || (
          operationCompatibleRecord.operation === 'set'
          && operationCompatibleRecord.value === null
        )
      ) {
        fail(
          'turn_delta_record_invalid',
          'current_state records require a stable target, coordinate, and operation-compatible value.',
          { record_index: recordIndex },
        );
      }
      if (operationCompatibleRecord.operation === 'set') {
        assertStateValue(operationCompatibleRecord, recordIndex);
      }
      return {
        kind: 'continuity_state',
        entity_ref: operationCompatibleRecord.entity_ref,
        summary: operationCompatibleRecord.summary,
        state: {
          domain: operationCompatibleRecord.state_domain,
          key: operationCompatibleRecord.state_key,
          operation: operationCompatibleRecord.operation,
          ...(operationCompatibleRecord.operation === 'set'
            ? { value: structuredClone(operationCompatibleRecord.value) }
            : {}),
        },
        source_span: sourceSpan,
      };
    }

    if (kind === 'attribute_value') {
      if (
        !entityRef(record.subject_ref)
        || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(
          record.attribute_id,
        )
      ) {
        fail(
          'turn_delta_record_invalid',
          'attribute_value requires a stable subject and registry id.',
          { record_index: recordIndex },
        );
      }
      assertStateValue(record, recordIndex);
      return {
        kind: 'continuity_state',
        entity_ref: record.subject_ref,
        summary: record.summary,
        state: {
          domain: 'attribute',
          key: record.attribute_id,
          value: structuredClone(record.value),
          operation: 'set',
        },
        source_span: sourceSpan,
      };
    }

    if (kind === 'scene_event') {
      assertSceneEvent(operationCompatibleRecord, recordIndex);
      return {
        kind,
        entity_ref: canonicalTypedRecordEntityRef({
          recordKind: kind,
          turnId,
          candidateId,
          sequenceIndex: recordIndex,
        }),
        summary: operationCompatibleRecord.what_happened,
        event: {
          what_happened: operationCompatibleRecord.what_happened,
          participants: structuredClone(operationCompatibleRecord.participants),
          story_time: operationCompatibleRecord.story_time,
          location_ref: operationCompatibleRecord.location_ref,
          outcome: operationCompatibleRecord.outcome,
          causes: structuredClone(operationCompatibleRecord.causes),
          consequences: structuredClone(operationCompatibleRecord.consequences),
          beat_type: operationCompatibleRecord.beat_type,
          scene_turn: structuredClone(operationCompatibleRecord.scene_turn),
        },
        source_span: sourceSpan,
      };
    }

    const payload = canonicalPayload(
      operationCompatibleRecord,
      recordIndex,
      {
        chatId,
        enforceActiveSceneChat: true,
      },
    );
    return {
      kind,
      entity_ref: canonicalTypedRecordEntityRef({
        recordKind: kind,
        turnId,
        candidateId,
        sequenceIndex: recordIndex,
      }),
      summary: record.summary,
      payload,
      source_span: sourceSpan,
    };
  };
  const normalized = [];
  const validationErrors = [];
  let omittedIssueCount = 0;
  records.forEach((record, recordIndex) => {
    try {
      normalized.push(normalizeRecord(record, recordIndex));
    } catch (error) {
      if (!(error instanceof MnemosyneRequestError)) throw error;
      if (validationErrors.length < MAX_PROVIDER_CORRECTION_ISSUES) {
        validationErrors.push(error);
      } else {
        omittedIssueCount += 1;
      }
    }
  });
  if (validationErrors.length === 1 && omittedIssueCount === 0) {
    throw validationErrors[0];
  }
  if (validationErrors.length > 0) {
    fail(
      'turn_delta_records_invalid',
      'Memory writeback contains multiple invalid records.',
      {
        issues: validationErrors.map(safeCorrectionIssue),
        omitted_issue_count: omittedIssueCount,
      },
    );
  }
  return normalized;
}
