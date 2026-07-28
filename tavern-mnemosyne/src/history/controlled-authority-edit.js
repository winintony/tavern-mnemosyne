import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { parseOkfConcept } from '../okf/bundle.js';
import {
  createChatWriteCoordinator,
} from '../runtime/chat-write-coordinator.js';
import {
  compileCanonicalDynamicConcept,
  isCanonicalDynamicRecordKind,
} from './canonical-dynamic-concept.js';
import {
  readVerifiedActiveHistory,
} from './dynamic-story-projector.js';
import {
  readVerifiedAuthorityEditArtifact,
} from './authority-edit-resolver.js';
import {
  normalizeProviderTurnRecords,
} from './typed-turn-delta.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function assertInput(input) {
  if (
    !SAFE_ID_PATTERN.test(input?.commandId ?? '')
    || !SAFE_ID_PATTERN.test(input?.editId ?? '')
    || typeof input?.chatId !== 'string' || !input.chatId
    || !SAFE_ID_PATTERN.test(input?.branchId ?? '')
    || !Number.isSafeInteger(input?.branchEpoch)
    || input.branchEpoch < 0
    || !Number.isSafeInteger(input?.throughTurnIndex)
    || input.throughTurnIndex < 0
    || !isObject(input?.base)
    || typeof input.base.entity_ref !== 'string'
    || !input.base.entity_ref.startsWith('okf://entity/')
    || !HASH_PATTERN.test(input.base.version_hash ?? '')
    || !isObject(input?.replacement)
    || !isCanonicalDynamicRecordKind(input.replacement.kind)
    || typeof input.evidenceText !== 'string'
    || !input.evidenceText
    || typeof input.evidenceQuote !== 'string'
    || !input.evidenceQuote
    || !['narration', 'dialogue', 'mixed'].includes(input.sourceMode)
  ) {
    fail(
      'authority_edit_input_invalid',
      'Authority edit input is invalid.',
    );
  }
}

function identity(record) {
  const value = record.payload ?? record.event;
  switch (record.kind) {
    case 'character':
      return canonicalJson([value.subject_ref, value.change_kind]);
    case 'character_cognition':
      return canonicalJson([
        value.owner_ref,
        value.about_ref,
        value.record_kind,
      ]);
    case 'relationship':
      return canonicalJson([value.relationship_ref]);
    case 'world_lore':
      return canonicalJson([value.subject_ref, value.lore_kind]);
    case 'plot_thread':
      return canonicalJson([value.thread_ref]);
    case 'scene_state':
      return canonicalJson([value.scene_ref]);
    case 'scene_event':
      return canonicalJson([record.entity_ref]);
    default:
      return null;
  }
}

function baseRecordFromConcept(parsed, entityRef) {
  const frontmatter = parsed.frontmatter;
  const kind = frontmatter.record_kind ?? frontmatter.type;
  if (!isCanonicalDynamicRecordKind(kind)) return null;
  if (kind !== 'scene_event') {
    return {
      kind,
      entity_ref: entityRef,
      payload: structuredClone(frontmatter.typed_payload),
    };
  }
  return {
    kind,
    entity_ref: entityRef,
    event: {
      what_happened: frontmatter.what_happened,
      participants: structuredClone(frontmatter.participants),
      story_time: frontmatter.story_time,
      location_ref: frontmatter.location_ref,
      outcome: frontmatter.outcome,
      causes: structuredClone(frontmatter.causes),
      consequences: structuredClone(frontmatter.consequences),
      ...(Object.hasOwn(frontmatter, 'beat_type')
        ? {
            beat_type: frontmatter.beat_type,
            scene_turn: structuredClone(frontmatter.scene_turn),
          }
        : {}),
    },
  };
}

function diffPaths(before, after, prefix = '') {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (!isObject(before) || !isObject(after)) {
    return [prefix || '$'];
  }
  const keys = [...new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])].sort();
  return keys.flatMap(key => diffPaths(
    before[key],
    after[key],
    prefix ? `${prefix}.${key}` : key,
  ));
}

function existingByCommand(database, commandId) {
  return database.prepare(`
    SELECT *
    FROM authority_edits
    WHERE command_id = ?
  `).get(commandId);
}

function existingByEdit(database, editId) {
  return database.prepare(`
    SELECT *
    FROM authority_edits
    WHERE edit_id = ?
  `).get(editId);
}

async function fileHashOrNull(filePath) {
  try {
    return sha256(await readFile(filePath));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function resultFromRow(row, { existing = false } = {}) {
  return {
    schema: 'mnemosyne.authority-edit-result.v1',
    status: row.status === 'applied'
      ? existing ? 'existing' : 'applied'
      : row.status,
    edit_id: row.edit_id,
    patch_id: row.patch_id,
    entity_ref: row.entity_ref,
    base_version_hash: row.base_version_hash,
    version_hash: row.version_hash,
    artifact_hash: row.artifact_hash,
  };
}

export function createControlledAuthorityEditService({
  store,
  projector,
  chatWriteCoordinator = createChatWriteCoordinator(),
  now = () => new Date(),
} = {}) {
  if (
    !store?.openChatForAdmin
    || !projector?.rebuild
    || !chatWriteCoordinator?.run
    || typeof now !== 'function'
  ) {
    throw new TypeError(
      'Controlled authority edits require store, writer lock, and projector.',
    );
  }

  async function resumeAuthorityEdit(opened, row) {
    const database = new DatabaseSync(opened.ledger_path, {
      readOnly: true,
    });
    let patchFile;
    try {
      patchFile = database.prepare(`
        SELECT patch_files.*, patches.status AS patch_status
        FROM patch_files
        JOIN patches ON patches.patch_id = patch_files.patch_id
        WHERE
          patch_files.patch_id = ?
          AND patch_files.relative_path = ?
      `).get(
        row.patch_id,
        `story-memory/${row.relative_path}`,
      );
    } finally {
      database.close();
    }
    if (
      !patchFile
      || patchFile.before_hash !== row.base_version_hash
      || patchFile.after_hash !== row.version_hash
      || patchFile.patch_status !== 'prepared'
      || row.status !== 'prepared'
    ) {
      fail(
        'authority_edit_prepared_state_invalid',
        'Prepared authority edit recovery state is invalid.',
      );
    }
    const basePath = path.join(
      opened.chat_save_path,
      'story-memory',
      row.relative_path,
    );
    const stagedConcept = path.join(
      opened.chat_save_path,
      patchFile.staging_path,
    );
    const backupPath = path.join(
      opened.chat_save_path,
      patchFile.inverse_blob_ref,
    );
    const artifactPath = path.join(
      opened.chat_save_path,
      row.artifact_path,
    );
    const stagedArtifact = path.join(
      opened.chat_save_path,
      'staging',
      'authority-edits',
      row.edit_id,
      'artifact.json',
    );
    if (
      await fileHashOrNull(backupPath) !== row.base_version_hash
    ) {
      fail(
        'authority_edit_backup_hash_mismatch',
        'Prepared authority edit backup no longer matches its base.',
      );
    }
    const currentConceptHash = await fileHashOrNull(basePath);
    if (currentConceptHash === row.base_version_hash) {
      if (await fileHashOrNull(stagedConcept) !== row.version_hash) {
        fail(
          'authority_edit_staging_hash_mismatch',
          'Prepared authority edit concept staging is invalid.',
        );
      }
      await rename(stagedConcept, basePath);
    } else if (currentConceptHash !== row.version_hash) {
      fail(
        'authority_edit_canonical_hash_mismatch',
        'Prepared authority edit canonical state is ambiguous.',
      );
    }
    const currentArtifactHash = await fileHashOrNull(artifactPath);
    if (currentArtifactHash === null) {
      if (await fileHashOrNull(stagedArtifact) !== row.artifact_hash) {
        fail(
          'authority_edit_staging_hash_mismatch',
          'Prepared authority edit artifact staging is invalid.',
        );
      }
      await rename(stagedArtifact, artifactPath);
    } else if (currentArtifactHash !== row.artifact_hash) {
      fail(
        'authority_edit_artifact_hash_mismatch',
        'Prepared authority edit artifact state is ambiguous.',
      );
    }
    await readVerifiedAuthorityEditArtifact({
      row,
      chatSavePath: opened.chat_save_path,
      chatId: row.chat_id,
    });
    const appliedAt = now().toISOString();
    const applied = new DatabaseSync(opened.ledger_path);
    try {
      applied.exec('BEGIN IMMEDIATE');
      const superseded = applied.prepare(`
        UPDATE concept_versions
        SET status = 'superseded'
        WHERE
          entity_id = ?
          AND version_hash = ?
          AND status = 'active'
      `).run(row.entity_id, row.base_version_hash);
      if (superseded.changes !== 1) {
        fail(
          'authority_edit_base_stale',
          'Prepared authority edit base is no longer active.',
        );
      }
      applied.prepare(`
        INSERT INTO concept_versions (
          entity_id,
          version_hash,
          relative_path,
          patch_id,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, 'active', ?)
      `).run(
        row.entity_id,
        row.version_hash,
        row.relative_path,
        row.patch_id,
        row.created_at,
      );
      const patchApplied = applied.prepare(`
        UPDATE patches
        SET status = 'applied', applied_at = ?
        WHERE patch_id = ? AND status = 'prepared'
      `).run(appliedAt, row.patch_id);
      const editApplied = applied.prepare(`
        UPDATE authority_edits
        SET status = 'applied'
        WHERE edit_id = ? AND status = 'prepared'
      `).run(row.edit_id);
      if (
        patchApplied.changes !== 1
        || editApplied.changes !== 1
      ) {
        fail(
          'authority_edit_prepared_state_invalid',
          'Prepared authority edit could not be atomically applied.',
        );
      }
      applied.exec('COMMIT');
    } catch (error) {
      try {
        applied.exec('ROLLBACK');
      } catch {
        // Ignore rollback after a failed begin.
      }
      throw error;
    } finally {
      applied.close();
    }
    await projector.rebuild({
      chatId: row.chat_id,
      branchId: row.branch_id,
      branchEpoch: row.branch_epoch,
      turnIndex: row.through_turn_index,
    });
    const finalDatabase = new DatabaseSync(opened.ledger_path, {
      readOnly: true,
    });
    try {
      return resultFromRow(
        existingByEdit(finalDatabase, row.edit_id),
      );
    } finally {
      finalDatabase.close();
    }
  }

  async function compile(input) {
    assertInput(input);
    return chatWriteCoordinator.run(input.chatId, async () => {
      const opened = await store.openChatForAdmin({ chatId: input.chatId });
      const preflight = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let existingCommand;
      let existingEdit;
      try {
        existingCommand = existingByCommand(
          preflight,
          input.commandId,
        );
        existingEdit = existingByEdit(preflight, input.editId);
      } finally {
        preflight.close();
      }
      if (existingCommand || existingEdit) {
        const existing = existingCommand ?? existingEdit;
        if (
          existing.edit_id !== input.editId
          || existing.command_id !== input.commandId
          || (
            existingCommand
            && existingEdit
            && existingCommand.edit_id !== existingEdit.edit_id
          )
        ) {
          fail(
            existingCommand
              ? 'authority_edit_command_reused'
              : 'authority_edit_id_reused',
            'Authority edit command or edit id is already bound.',
          );
        }
        if (existing.status === 'prepared') {
          return resumeAuthorityEdit(opened, existing);
        }
        if (existing.status === 'applied') {
          await readVerifiedAuthorityEditArtifact({
            row: existing,
            chatSavePath: opened.chat_save_path,
            chatId: input.chatId,
          });
          await projector.rebuild({
            chatId: existing.chat_id,
            branchId: existing.branch_id,
            branchEpoch: existing.branch_epoch,
            turnIndex: existing.through_turn_index,
          });
        }
        return resultFromRow(existing, { existing: true });
      }

      const { rows } = await readVerifiedActiveHistory({
        ledgerPath: opened.ledger_path,
        chatSavePath: opened.chat_save_path,
        chatId: input.chatId,
        branchId: input.branchId,
        branchEpoch: input.branchEpoch,
        turnIndex: input.throughTurnIndex,
      });
      const baseRow = [...rows].reverse().find(row => (
        row.entity_ref === input.base.entity_ref
        && isCanonicalDynamicRecordKind(row.record_kind)
      ));
      if (!baseRow) {
        fail(
          'authority_edit_base_inactive',
          'Authority edit base is not active at this coordinate.',
        );
      }
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let baseVersion;
      try {
        baseVersion = database.prepare(`
          SELECT
            concept_versions.entity_id,
            concept_versions.version_hash,
            concept_versions.relative_path,
            concept_versions.patch_id,
            concept_versions.status,
            patches.status AS patch_status
          FROM concept_versions
          JOIN patches ON patches.patch_id = concept_versions.patch_id
          WHERE
            concept_versions.entity_id = ?
            AND concept_versions.version_hash = ?
            AND concept_versions.status = 'active'
            AND patches.status = 'applied'
        `).get(
          input.base.entity_ref.slice('okf://entity/'.length),
          input.base.version_hash,
        );
      } finally {
        database.close();
      }
      if (!baseVersion) {
        fail(
          'authority_edit_base_stale',
          'Authority edit base version is stale or inactive.',
        );
      }
      const basePath = path.join(
        opened.chat_save_path,
        'story-memory',
        baseVersion.relative_path,
      );
      const baseDocument = await readFile(basePath, 'utf8');
      if (sha256(baseDocument) !== input.base.version_hash) {
        fail(
          'authority_edit_base_hash_mismatch',
          'Authority edit base file does not match its governed version.',
        );
      }
      const parsedBase = parseOkfConcept(baseDocument, {
        conceptPath: baseVersion.relative_path,
      });
      const baseRecord = baseRecordFromConcept(
        parsedBase,
        input.base.entity_ref,
      );
      if (
        !baseRecord
        || baseRecord.kind !== input.replacement.kind
      ) {
        fail(
          'authority_edit_identity_protected',
          'Authority edit cannot change the governed record kind.',
        );
      }
      const [normalized] = normalizeProviderTurnRecords([{
        ...structuredClone(input.replacement),
        evidence: [{
          source_kind: 'committed_body',
          quote_or_ref: input.evidenceQuote,
          source_mode: input.sourceMode,
          support_strength: 'explicit',
        }],
      }], input.evidenceText, {
        turnId: `authority-edit-${input.editId}`,
        candidateId: `authority-edit-${input.editId}`,
      });
      const record = {
        ...normalized,
        entity_ref: input.base.entity_ref,
        source_ref: `edit://authority/${input.editId}#chars=${
          normalized.source_span.start
        }-${normalized.source_span.end}`,
      };
      if (
        record.kind !== 'scene_event'
        && identity(baseRecord) !== identity(record)
      ) {
        fail(
          'authority_edit_identity_protected',
          'Authority edit cannot change protected semantic identity fields.',
        );
      }
      const beforeSemantic = baseRecord.payload ?? baseRecord.event;
      const afterSemantic = record.payload ?? record.event;
      const typedDiff = diffPaths(beforeSemantic, afterSemantic);
      if (typedDiff.length === 0) {
        fail(
          'authority_edit_no_change',
          'Authority edit must contain a typed semantic change.',
        );
      }
      const createdAt = input.committedAt ?? now().toISOString();
      const patchId = `patch_edit_${sha256(canonicalJson({
        edit_id: input.editId,
        base_version_hash: input.base.version_hash,
        record,
      })).slice(0, 24)}`;
      const compiled = compileCanonicalDynamicConcept({
        recordId: `authority-edit-record-${input.editId}`,
        record,
        patchId,
        turnIndex: input.throughTurnIndex,
        turnId: `authority-edit-${input.editId}`,
        candidateId: `authority-edit-${input.editId}`,
        committedAt: createdAt,
        sequenceIndex: 0,
        authorityEdit: {
          edit_id: input.editId,
          base_entity_ref: input.base.entity_ref,
        },
      });
      if (
        compiled.conceptRelativePath !== baseVersion.relative_path
      ) {
        fail(
          'authority_edit_path_protected',
          'Authority edit cannot change the governed concept path.',
        );
      }
      const artifact = {
        schema: 'mnemosyne.authority-edit-artifact.v1',
        edit_id: input.editId,
        command_id: input.commandId,
        chat_id: input.chatId,
        branch_id: input.branchId,
        branch_epoch: input.branchEpoch,
        through_turn_index: input.throughTurnIndex,
        patch_id: patchId,
        base: structuredClone(input.base),
        request: {
          replacement: structuredClone(input.replacement),
          evidence_text: input.evidenceText,
          evidence_quote: input.evidenceQuote,
          source_mode: input.sourceMode,
        },
        record,
        typed_diff: typedDiff,
        concept: {
          relative_path: compiled.conceptRelativePath,
          version_hash: compiled.versionHash,
          contract_hash: compiled.contractHash,
          document: compiled.document,
        },
        created_at: createdAt,
      };
      artifact.artifact_hash = sha256(canonicalJson({
        edit_id: artifact.edit_id,
        command_id: artifact.command_id,
        base: artifact.base,
        record: artifact.record,
        typed_diff: artifact.typed_diff,
        concept_hash: artifact.concept.version_hash,
        created_at: artifact.created_at,
      }));
      const serializedArtifact = `${JSON.stringify(artifact, null, 2)}\n`;
      const sealedArtifactHash = sha256(serializedArtifact);
      const artifactRelativePath = path.posix.join(
        'authority-edits',
        `${input.editId}.json`,
      );
      const backupRelativePath = path.posix.join(
        'authority-edits',
        'backups',
        `${input.editId}.md`,
      );
      const artifactPath = path.join(
        opened.chat_save_path,
        artifactRelativePath,
      );
      const backupPath = path.join(
        opened.chat_save_path,
        backupRelativePath,
      );
      const stagingRoot = path.join(
        opened.chat_save_path,
        'staging',
        'authority-edits',
        input.editId,
      );
      const stagedConcept = path.join(stagingRoot, 'concept.md');
      const stagedArtifact = path.join(stagingRoot, 'artifact.json');
      await mkdir(stagingRoot, { recursive: true });
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, baseDocument, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await writeFile(stagedConcept, compiled.document, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await writeFile(stagedArtifact, serializedArtifact, {
        encoding: 'utf8',
        flag: 'wx',
      });

      const prepared = new DatabaseSync(opened.ledger_path);
      try {
        prepared.exec('BEGIN IMMEDIATE');
        prepared.prepare(`
          INSERT INTO patches (
            patch_id,
            chat_id,
            candidate_id,
            reason_code,
            source_index_start,
            source_index_end,
            status,
            prepared_at
          ) VALUES (?, ?, NULL, 'authority_edit', ?, ?, 'prepared', ?)
        `).run(
          patchId,
          input.chatId,
          input.throughTurnIndex,
          input.throughTurnIndex,
          createdAt,
        );
        prepared.prepare(`
          INSERT INTO patch_files (
            patch_id,
            relative_path,
            before_hash,
            after_hash,
            staging_path,
            inverse_blob_ref
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          patchId,
          `story-memory/${compiled.conceptRelativePath}`,
          input.base.version_hash,
          compiled.versionHash,
          path.relative(opened.chat_save_path, stagedConcept),
          backupRelativePath,
        );
        prepared.prepare(`
          INSERT INTO authority_edits (
            edit_id,
            command_id,
            chat_id,
            branch_id,
            branch_epoch,
            through_turn_index,
            entity_id,
            entity_ref,
            record_kind,
            base_version_hash,
            patch_id,
            relative_path,
            version_hash,
            artifact_path,
            artifact_hash,
            source_ref,
            status,
            created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'prepared', ?
          )
        `).run(
          input.editId,
          input.commandId,
          input.chatId,
          input.branchId,
          input.branchEpoch,
          input.throughTurnIndex,
          compiled.entityId,
          input.base.entity_ref,
          record.kind,
          input.base.version_hash,
          patchId,
          compiled.conceptRelativePath,
          compiled.versionHash,
          artifactRelativePath,
          sealedArtifactHash,
          record.source_ref,
          createdAt,
        );
        prepared.exec('COMMIT');
      } catch (error) {
        try {
          prepared.exec('ROLLBACK');
        } catch {
          // Ignore rollback after a failed begin.
        }
        throw error;
      } finally {
        prepared.close();
      }

      const preparedDatabase = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let preparedRow;
      try {
        preparedRow = existingByEdit(
          preparedDatabase,
          input.editId,
        );
      } finally {
        preparedDatabase.close();
      }
      return resumeAuthorityEdit(opened, preparedRow);
    });
  }

  return Object.freeze({
    compile,

    async exportContract({ chatId, editId } = {}) {
      if (
        typeof chatId !== 'string'
        || !chatId
        || !SAFE_ID_PATTERN.test(editId ?? '')
      ) {
        fail(
          'authority_edit_input_invalid',
          'Authority edit export input is invalid.',
        );
      }
      const opened = await store.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, {
        readOnly: true,
      });
      let row;
      try {
        row = database.prepare(`
          SELECT * FROM authority_edits
          WHERE edit_id = ? AND chat_id = ? AND status = 'applied'
        `).get(editId, chatId);
      } finally {
        database.close();
      }
      if (!row) {
        fail(
          'authority_edit_not_found',
          'Applied authority edit does not exist.',
        );
      }
      const { artifact } = await readVerifiedAuthorityEditArtifact({
        row,
        chatSavePath: opened.chat_save_path,
        chatId,
      });
      const payload = {
        schema: 'mnemosyne.authority-edit-replay.v1',
        artifact,
      };
      return {
        ...payload,
        contract_hash: sha256(canonicalJson(payload)),
      };
    },

    async applyContract({ contract, targetChatId } = {}) {
      const payload = {
        schema: contract?.schema,
        artifact: contract?.artifact,
      };
      if (
        payload.schema !== 'mnemosyne.authority-edit-replay.v1'
        || contract.contract_hash !== sha256(canonicalJson(payload))
        || typeof targetChatId !== 'string'
        || !targetChatId
      ) {
        fail(
          'authority_edit_replay_invalid',
          'Authority edit replay contract is invalid.',
        );
      }
      const artifact = payload.artifact;
      const result = await compile({
        commandId: artifact.command_id,
        editId: artifact.edit_id,
        chatId: targetChatId,
        branchId: artifact.branch_id,
        branchEpoch: artifact.branch_epoch,
        throughTurnIndex: artifact.through_turn_index,
        base: artifact.base,
        replacement: artifact.request.replacement,
        evidenceText: artifact.request.evidence_text,
        evidenceQuote: artifact.request.evidence_quote,
        sourceMode: artifact.request.source_mode,
        committedAt: artifact.created_at,
      });
      if (
        result.version_hash !== artifact.concept.version_hash
      ) {
        fail(
          'authority_edit_replay_mismatch',
          'Authority edit replay did not reproduce the concept version.',
        );
      }
      return {
        schema: 'mnemosyne.authority-edit-replay-result.v1',
        status: result.status,
        edit_id: result.edit_id,
        version_hash: result.version_hash,
      };
    },
  });
}
