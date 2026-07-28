import {
  readdir,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { sha256 } from '../contracts/hash.js';
import {
  resolveBranchSegments,
  selectActiveTurnMemoryRows,
} from '../history/active-history-resolver.js';
import {
  readVerifiedAuthorityEdits,
} from '../history/authority-edit-resolver.js';
import {
  CANONICAL_DYNAMIC_WRITER_OWNER,
  isCanonicalDynamicRecordKind,
} from '../history/canonical-dynamic-concept.js';
import { parseOkfConcept } from '../okf/bundle.js';
import { OKF_TYPE_DIRECTORIES } from '../okf/schema.js';
import {
  assertDynamicProjectionReadable,
} from '../storage/dynamic-projection-transaction.js';
import {
  assertRuntimeWorldProjectionIntegrity,
} from '../runtime/runtime-world-integrity.js';
import {
  formatCurrentStateMemoryRef,
  parseMemoryReference,
  parseMemoryScopeReference,
} from './memory-reference.js';
import {
  normalizeStoryCoverageFacets,
  selectStoryCoverageCandidates,
  StoryCoverageError,
} from './story-coverage.js';

const OKF_ENTITY_REF_PATTERN = (
  /^okf:\/\/entity\/([A-Za-z0-9][A-Za-z0-9._-]*)$/
);
const MAX_SEARCH_LIMIT = 50;
const SEARCH_SNIPPET_CODEPOINTS = 320;
const DYNAMIC_PROJECTOR_OWNER =
  'mnemosyne.dynamic-story-projector.v1';
const MEMORY_SCOPE_REFS = Symbol('mnemosyne.memory-scope-refs');

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function assertCoordinate(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail(
      'memory_coordinate_invalid',
      `${field} must be a non-negative integer.`,
      { field },
    );
  }
}

function normalizeQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    fail('memory_query_invalid', 'Memory search requires a non-empty query.');
  }
  return query.normalize('NFKC').trim().toLocaleLowerCase('und');
}

function normalizeIntentText(value, field, {
  optional = false,
} = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || !value.trim()) {
    fail(
      'memory_search_intent_invalid',
      `${field} must be a non-empty string.`,
      { field },
    );
  }
  return value.normalize('NFKC').trim().toLocaleLowerCase('und');
}

function normalizeIntentList(value, field, maxItems) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > maxItems
  ) {
    fail(
      'memory_search_intent_invalid',
      `${field} must be an array with at most ${maxItems} items.`,
      { field },
    );
  }
  const normalized = value.map(item => (
    normalizeIntentText(item, field)
  ));
  return [...new Set(normalized)];
}

function normalizeScopeRefs(value, chatId) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > 8
  ) {
    fail(
      'memory_search_intent_invalid',
      'scopeRefs must be an array with at most eight items.',
      { field: 'scopeRefs' },
    );
  }
  const normalized = [...new Set(value.map(ref => (
    typeof ref === 'string'
      ? ref.normalize('NFKC').trim()
      : ref
  )))];
  const parsed = normalized.map(parseMemoryScopeReference);
  if (
    parsed.some((ref, index) => (
      typeof normalized[index] !== 'string'
      || !ref
      || (
        ref.kind === 'active_scene_scope'
        && ref.chatId !== chatId
      )
    ))
  ) {
    fail(
      'memory_ref_invalid',
      'Memory search scope requires supported memory references.',
    );
  }
  return normalized;
}

function normalizeCoverageFacets(value) {
  try {
    return normalizeStoryCoverageFacets(value);
  } catch (error) {
    if (error instanceof StoryCoverageError) {
      fail(error.reasonCode, error.message);
    }
    throw error;
  }
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und');
}

function queryTokens(query) {
  return [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [query])];
}

function occurrenceCount(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(needle.length, 1);
  }
  return count;
}

function lexicalScore(query, memory) {
  const fields = [
    [memory.content, 12],
    [memory.title, 8],
    [memory.aliases?.join(' '), 5],
    [memory.entity_ref, 2],
  ].map(([value, weight]) => [normalizeSearchText(value), weight]);
  let score = 0;
  for (const [text, weight] of fields) {
    if (!text) continue;
    if (text.includes(query)) {
      score += weight * 4;
    }
    for (const token of queryTokens(query)) {
      score += Math.min(occurrenceCount(text, token), 4) * weight;
    }
  }
  return score;
}

function searchSnippet(content, normalizedQuery) {
  const source = String(content ?? '').trim();
  const codepoints = Array.from(source);
  if (codepoints.length <= SEARCH_SNIPPET_CODEPOINTS) return source;

  const normalizedSource = normalizeSearchText(source);
  const matchedOffsets = queryTokens(normalizedQuery)
    .map(token => normalizedSource.indexOf(token))
    .filter(offset => offset >= 0);
  const firstOffset = matchedOffsets.length > 0
    ? Math.min(...matchedOffsets)
    : 0;
  const matchedCodepointOffset = Array.from(
    source.slice(0, firstOffset),
  ).length;
  const start = Math.max(
    0,
    Math.min(
      matchedCodepointOffset - Math.floor(SEARCH_SNIPPET_CODEPOINTS / 3),
      codepoints.length - SEARCH_SNIPPET_CODEPOINTS,
    ),
  );
  const end = start + SEARCH_SNIPPET_CODEPOINTS;
  return (
    `${start > 0 ? '…' : ''}`
    + codepoints.slice(start, end).join('')
    + `${end < codepoints.length ? '…' : ''}`
  );
}

function searchDirectoryEntry(
  memory,
  normalizedQuery,
  score,
  why = 'lexical_query_match',
) {
  const type = memory.type ?? memory.record_kind ?? memory.kind;
  const stateLayer = (
    (
      memory.kind === 'current_state'
      && type === 'current_state'
    )
    || (
      memory.kind === 'turn_memory_record'
      && type === 'continuity_state'
    )
  )
    ? memory.state?.domain === 'attribute'
      ? 'attribute_value'
      : 'current_state'
    : null;
  const source = String(memory.content ?? '').trim();
  const contentSnippet = searchSnippet(source, normalizedQuery);
  const completeOkfBody = (
    memory.kind === 'okf_concept'
    && contentSnippet === source
  );
  const directoryOnly = (
    completeOkfBody
    || memory.kind === 'current_state'
  );
  return {
    ref: memory.ref,
    kind: memory.kind,
    type,
    ...(stateLayer === null
      ? {}
      : { state_layer: stateLayer }),
    title:
      memory.title
      ?? `${type}: ${memory.entity_ref}`,
    path: memory.lineage?.relative_path ?? null,
    entity_ref: memory.entity_ref,
    snippet: directoryOnly
      ? memory.kind === 'current_state'
        ? [
            `Active Current State ${memory.state.domain}.${memory.state.key}`,
            'matches this directory query.',
            'Use memory.read to inspect its bounded value.',
          ].join(' ')
        : [
            `Active ${type} "${memory.title}" matches this directory query.`,
            'Use memory.read to inspect its bounded body.',
          ].join(' ')
      : contentSnippet,
    snippet_kind: directoryOnly
      ? 'directory_summary'
      : memory.kind === 'turn_memory_record'
        ? 'turn_summary'
        : 'content_excerpt',
    why,
    source_count: memory.source_refs?.length ?? 0,
    score,
    lineage: structuredClone(memory.lineage),
    recommended_read: {
      max_tokens: 800,
    },
  };
}

function memoryMatchesScope(memory, scopeRefs) {
  if (scopeRefs.length === 0) return true;
  return scopeRefs.some(ref => {
    const parsed = parseMemoryScopeReference(ref);
    if (parsed.kind === 'active_scene_scope') return false;
    if (parsed.kind === 'okf_entity') {
      return (
        memory.ref === ref
        || memory.entity_ref === ref
        || memory[MEMORY_SCOPE_REFS]?.includes(ref)
      );
    }
    if (parsed.kind === 'current_state') {
      return memory.ref === ref;
    }
    return memory.ref === ref;
  });
}

function bindInternalMemoryScopeRefs(memory, refs) {
  Object.defineProperty(memory, MEMORY_SCOPE_REFS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze([...new Set(refs)]),
  });
  return memory;
}

function dynamicRows(database, {
  chatId,
  branchId,
  branchEpoch,
  turnIndex,
  recordId = null,
  order = 'descending',
}) {
  const branchExists = database.prepare(`
    SELECT 1
    FROM branch_epochs
    WHERE chat_id = ? AND branch_id = ?
    LIMIT 1
  `).get(chatId, branchId);
  if (!branchExists && branchEpoch === 0) {
    return [];
  }
  const segments = resolveBranchSegments(database, {
    chatId,
    branchId,
    branchEpoch,
    turnIndex,
  });
  return selectActiveTurnMemoryRows(database, {
    chatId,
    branchId,
    segments,
    recordId,
    order,
  });
}

function dynamicMemory(row, chatId) {
  let state;
  if (row.state_domain !== null && row.state_key !== null) {
    state = {
      domain: row.state_domain,
      key: row.state_key,
      operation: row.state_operation,
      ...(row.state_value_json === null
        ? {}
        : { value: JSON.parse(row.state_value_json) }),
    };
  }
  return {
    ref: `memory://turn-record/${row.record_id}`,
    kind: 'turn_memory_record',
    content: row.summary,
    source_refs: [row.source_ref],
    entity_ref: row.entity_ref,
    record_kind: row.record_kind,
    support_strength: row.support_strength,
    ...(row.source_mode === null
      ? {}
      : { source_mode: row.source_mode }),
    ...(state === undefined ? {} : { state }),
    lineage: {
      kind: 'turn_commit',
      status: 'active',
      chat_id: chatId,
      branch_id: row.branch_id,
      branch_epoch: row.branch_epoch,
      turn_index: row.turn_index,
      turn_id: row.turn_id,
      candidate_id: row.candidate_id,
      patch_id: row.patch_id,
      record_id: row.record_id,
    },
  };
}

function stateCoordinate({
  entity_ref: entityRef,
  state_domain: stateDomain,
  state_key: stateKey,
}) {
  return JSON.stringify([entityRef, stateDomain, stateKey]);
}

function staticCurrentStateMemory(item, snapshotId) {
  return {
    ref: formatCurrentStateMemoryRef({
      entityRef: item.entity_ref,
      stateDomain: item.state_domain,
      stateKey: item.state_key,
    }),
    kind: 'current_state',
    content: `${item.state_domain}.${item.state_key}: ${
      JSON.stringify(item.current_value)
    }`,
    source_refs: structuredClone(item.source_refs ?? []),
    entity_ref: item.entity_ref,
    state: {
      domain: item.state_domain,
      key: item.state_key,
      value: structuredClone(item.current_value),
    },
    support_strength: item.certainty ?? 'unknown',
    lineage: {
      kind: 'static_lore_current_state',
      status: 'active',
      snapshot_id: snapshotId,
    },
  };
}

function dynamicCurrentStateMemory(row, chatId) {
  return {
    ref: formatCurrentStateMemoryRef({
      entityRef: row.entity_ref,
      stateDomain: row.state_domain,
      stateKey: row.state_key,
    }),
    kind: 'current_state',
    content: [
      row.summary,
      `${row.state_domain}.${row.state_key}: ${
        row.state_value_json
      }`,
    ].join('\n'),
    source_refs: [row.source_ref],
    entity_ref: row.entity_ref,
    ...(row.source_mode === null
      ? {}
      : { source_mode: row.source_mode }),
    state: {
      domain: row.state_domain,
      key: row.state_key,
      value: JSON.parse(row.state_value_json),
      operation: row.state_operation,
    },
    support_strength: row.support_strength,
    lineage: {
      kind: 'turn_commit',
      status: 'active',
      chat_id: chatId,
      branch_id: row.branch_id,
      branch_epoch: row.branch_epoch,
      turn_index: row.turn_index,
      turn_id: row.turn_id,
      candidate_id: row.candidate_id,
      patch_id: row.patch_id,
      record_id: row.record_id,
    },
  };
}

async function activeCurrentStateMemories({
  database,
  opened,
  chatId,
  activeRows,
}) {
  const snapshots = database.prepare(`
    SELECT snapshot_id, aggregate_hash
    FROM static_lore_snapshots
    WHERE chat_id = ? AND status = 'active'
    ORDER BY captured_at DESC, snapshot_id DESC
  `).all(chatId);
  const readyProjectionHashes = database.prepare(`
    SELECT source_version_hash
    FROM derived_state
    WHERE
      chat_id = ?
      AND projection_kind = 'runtime_world'
      AND status = 'ready'
    ORDER BY updated_at DESC, projection_id DESC
  `).all(chatId).map(row => row.source_version_hash);
  if (snapshots.length > 1) {
    fail(
      'memory_state_projection_not_active',
      'The Runtime World current-state projection is not governed by exactly one active Static Lore Snapshot.',
    );
  }

  let runtimeWorld;
  try {
    runtimeWorld = JSON.parse(await readFile(
      path.join(opened.chat_save_path, 'derived', 'runtime-world.json'),
      'utf8',
    ));
  } catch (error) {
    if (
      error?.code === 'ENOENT'
      && snapshots.length === 0
      && readyProjectionHashes.length === 0
    ) {
      runtimeWorld = null;
    } else {
      fail(
        'memory_state_projection_invalid',
        'The Runtime World current-state projection is not readable.',
      );
    }
  }
  if (
    snapshots.length === 0
    && (
      runtimeWorld !== null
      || readyProjectionHashes.length > 0
    )
  ) {
    fail(
      'memory_state_projection_not_active',
      'A Runtime World projection exists without one active Static Lore Snapshot.',
    );
  }
  if (snapshots.length === 1 && (
    runtimeWorld?.schema !== 'mnemosyne.runtime-world.v1'
    || runtimeWorld.status !== 'ready'
    || !Array.isArray(runtimeWorld.current_state)
  )) {
    fail(
      'memory_state_projection_invalid',
      'The Runtime World current-state projection is invalid.',
    );
  }
  if (snapshots.length === 1) {
    try {
      assertRuntimeWorldProjectionIntegrity({
        runtimeWorld,
        activeSnapshot: {
          snapshot_id: snapshots[0].snapshot_id,
          snapshot_hash: snapshots[0].aggregate_hash,
        },
        readyProjectionHashes,
      });
    } catch (error) {
      if (
        error?.reasonCode === 'runtime_world_view_invalid'
      ) {
        fail(
          'memory_state_projection_invalid',
          'The Runtime World current-state projection is invalid.',
        );
      }
      if (
        error?.reasonCode
          === 'runtime_world_snapshot_not_active'
      ) {
        fail(
          'memory_state_projection_not_active',
          'The Runtime World current-state projection is not governed by the active Static Lore Snapshot.',
        );
      }
      fail(
        'memory_state_projection_not_governed',
        'The Runtime World current-state projection does not match its governed projection record.',
        {
          cause: error?.reasonCode ?? 'runtime_world_integrity_failed',
        },
      );
    }
  }

  const current = new Map();
  for (const item of runtimeWorld?.current_state ?? []) {
    if (
      typeof item?.entity_ref !== 'string'
      || typeof item?.state_domain !== 'string'
      || !item.state_domain
      || typeof item?.state_key !== 'string'
      || !item.state_key
      || item.current_value === undefined
    ) {
      continue;
    }
    current.set(
      stateCoordinate(item),
      staticCurrentStateMemory(item, runtimeWorld.snapshot_id),
    );
  }
  for (const row of activeRows) {
    if (row.state_domain === null || row.state_key === null) continue;
    const coordinate = stateCoordinate(row);
    if (row.state_operation === 'unset') {
      current.delete(coordinate);
    } else {
      current.set(
        coordinate,
        dynamicCurrentStateMemory(row, chatId),
      );
    }
  }
  return [...current.values()].sort((left, right) => (
    left.ref.localeCompare(right.ref)
  ));
}

async function listMarkdownFiles(directoryPath) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function assertActiveCanonicalConceptFiles(
  database,
  chatSavePath,
  activeCanonicalRows,
) {
  if (activeCanonicalRows.length === 0) return;
  const storyMemoryPath = path.resolve(chatSavePath, 'story-memory');
  const selectVersion = database.prepare(`
    SELECT
      concept_versions.version_hash,
      concept_versions.relative_path
    FROM concept_versions
    JOIN patches
      ON patches.patch_id = concept_versions.patch_id
    WHERE
      concept_versions.entity_id = ?
      AND concept_versions.patch_id = ?
      AND concept_versions.status = 'active'
      AND patches.status = 'applied'
  `);
  for (const row of activeCanonicalRows) {
    const entityId = row.entity_ref.match(
      OKF_ENTITY_REF_PATTERN,
    )?.[1] ?? null;
    const versions = entityId === null
      ? []
      : selectVersion.all(entityId, row.patch_id);
    const version = versions.length === 1 ? versions[0] : null;
    const expectedDirectory = OKF_TYPE_DIRECTORIES[row.record_kind];
    const relativePath = version?.relative_path;
    const filePath = typeof relativePath === 'string'
      ? path.resolve(storyMemoryPath, relativePath)
      : null;
    let source = null;
    if (
      filePath
      && filePath.startsWith(`${storyMemoryPath}${path.sep}`)
      && relativePath.startsWith(`${expectedDirectory}/`)
    ) {
      try {
        source = await readFile(filePath, 'utf8');
      } catch {
        source = null;
      }
    }
    if (
      !version
      || source === null
      || sha256(source) !== version.version_hash
    ) {
      fail(
        'dynamic_okf_concept_hash_mismatch',
        'An active Dynamic Story concept is missing or no longer matches its governed version.',
        {
          entity_id: entityId,
          relative_path: relativePath ?? null,
        },
      );
    }
  }
}

function activeConceptLineage(database, {
  entityId,
  relativePath,
  versionHash,
  activePatchIds,
  requiresGovernedDynamicVersion,
  canonicalSourceRow,
  chatId,
}) {
  const rows = database.prepare(`
    SELECT
      concept_versions.entity_id,
      concept_versions.version_hash,
      concept_versions.relative_path,
      concept_versions.status AS concept_version_status,
      concept_versions.patch_id,
      concept_versions.snapshot_id,
      concept_versions.intake_id,
      patches.status AS patch_status,
      static_lore_snapshots.status AS snapshot_status,
      intake_runs.status AS intake_status
    FROM concept_versions
    LEFT JOIN patches
      ON patches.patch_id = concept_versions.patch_id
    LEFT JOIN static_lore_snapshots
      ON static_lore_snapshots.snapshot_id = concept_versions.snapshot_id
    LEFT JOIN intake_runs
      ON intake_runs.intake_id = concept_versions.intake_id
    WHERE concept_versions.entity_id = ?
    ORDER BY
      concept_versions.created_at DESC,
      concept_versions.version_hash ASC
  `).all(entityId);
  if (rows.length === 0) {
    if (requiresGovernedDynamicVersion) {
      fail(
        'dynamic_okf_concept_hash_mismatch',
        'A canonical Dynamic Story concept has no governed version.',
        {
          entity_id: entityId,
          relative_path: relativePath,
        },
      );
    }
    return null;
  }

  const matching = rows.find(row => (
    row.version_hash === versionHash
    && row.relative_path === relativePath
    && (
      (
        row.concept_version_status === 'baseline'
        && row.patch_id === null
        && row.snapshot_status === 'active'
        && row.intake_status === 'completed'
      )
      || (
        row.concept_version_status === 'active'
        && row.patch_status === 'applied'
        && activePatchIds.has(row.patch_id)
      )
    )
  ));
  if (!matching) {
    const activeDynamicVersion = rows.find(row => (
      row.concept_version_status === 'active'
      && row.patch_status === 'applied'
      && activePatchIds.has(row.patch_id)
    ));
    if (activeDynamicVersion) {
      fail(
        'dynamic_okf_concept_hash_mismatch',
        'An active Dynamic Story concept no longer matches its governed version.',
        {
          entity_id: entityId,
          relative_path: relativePath,
        },
      );
    }
    return null;
  }
  let canonicalSourceLineage = {};
  if (requiresGovernedDynamicVersion) {
    if (
      !canonicalSourceRow
      || canonicalSourceRow.entity_ref !== `okf://entity/${entityId}`
      || canonicalSourceRow.patch_id !== matching.patch_id
      || !isCanonicalDynamicRecordKind(
        canonicalSourceRow.record_kind,
      )
      || typeof chatId !== 'string'
      || !chatId
    ) {
      fail(
        'dynamic_okf_concept_hash_mismatch',
        'A canonical Dynamic Story concept is detached from its active turn source.',
        {
          entity_id: entityId,
          relative_path: relativePath,
        },
      );
    }
    canonicalSourceLineage = canonicalSourceRow.authority_edit_id
      ? {
          kind: 'authority_edit',
          chat_id: chatId,
          branch_id: canonicalSourceRow.branch_id,
          branch_epoch: canonicalSourceRow.branch_epoch,
          turn_index: canonicalSourceRow.turn_index,
          authority_edit_id: canonicalSourceRow.authority_edit_id,
        }
      : {
          chat_id: chatId,
          branch_id: canonicalSourceRow.branch_id,
          branch_epoch: canonicalSourceRow.branch_epoch,
          turn_index: canonicalSourceRow.turn_index,
          turn_id: canonicalSourceRow.turn_id,
          candidate_id: canonicalSourceRow.candidate_id,
          record_id: canonicalSourceRow.record_id,
          sequence_index: canonicalSourceRow.sequence_index,
        };
  }
  return {
    kind: 'okf_concept',
    status: 'active',
    entity_id: matching.entity_id,
    version_hash: matching.version_hash,
    relative_path: matching.relative_path,
    concept_version_status: matching.concept_version_status,
    patch_id: matching.patch_id,
    snapshot_id: matching.snapshot_id,
    intake_id: matching.intake_id,
    ...canonicalSourceLineage,
  };
}

function governedConceptPaths(
  database,
  chatId,
  activePatchIds,
) {
  const rows = database.prepare(`
    SELECT
      concept_versions.relative_path,
      concept_versions.status AS concept_version_status,
      concept_versions.patch_id,
      patches.status AS patch_status,
      static_lore_snapshots.status AS snapshot_status,
      intake_runs.status AS intake_status
    FROM concept_versions
    LEFT JOIN patches
      ON patches.patch_id = concept_versions.patch_id
    LEFT JOIN static_lore_snapshots
      ON static_lore_snapshots.snapshot_id = concept_versions.snapshot_id
    LEFT JOIN intake_runs
      ON intake_runs.intake_id = concept_versions.intake_id
    WHERE
      (
        concept_versions.status = 'baseline'
        AND concept_versions.patch_id IS NULL
        AND static_lore_snapshots.chat_id = ?
        AND static_lore_snapshots.status = 'active'
        AND intake_runs.status = 'completed'
      )
      OR (
        concept_versions.status = 'active'
        AND patches.chat_id = ?
        AND patches.status = 'applied'
      )
  `).all(chatId, chatId);
  return new Set(rows
    .filter(row => (
      row.concept_version_status === 'baseline'
      || (
        row.patch_status === 'applied'
        && activePatchIds.has(row.patch_id)
      )
    ))
    .map(row => row.relative_path));
}

async function activeOkfMemories(
  database,
  chatSavePath,
  chatId,
  activePatchIds,
  activeCanonicalRows,
  authorityEdits = [],
) {
  const editedEntityIds = new Set(
    authorityEdits.map(edit => edit.row.entity_id),
  );
  const effectiveCanonicalRows = [
    ...activeCanonicalRows.filter(row => (
      !editedEntityIds.has(row.entity_ref.slice('okf://entity/'.length))
    )),
    ...authorityEdits.map(({ row }) => ({
      entity_ref: row.entity_ref,
      record_kind: row.record_kind,
      patch_id: row.patch_id,
      branch_id: row.branch_id,
      branch_epoch: row.branch_epoch,
      turn_index: row.through_turn_index,
      authority_edit_id: row.edit_id,
    })),
  ];
  await assertActiveCanonicalConceptFiles(
    database,
    chatSavePath,
    effectiveCanonicalRows,
  );
  const canonicalSourceByEntityId = new Map();
  for (const row of effectiveCanonicalRows) {
    const entityId = row.entity_ref.match(
      OKF_ENTITY_REF_PATTERN,
    )?.[1] ?? null;
    if (
      entityId === null
      || canonicalSourceByEntityId.has(entityId)
    ) {
      fail(
        'dynamic_okf_concept_hash_mismatch',
        'Canonical Dynamic Story source identity is ambiguous.',
        { entity_id: entityId },
      );
    }
    canonicalSourceByEntityId.set(entityId, row);
  }
  const storyMemoryPath = path.join(chatSavePath, 'story-memory');
  const governedPaths = governedConceptPaths(
    database,
    chatId,
    activePatchIds,
  );
  const typeByDirectory = new Map(
    Object.entries(OKF_TYPE_DIRECTORIES)
      .map(([type, directory]) => [directory, type]),
  );
  const files = [];
  for (const directory of [...typeByDirectory.keys()].sort()) {
    files.push(...await listMarkdownFiles(path.join(
      storyMemoryPath,
      directory,
    )));
  }

  const memories = [];
  for (const filePath of files) {
    const relativePath = path.relative(storyMemoryPath, filePath)
      .split(path.sep)
      .join('/');
    if (!governedPaths.has(relativePath)) continue;
    const expectedType = typeByDirectory.get(relativePath.split('/')[0]);
    const source = await readFile(filePath, 'utf8');
    let parsed;
    try {
      parsed = parseOkfConcept(source, { conceptPath: relativePath });
    } catch (error) {
      fail(
        'memory_okf_invalid',
        'An OKF memory file is not readable.',
        {
          relative_path: relativePath,
          cause: error.reasonCode ?? error.message,
        },
      );
    }
    const { frontmatter, body } = parsed;
    if (frontmatter?.projection_owner === DYNAMIC_PROJECTOR_OWNER) {
      continue;
    }
    if (
      frontmatter?.status !== 'active'
      || frontmatter.type !== expectedType
      || typeof frontmatter.entity_id !== 'string'
      || !frontmatter.entity_id
      || typeof frontmatter.title !== 'string'
      || !frontmatter.title.trim()
      || !Array.isArray(frontmatter.source_refs)
      || frontmatter.source_refs.length === 0
      || !body.trim()
    ) {
      continue;
    }
    const versionHash = sha256(source);
    const lineage = activeConceptLineage(database, {
      entityId: frontmatter.entity_id,
      relativePath,
      versionHash,
      activePatchIds,
      requiresGovernedDynamicVersion:
        frontmatter.canonical_writer_owner
          === CANONICAL_DYNAMIC_WRITER_OWNER,
      canonicalSourceRow:
        canonicalSourceByEntityId.get(frontmatter.entity_id) ?? null,
      chatId,
    });
    if (!lineage) continue;
    const entityRef = `okf://entity/${frontmatter.entity_id}`;
    const subjectRef = (
      typeof frontmatter.subject_ref === 'string'
      && parseMemoryReference(frontmatter.subject_ref)
    )
      ? frontmatter.subject_ref
      : null;
    memories.push(bindInternalMemoryScopeRefs({
      ref: entityRef,
      kind: 'okf_concept',
      type: frontmatter.type,
      title: frontmatter.title,
      aliases: structuredClone(frontmatter.aliases ?? []),
      content: body.trim(),
      source_refs: structuredClone(frontmatter.source_refs),
      entity_ref: entityRef,
      lineage,
    }, [
      entityRef,
      ...(subjectRef === null ? [] : [subjectRef]),
    ]));
  }
  return memories.sort((left, right) => left.ref.localeCompare(right.ref));
}

function unavailable(ref) {
  return {
    schema: 'mnemosyne.memory-read-result.v2',
    status: 'unavailable',
    ref,
    reason_code: 'memory_not_active',
  };
}

export function createMemoryReader({ store } = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error('Memory Reader requires a trusted chat-save store.');
  }

  return Object.freeze({
    capability_version: 'mnemosyne.memory-reader.v2',

    async search({
      chatId,
      query,
      purpose,
      needs,
      scopeRefs,
      coverageFacets,
      branchId = 'main',
      branchEpoch,
      turnIndex,
      limit = 8,
    } = {}) {
      const normalizedQuery = normalizeQuery(query);
      const normalizedPurpose = normalizeIntentText(
        purpose,
        'purpose',
        { optional: true },
      );
      const normalizedNeeds = normalizeIntentList(
        needs,
        'needs',
        4,
      );
      const normalizedScopeRefs = normalizeScopeRefs(
        scopeRefs,
        chatId,
      );
      const normalizedCoverageFacets =
        normalizeCoverageFacets(coverageFacets);
      const expandedQueries = [
        normalizedPurpose,
        ...normalizedNeeds,
      ].filter(Boolean);
      assertCoordinate(branchEpoch, 'branchEpoch');
      assertCoordinate(turnIndex, 'turnIndex');
      if (
        !Number.isInteger(limit)
        || limit < 1
        || limit > MAX_SEARCH_LIMIT
      ) {
        fail(
          'memory_search_limit_invalid',
          `Memory search limit must be between 1 and ${MAX_SEARCH_LIMIT}.`,
        );
      }
      const opened = await store.openChatForAdmin({ chatId });
      await assertDynamicProjectionReadable({
        chatSavePath: opened.chat_save_path,
      });
      const authorityEdits = await readVerifiedAuthorityEdits({
        ledgerPath: opened.ledger_path,
        chatSavePath: opened.chat_save_path,
        chatId,
        branchId,
        branchEpoch,
        turnIndex,
      });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        const activeRows = dynamicRows(database, {
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
        });
        const activePatchIds = new Set(
          [
            ...activeRows.map(row => row.patch_id),
            ...authorityEdits.map(edit => edit.row.patch_id),
          ],
        );
        const currentStateMemories =
          await activeCurrentStateMemories({
            database,
            opened,
            chatId,
            activeRows: dynamicRows(database, {
              chatId,
              branchId,
              branchEpoch,
              turnIndex,
              order: 'ascending',
            }),
          });
        const currentStateSourceRecordIds = new Set(
          currentStateMemories
            .map(memory => memory.lineage?.record_id)
            .filter(Boolean),
        );
        const memories = [
          ...activeRows
            .filter(row => (
              !isCanonicalDynamicRecordKind(row.record_kind)
              && (
                !currentStateSourceRecordIds.has(row.record_id)
                || normalizedScopeRefs.includes(
                  `memory://turn-record/${row.record_id}`,
                )
              )
            ))
            .map(row => dynamicMemory(row, chatId)),
          ...await activeOkfMemories(
            database,
            opened.chat_save_path,
            chatId,
            activePatchIds,
            activeRows.filter(row => (
              isCanonicalDynamicRecordKind(row.record_kind)
            )),
            authorityEdits,
          ),
          ...currentStateMemories,
        ];
        const rankedCandidates = memories
          .filter(memory => (
            memoryMatchesScope(memory, normalizedScopeRefs)
          ))
          .map(memory => {
            const primaryScore = lexicalScore(
              normalizedQuery,
              memory,
            );
            const expansionScores = expandedQueries.map(
              expandedQuery => ({
                query: expandedQuery,
                score: lexicalScore(expandedQuery, memory),
              }),
            );
            const expansionScore = expansionScores.reduce(
              (total, item) => total + item.score,
              0,
            );
            const bestExpansion = expansionScores
              .sort((left, right) => (
                right.score - left.score
                || left.query.localeCompare(right.query)
              ))[0];
            return {
              memory,
              primaryScore,
              expansionScore,
              score: primaryScore > 0
                ? primaryScore
                : expansionScore,
              snippetQuery: primaryScore > 0
                ? normalizedQuery
                : bestExpansion?.query ?? normalizedQuery,
            };
          })
          .filter(candidate => candidate.score > 0)
          .sort((left, right) => (
            Number(right.primaryScore > 0)
              - Number(left.primaryScore > 0)
            || right.primaryScore - left.primaryScore
            || right.expansionScore - left.expansionScore
            || left.memory.ref.localeCompare(right.memory.ref)
          ));
        const selected = selectStoryCoverageCandidates({
          candidates: rankedCandidates,
          requestedFacets: normalizedCoverageFacets,
          limit,
        });
        const results = selected.candidates
          .map(({
            memory,
            primaryScore,
            score,
            snippetQuery,
          }) => (
            searchDirectoryEntry(
              memory,
              snippetQuery,
              score,
              primaryScore > 0
                ? 'lexical_query_match'
                : 'retrieval_intent_match',
            )
          ));
        return {
          schema: 'mnemosyne.memory-search-result.v2',
          status: 'ready',
          query,
          branch_epoch: branchEpoch,
          turn_index: turnIndex,
          coverage: selected.coverage,
          results,
        };
      } finally {
        database.close();
      }
    },

    async read({
      chatId,
      ref,
      branchId = 'main',
      branchEpoch,
      turnIndex,
    } = {}) {
      assertCoordinate(branchEpoch, 'branchEpoch');
      assertCoordinate(turnIndex, 'turnIndex');
      const parsedRef = parseMemoryReference(ref);
      if (!parsedRef) {
        fail(
          'memory_ref_invalid',
          'Memory read requires a supported memory reference.',
          { ref },
        );
      }

      const opened = await store.openChatForAdmin({ chatId });
      await assertDynamicProjectionReadable({
        chatSavePath: opened.chat_save_path,
      });
      const authorityEdits = await readVerifiedAuthorityEdits({
        ledgerPath: opened.ledger_path,
        chatSavePath: opened.chat_save_path,
        chatId,
        branchId,
        branchEpoch,
        turnIndex,
      });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      try {
        const activeRows = dynamicRows(database, {
          chatId,
          branchId,
          branchEpoch,
          turnIndex,
        });
        let memory;
        if (parsedRef.kind === 'turn_record') {
          const row = activeRows.find(candidate => (
            candidate.record_id === parsedRef.recordId
          ));
          memory = (
            row
            && !isCanonicalDynamicRecordKind(row.record_kind)
          )
            ? dynamicMemory(row, chatId)
            : null;
        } else if (parsedRef.kind === 'okf_entity') {
          const activePatchIds = new Set(
            [
              ...activeRows.map(row => row.patch_id),
              ...authorityEdits.map(edit => edit.row.patch_id),
            ],
          );
          memory = (await activeOkfMemories(
            database,
            opened.chat_save_path,
            chatId,
            activePatchIds,
            activeRows.filter(row => (
              isCanonicalDynamicRecordKind(row.record_kind)
            )),
            authorityEdits,
          )).find(candidate => candidate.ref === ref) ?? null;
        } else {
          memory = (await activeCurrentStateMemories({
            database,
            opened,
            chatId,
            activeRows: dynamicRows(database, {
              chatId,
              branchId,
              branchEpoch,
              turnIndex,
              order: 'ascending',
            }),
          })).find(candidate => candidate.ref === ref) ?? null;
        }
        if (!memory) return unavailable(ref);
        return {
          schema: 'mnemosyne.memory-read-result.v2',
          status: 'ready',
          ref,
          memory,
        };
      } finally {
        database.close();
      }
    },
  });
}
