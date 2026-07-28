import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { resolveBranchSegments } from './active-history-resolver.js';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

export function selectActiveAuthorityEditRows(database, {
  chatId,
  branchId,
  segments,
}) {
  const statement = database.prepare(`
    SELECT
      authority_edits.*,
      patches.status AS patch_status
    FROM authority_edits
    JOIN patches ON patches.patch_id = authority_edits.patch_id
    WHERE
      authority_edits.chat_id = ?
      AND authority_edits.branch_id = ?
      AND authority_edits.branch_epoch = ?
      AND authority_edits.through_turn_index <= ?
      AND authority_edits.status = 'applied'
      AND patches.status = 'applied'
    ORDER BY
      authority_edits.through_turn_index ASC,
      authority_edits.created_at ASC,
      authority_edits.edit_id ASC
  `);
  const latest = new Map();
  for (const segment of segments) {
    for (const row of statement.all(
      chatId,
      branchId,
      segment.branch_epoch,
      segment.through_turn_index,
    )) {
      latest.set(row.entity_id, row);
    }
  }
  return [...latest.values()].sort((left, right) => (
    left.through_turn_index - right.through_turn_index
    || left.edit_id.localeCompare(right.edit_id)
  ));
}

export async function readVerifiedAuthorityEdits({
  ledgerPath,
  chatSavePath,
  chatId,
  branchId,
  branchEpoch,
  turnIndex,
} = {}) {
  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  let rows;
  try {
    const branchExists = database.prepare(`
      SELECT 1
      FROM branch_epochs
      WHERE chat_id = ? AND branch_id = ?
      LIMIT 1
    `).get(chatId, branchId);
    if (!branchExists && branchEpoch === 0) return [];
    const segments = resolveBranchSegments(database, {
      chatId,
      branchId,
      branchEpoch,
      turnIndex,
    });
    rows = selectActiveAuthorityEditRows(database, {
      chatId,
      branchId,
      segments,
    });
  } finally {
    database.close();
  }
  const edits = [];
  for (const row of rows) {
    edits.push(await readVerifiedAuthorityEditArtifact({
      row,
      chatSavePath,
      chatId,
    }));
  }
  return edits;
}

export async function readVerifiedAuthorityEditArtifact({
  row,
  chatSavePath,
  chatId,
} = {}) {
  let serialized;
  try {
    serialized = await readFile(
      path.join(chatSavePath, row.artifact_path),
      'utf8',
    );
  } catch {
    fail(
      'authority_edit_artifact_unreadable',
      'An applied authority edit artifact cannot be read.',
      { edit_id: row.edit_id },
    );
  }
  if (sha256(serialized) !== row.artifact_hash) {
    fail(
      'authority_edit_artifact_hash_mismatch',
      'An applied authority edit artifact no longer matches its ledger hash.',
      { edit_id: row.edit_id },
    );
  }
  let artifact;
  try {
    artifact = JSON.parse(serialized);
  } catch {
    fail(
      'authority_edit_artifact_invalid',
      'An applied authority edit artifact is invalid JSON.',
      { edit_id: row.edit_id },
    );
  }
  if (
    artifact.schema !== 'mnemosyne.authority-edit-artifact.v1'
    || artifact.edit_id !== row.edit_id
    || artifact.command_id !== row.command_id
    || artifact.chat_id !== chatId
    || artifact.branch_id !== row.branch_id
    || artifact.branch_epoch !== row.branch_epoch
    || artifact.through_turn_index !== row.through_turn_index
    || artifact.patch_id !== row.patch_id
    || artifact.base.entity_ref !== row.entity_ref
    || artifact.base.version_hash !== row.base_version_hash
    || artifact.concept.relative_path !== row.relative_path
    || artifact.concept.version_hash !== row.version_hash
    || sha256(artifact.concept.document) !== row.version_hash
    || artifact.artifact_hash !== sha256(canonicalJson({
      edit_id: artifact.edit_id,
      command_id: artifact.command_id,
      base: artifact.base,
      record: artifact.record,
      typed_diff: artifact.typed_diff,
      concept_hash: artifact.concept.version_hash,
      created_at: artifact.created_at,
    }))
  ) {
    fail(
      'authority_edit_artifact_invalid',
      'An applied authority edit artifact does not bind to its ledger row.',
      { edit_id: row.edit_id },
    );
  }
  return { row, artifact };
}

export function authorityEditPseudoRows(edits) {
  return edits.map(({ row, artifact }, index) => {
    const record = artifact.record;
    return {
      turn_index: row.through_turn_index,
      branch_id: row.branch_id,
      branch_epoch: row.branch_epoch,
      turn_id: `authority-edit-${row.edit_id}`,
      candidate_id: `authority-edit-${row.edit_id}`,
      patch_id: row.patch_id,
      sequence_index: 1_000_000 + index,
      record_id: `authority-edit-record-${row.edit_id}`,
      record_kind: record.kind,
      entity_ref: record.entity_ref,
      summary: record.summary,
      state_domain: null,
      state_key: null,
      state_value_json: null,
      state_operation: null,
      record_payload_json: record.payload === undefined
        ? record.event === undefined
          ? null
          : JSON.stringify(record.event)
        : JSON.stringify(record.payload),
      source_ref: row.source_ref,
      source_start: record.source_span.start,
      source_end: record.source_span.end,
      source_mode: record.source_span.source_mode ?? null,
      support_strength: record.source_span.support_strength,
      authority_edit_id: row.edit_id,
    };
  });
}
