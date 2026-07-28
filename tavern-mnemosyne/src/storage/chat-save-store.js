import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parse, stringify } from 'yaml';

import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  sourceLabelForPromptIdentifier,
} from '../contracts/author-source-route.js';
import { staticLoreSnapshotHash } from '../intake/static-lore-source-identity.js';
import {
  CORE_RELATION_DEFINITIONS,
  OKF_TYPE_DIRECTORIES,
} from '../okf/schema.js';
import {
  assertSqliteWalRuntimeSafe,
  probeSqliteWalRuntime,
  sqliteWalRuntimePolicyFromHarness,
} from './sqlite-wal-runtime-safety.js';

const MANIFEST_SCHEMA = 'mnemosyne.chat-save-manifest.v1';
const LEDGER_SCHEMA_VERSION = 7;
const STORY_MEMORY_DIRECTORIES = [
  ...new Set(Object.values(OKF_TYPE_DIRECTORIES)),
];
const REQUIRED_RELATIVE_PATHS = [
  'manifest.yaml',
  'memory-ledger.sqlite',
  'story-memory/index.md',
  'story-memory/log.md',
  'story-memory/redirects.yaml',
  'story-memory/relation-registry.yaml',
  'story-memory/attribute-registry.yaml',
  'author-sources/static-lore',
  'derived',
  ...STORY_MEMORY_DIRECTORIES.map(directory => `story-memory/${directory}`),
];
const STATIC_LORE_SOURCE_KINDS = new Set([
  'character_card',
  'worldbook',
  'persona',
  'scenario',
]);
const CHAT_INITIALIZATION_LOCKS = new Map();

async function withChatInitializationLock(lockKey, task) {
  const previous = CHAT_INITIALIZATION_LOCKS.get(lockKey) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  CHAT_INITIALIZATION_LOCKS.set(lockKey, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (CHAT_INITIALIZATION_LOCKS.get(lockKey) === current) {
      CHAT_INITIALIZATION_LOCKS.delete(lockKey);
    }
  }
}

function chatDirectoryName(chatId) {
  const digest = createHash('sha256').update(chatId).digest('hex');
  return `chat-${digest.slice(0, 24)}`;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeOnce(filePath, content) {
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function createManifest({ chatId, characterId, createdAt }) {
  return {
    schema: MANIFEST_SCHEMA,
    schema_version: 1,
    chat_id: chatId,
    character_id: characterId,
    created_at: createdAt,
    story_memory_path: 'story-memory',
    ledger_path: 'memory-ledger.sqlite',
    redirects_path: 'story-memory/redirects.yaml',
    relation_registry_path: 'story-memory/relation-registry.yaml',
    attribute_registry_path: 'story-memory/attribute-registry.yaml',
    static_lore_snapshots_path: 'author-sources/static-lore',
    derived_path: 'derived',
  };
}

function assertManifestIdentity(manifest, { chatId, characterId }) {
  if (
    manifest?.schema !== MANIFEST_SCHEMA
    || manifest?.chat_id !== chatId
    || manifest?.character_id !== characterId
  ) {
    throw new Error('Existing chat-save manifest does not match the requested chat.');
  }
}

function assertStaticLoreInput({ hostBinding, sources, promptFingerprints }) {
  for (const field of ['connection_profile_name', 'preset_name', 'model']) {
    if (!String(hostBinding?.[field] || '').trim()) {
      throw new Error(`hostBinding.${field} is required.`);
    }
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('Static Lore sources must be a non-empty array.');
  }
  const sourceIds = new Set();
  for (const source of sources) {
    if (!String(source?.source_id || '').trim()) {
      throw new Error('Every Static Lore source requires source_id.');
    }
    if (sourceIds.has(source.source_id)) {
      throw new Error(`Duplicate Static Lore source_id: ${source.source_id}`);
    }
    sourceIds.add(source.source_id);
    if (!STATIC_LORE_SOURCE_KINDS.has(source.source_kind)) {
      throw new Error(`Unsupported Static Lore source_kind: ${source.source_kind}`);
    }
    if (!String(source.host_ref || '').trim()) {
      throw new Error(`Static Lore source ${source.source_id} requires host_ref.`);
    }
    if (source.data === undefined) {
      throw new Error(`Static Lore source ${source.source_id} requires data.`);
    }
  }

  if (!Array.isArray(promptFingerprints)) {
    throw new Error('promptFingerprints must be an array.');
  }
  const identifiers = new Set();
  for (const fingerprint of promptFingerprints) {
    const expectedLabel = sourceLabelForPromptIdentifier(
      fingerprint?.identifier,
    );
    if (!expectedLabel || fingerprint.source_label !== expectedLabel) {
      throw new Error(`Unsupported prompt fingerprint: ${fingerprint?.identifier}`);
    }
    if (identifiers.has(fingerprint.identifier)) {
      throw new Error(`Duplicate prompt fingerprint: ${fingerprint.identifier}`);
    }
    identifiers.add(fingerprint.identifier);
    if (!/^[a-f0-9]{64}$/.test(fingerprint.prompt_message_hash ?? '')) {
      throw new Error(`Invalid prompt message hash: ${fingerprint.identifier}`);
    }
  }
}

function assertStaticLoreSnapshotId(snapshotId) {
  if (!/^snapshot_[a-f0-9]{24}$/.test(snapshotId ?? '')) {
    throw new Error('Static Lore snapshot id is invalid.');
  }
}

function assertReconcilePlanIdentity(plan, { chatId, snapshotId }) {
  if (
    !plan
    || typeof plan !== 'object'
    || Array.isArray(plan)
    || plan.chat_id !== chatId
    || plan.snapshot_id !== snapshotId
  ) {
    throw new Error('Static Lore reconcile plan identity mismatch.');
  }
}

function tableColumns(database, tableName) {
  return new Set(
    database.prepare(`PRAGMA table_info("${tableName}")`)
      .all()
      .map(column => column.name),
  );
}

function addColumnIfMissing(database, tableName, columnName, definition) {
  if (tableColumns(database, tableName).has(columnName)) return;
  database.exec(
    `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`,
  );
}

function migrateLedgerDatabaseToLatest(database, appliedAt) {
  database.exec('PRAGMA foreign_keys = ON');
  try {
    database.exec('BEGIN IMMEDIATE');
    const currentVersion = Number(database.prepare(`
      SELECT MAX(version) AS version
      FROM schema_migrations
    `).get()?.version ?? 0);
    if (currentVersion > LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `Ledger schema v${currentVersion} is newer than supported v${LEDGER_SCHEMA_VERSION}.`,
      );
    }

    addColumnIfMissing(
      database,
      'concept_versions',
      'snapshot_id',
      'TEXT REFERENCES static_lore_snapshots(snapshot_id)',
    );
    addColumnIfMissing(
      database,
      'concept_versions',
      'intake_id',
      'TEXT REFERENCES intake_runs(intake_id)',
    );
    addColumnIfMissing(
      database,
      'claims',
      'snapshot_id',
      'TEXT REFERENCES static_lore_snapshots(snapshot_id)',
    );
    addColumnIfMissing(
      database,
      'claims',
      'intake_id',
      'TEXT REFERENCES intake_runs(intake_id)',
    );
    addColumnIfMissing(
      database,
      'typed_link_changes',
      'snapshot_id',
      'TEXT REFERENCES static_lore_snapshots(snapshot_id)',
    );
    addColumnIfMissing(
      database,
      'typed_link_changes',
      'intake_id',
      'TEXT REFERENCES intake_runs(intake_id)',
    );
    addColumnIfMissing(
      database,
      'typed_link_changes',
      'status',
      "TEXT NOT NULL DEFAULT 'active'",
    );
    database.exec(`
      UPDATE typed_link_changes
      SET status = 'active'
      WHERE status IS NULL OR status = ''
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS attribute_registry_versions (
        attribute_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        intake_id TEXT NOT NULL REFERENCES intake_runs(intake_id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (attribute_id, snapshot_id, intake_id)
      )
    `);

    const activeBaseline = database.prepare(`
      SELECT
        static_lore_snapshots.snapshot_id,
        intake_runs.intake_id
      FROM static_lore_snapshots
      JOIN intake_runs
        ON intake_runs.snapshot_id = static_lore_snapshots.snapshot_id
      WHERE
        static_lore_snapshots.status = 'active'
        AND intake_runs.status = 'completed'
      ORDER BY
        intake_runs.completed_at DESC,
        intake_runs.started_at DESC,
        intake_runs.intake_id DESC
      LIMIT 1
    `).get();
    if (activeBaseline) {
      for (const tableName of ['concept_versions', 'claims']) {
        database.prepare(`
          UPDATE "${tableName}"
          SET snapshot_id = ?, intake_id = ?
          WHERE
            patch_id IS NULL
            AND status = 'baseline'
            AND (snapshot_id IS NULL OR intake_id IS NULL)
        `).run(activeBaseline.snapshot_id, activeBaseline.intake_id);
      }
      database.prepare(`
        UPDATE typed_link_changes
        SET snapshot_id = ?, intake_id = ?
        WHERE
          patch_id IS NULL
          AND status = 'active'
          AND (snapshot_id IS NULL OR intake_id IS NULL)
      `).run(activeBaseline.snapshot_id, activeBaseline.intake_id);
      database.prepare(`
        INSERT OR IGNORE INTO attribute_registry_versions (
          attribute_id,
          definition_hash,
          snapshot_id,
          intake_id,
          status,
          created_at
        )
        SELECT
          attribute_id,
          definition_hash,
          ?,
          ?,
          'active',
          ?
        FROM attribute_registry
        WHERE patch_id IS NULL AND status = 'active'
      `).run(
        activeBaseline.snapshot_id,
        activeBaseline.intake_id,
        appliedAt,
      );
    }

    database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (2, ?)
    `).run(appliedAt);
    database.exec(`
      CREATE TABLE IF NOT EXISTS chat_saves (
        chat_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        turn_index INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        branch_epoch INTEGER NOT NULL,
        message_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (chat_id, branch_id, turn_index, branch_epoch)
      );
      CREATE TABLE IF NOT EXISTS turn_candidates (
        candidate_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(turn_id),
        swipe_id INTEGER,
        body_hash TEXT NOT NULL,
        patch_id TEXT,
        status TEXT NOT NULL,
        activated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS patches (
        patch_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        candidate_id TEXT,
        reason_code TEXT NOT NULL,
        source_index_start INTEGER,
        source_index_end INTEGER,
        status TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        applied_at TEXT,
        rolled_back_at TEXT
      )
    `);
    addColumnIfMissing(database, 'turns', 'run_id', 'TEXT');
    addColumnIfMissing(
      database,
      'turn_candidates',
      'artifact_path',
      'TEXT',
    );
    addColumnIfMissing(
      database,
      'turn_candidates',
      'delta_hash',
      'TEXT',
    );
    addColumnIfMissing(
      database,
      'turn_candidates',
      'prompt_spine_hash',
      'TEXT',
    );
    addColumnIfMissing(
      database,
      'turn_candidates',
      'artifact_hash',
      'TEXT',
    );
    addColumnIfMissing(
      database,
      'turn_candidates',
      'run_id',
      'TEXT',
    );
    database.exec(`
      CREATE TABLE IF NOT EXISTS turn_memory_records (
        record_id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL REFERENCES patches(patch_id),
        candidate_id TEXT NOT NULL REFERENCES turn_candidates(candidate_id),
        sequence_index INTEGER NOT NULL,
        record_kind TEXT NOT NULL,
        entity_ref TEXT NOT NULL,
        summary TEXT NOT NULL,
        state_domain TEXT,
        state_key TEXT,
        state_value_json TEXT,
        state_operation TEXT NOT NULL DEFAULT 'set',
        source_ref TEXT NOT NULL,
        source_start INTEGER NOT NULL,
        source_end INTEGER NOT NULL,
        source_mode TEXT,
        support_strength TEXT NOT NULL,
        status TEXT NOT NULL,
        UNIQUE (candidate_id, sequence_index)
      );
      CREATE TABLE IF NOT EXISTS branch_epochs (
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        branch_id TEXT NOT NULL,
        branch_epoch INTEGER NOT NULL,
        parent_branch_epoch INTEGER,
        parent_cutoff_turn_index_exclusive INTEGER,
        status TEXT NOT NULL,
        head_turn_index INTEGER,
        created_by_event_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, branch_id, branch_epoch)
      );
      CREATE TABLE IF NOT EXISTS history_events (
        event_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        branch_id TEXT NOT NULL,
        branch_epoch INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (3, ?)
    `).run(appliedAt);
    addColumnIfMissing(
      database,
      'turn_memory_records',
      'source_mode',
      'TEXT',
    );
    database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (4, ?)
    `).run(appliedAt);
    addColumnIfMissing(
      database,
      'turn_memory_records',
      'record_payload_json',
      'TEXT',
    );
    database.exec(`
      CREATE TABLE IF NOT EXISTS source_prompt_fingerprint_observations (
        observation_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        run_id TEXT NOT NULL,
        identifier TEXT NOT NULL,
        source_label TEXT NOT NULL,
        prompt_message_hash TEXT NOT NULL,
        prompt_spine_hash TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (snapshot_id, run_id, identifier)
      );
      CREATE TABLE IF NOT EXISTS source_prompt_fingerprints (
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        identifier TEXT NOT NULL,
        source_label TEXT NOT NULL,
        prompt_message_hash TEXT NOT NULL,
        observation_id TEXT REFERENCES source_prompt_fingerprint_observations(observation_id),
        PRIMARY KEY (snapshot_id, identifier)
      )
    `);
    addColumnIfMissing(
      database,
      'source_prompt_fingerprints',
      'observation_id',
      'TEXT REFERENCES source_prompt_fingerprint_observations(observation_id)',
    );
    database.exec(`
      CREATE TABLE IF NOT EXISTS authority_edits (
        edit_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        branch_id TEXT NOT NULL,
        branch_epoch INTEGER NOT NULL,
        through_turn_index INTEGER NOT NULL,
        entity_id TEXT NOT NULL,
        entity_ref TEXT NOT NULL,
        record_kind TEXT NOT NULL,
        base_version_hash TEXT NOT NULL,
        patch_id TEXT NOT NULL REFERENCES patches(patch_id),
        relative_path TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(LEDGER_SCHEMA_VERSION, appliedAt);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may have failed before BEGIN completed.
    }
    throw error;
  }
}

function migrateLedgerToLatest(ledgerPath, appliedAt) {
  const database = new DatabaseSync(ledgerPath);
  try {
    migrateLedgerDatabaseToLatest(database, appliedAt);
  } finally {
    database.close();
  }
}

function initializeLedger(ledgerPath, manifest) {
  const database = new DatabaseSync(ledgerPath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_saves (
        chat_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        turn_index INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        branch_epoch INTEGER NOT NULL,
        message_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (chat_id, branch_id, turn_index, branch_epoch)
      );
      CREATE TABLE IF NOT EXISTS turn_candidates (
        candidate_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(turn_id),
        swipe_id INTEGER,
        body_hash TEXT NOT NULL,
        patch_id TEXT,
        status TEXT NOT NULL,
        activated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS patches (
        patch_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        candidate_id TEXT,
        reason_code TEXT NOT NULL,
        source_index_start INTEGER,
        source_index_end INTEGER,
        status TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        applied_at TEXT,
        rolled_back_at TEXT
      );
      CREATE TABLE IF NOT EXISTS patch_files (
        patch_id TEXT NOT NULL REFERENCES patches(patch_id),
        relative_path TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        staging_path TEXT,
        inverse_blob_ref TEXT,
        PRIMARY KEY (patch_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS patch_sources (
        patch_id TEXT NOT NULL REFERENCES patches(patch_id),
        source_turn_id TEXT NOT NULL,
        PRIMARY KEY (patch_id, source_turn_id)
      );
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY,
        patch_id TEXT REFERENCES patches(patch_id),
        concept_entity_id TEXT NOT NULL,
        section_ref TEXT,
        claim_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_id TEXT REFERENCES static_lore_snapshots(snapshot_id),
        intake_id TEXT REFERENCES intake_runs(intake_id)
      );
      CREATE TABLE IF NOT EXISTS claim_sources (
        claim_id TEXT NOT NULL REFERENCES claims(claim_id),
        source_ref TEXT NOT NULL,
        PRIMARY KEY (claim_id, source_ref)
      );
      CREATE TABLE IF NOT EXISTS claim_dependencies (
        claim_id TEXT NOT NULL REFERENCES claims(claim_id),
        depends_on_claim_id TEXT NOT NULL REFERENCES claims(claim_id),
        PRIMARY KEY (claim_id, depends_on_claim_id)
      );
      CREATE TABLE IF NOT EXISTS concept_versions (
        entity_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        patch_id TEXT REFERENCES patches(patch_id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot_id TEXT REFERENCES static_lore_snapshots(snapshot_id),
        intake_id TEXT REFERENCES intake_runs(intake_id),
        PRIMARY KEY (entity_id, version_hash)
      );
      CREATE TABLE IF NOT EXISTS concept_redirects (
        old_path TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        current_path TEXT NOT NULL,
        patch_id TEXT REFERENCES patches(patch_id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relation_registry (
        relation_id TEXT PRIMARY KEY,
        parent_relation_id TEXT,
        definition_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        patch_id TEXT REFERENCES patches(patch_id)
      );
      CREATE TABLE IF NOT EXISTS typed_link_changes (
        link_change_id TEXT PRIMARY KEY,
        patch_id TEXT REFERENCES patches(patch_id),
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        relation_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        snapshot_id TEXT REFERENCES static_lore_snapshots(snapshot_id),
        intake_id TEXT REFERENCES intake_runs(intake_id),
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attribute_registry (
        attribute_id TEXT PRIMARY KEY,
        definition_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        patch_id TEXT REFERENCES patches(patch_id)
      );
      CREATE TABLE IF NOT EXISTS attribute_registry_versions (
        attribute_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        intake_id TEXT NOT NULL REFERENCES intake_runs(intake_id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (attribute_id, snapshot_id, intake_id)
      );
      CREATE TABLE IF NOT EXISTS attribute_value_changes (
        value_change_id TEXT PRIMARY KEY,
        patch_id TEXT REFERENCES patches(patch_id),
        entity_id TEXT NOT NULL,
        attribute_id TEXT NOT NULL,
        value_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        source_ref TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delete_events (
        delete_event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        branch_epoch INTEGER NOT NULL,
        from_turn_index INTEGER,
        reason_code TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gc_events (
        gc_event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        status TEXT NOT NULL,
        result_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS derived_state (
        projection_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        projection_kind TEXT NOT NULL,
        source_version_hash TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS static_lore_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chat_saves(chat_id),
        aggregate_hash TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        host_binding_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE (chat_id, aggregate_hash)
      );
      CREATE TABLE IF NOT EXISTS static_lore_sources (
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        source_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        host_ref_hash TEXT,
        PRIMARY KEY (snapshot_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS intake_runs (
        intake_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        extractor_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS source_prompt_fingerprint_observations (
        observation_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        run_id TEXT NOT NULL,
        identifier TEXT NOT NULL,
        source_label TEXT NOT NULL,
        prompt_message_hash TEXT NOT NULL,
        prompt_spine_hash TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (snapshot_id, run_id, identifier)
      );
      CREATE TABLE IF NOT EXISTS source_prompt_fingerprints (
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        identifier TEXT NOT NULL,
        source_label TEXT NOT NULL,
        prompt_message_hash TEXT NOT NULL,
        observation_id TEXT REFERENCES source_prompt_fingerprint_observations(observation_id),
        PRIMARY KEY (snapshot_id, identifier)
      );
      CREATE TABLE IF NOT EXISTS source_removal_grants (
        grant_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES static_lore_snapshots(snapshot_id),
        identifier TEXT NOT NULL,
        source_label TEXT NOT NULL,
        prompt_message_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        verified_at TEXT,
        UNIQUE (run_id, identifier)
      );
    `);
    database.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(1, new Date().toISOString());
    migrateLedgerDatabaseToLatest(database, new Date().toISOString());
    database.prepare(`
      INSERT OR IGNORE INTO chat_saves (
        chat_id,
        character_id,
        created_at,
        manifest_hash
      ) VALUES (?, ?, ?, ?)
    `).run(
      manifest.chat_id,
      manifest.character_id,
      manifest.created_at,
      createHash('sha256').update(stringify(manifest)).digest('hex'),
    );
    const insertRelation = database.prepare(`
      INSERT OR IGNORE INTO relation_registry (
        relation_id,
        parent_relation_id,
        definition_hash,
        status
      ) VALUES (?, ?, ?, ?)
    `);
    for (const relation of CORE_RELATION_DEFINITIONS) {
      insertRelation.run(
        relation.id,
        null,
        sha256(canonicalJson(relation)),
        relation.status,
      );
    }
  } finally {
    database.close();
  }
}

function inspectLedger(ledgerPath) {
  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const row = database.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get();
    const tables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(entry => entry.name);
    const columns = Object.fromEntries(tables.map(table => [
      table,
      database.prepare(`PRAGMA table_info("${table}")`).all().map(entry => entry.name),
    ]));
    return {
      schemaVersion: Number(row?.version ?? 0),
      tables,
      columns,
    };
  } finally {
    database.close();
  }
}

function readStaticLoreLedgerStatus(ledgerPath) {
  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    const count = database.prepare(`
      SELECT COUNT(*) AS count FROM static_lore_snapshots
    `).get();
    const latest = database.prepare(`
      SELECT aggregate_hash
      FROM static_lore_snapshots
      ORDER BY captured_at DESC, snapshot_id DESC
      LIMIT 1
    `).get();
    return {
      count: Number(count?.count ?? 0),
      latestHash: latest?.aggregate_hash ?? null,
    };
  } finally {
    database.close();
  }
}

function ensurePreparedStaticLoreIntake(database, {
  intakeId,
  snapshotId,
  mode,
  extractor,
  timestamp,
}) {
  const existing = database.prepare(`
    SELECT
      snapshot_id,
      mode,
      status,
      extractor_id,
      input_tokens,
      output_tokens
    FROM intake_runs
    WHERE intake_id = ?
  `).get(intakeId);
  if (existing) {
    if (
      existing.snapshot_id !== snapshotId
      || existing.mode !== mode
      || existing.status !== 'prepared'
      || existing.extractor_id !== extractor.id
      || existing.input_tokens !== extractor.input_tokens
      || existing.output_tokens !== extractor.output_tokens
    ) {
      throw new Error('Static Lore prepared intake identity mismatch.');
    }
    return;
  }
  database.prepare(`
    INSERT INTO intake_runs (
      intake_id,
      snapshot_id,
      mode,
      status,
      extractor_id,
      input_tokens,
      output_tokens,
      started_at
    ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?)
  `).run(
    intakeId,
    snapshotId,
    mode,
    extractor.id,
    extractor.input_tokens,
    extractor.output_tokens,
    timestamp,
  );
}

function prepareStaticLoreIntakeInLedger({
  ledgerPath,
  chatId,
  snapshotId,
  intakeId,
  extractor,
  previousSnapshotId,
  timestamp,
}) {
  const database = new DatabaseSync(ledgerPath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const snapshot = database.prepare(`
      SELECT snapshot_id
      FROM static_lore_snapshots
      WHERE
        snapshot_id = ?
        AND chat_id = ?
        AND status IN ('captured', 'superseded')
    `).get(snapshotId, chatId);
    if (!snapshot) {
      throw new Error(
        'Static Lore Snapshot is not available for intake in this chat.',
      );
    }
    const activeSnapshots = database.prepare(`
      SELECT snapshot_id
      FROM static_lore_snapshots
      WHERE chat_id = ? AND status = 'active'
      ORDER BY captured_at DESC, snapshot_id DESC
    `).all(chatId);
    if (activeSnapshots.length > 1) {
      throw new Error('Chat has more than one active Static Lore Snapshot.');
    }
    const activeSnapshotId = activeSnapshots[0]?.snapshot_id ?? null;
    if (activeSnapshotId !== (previousSnapshotId ?? null)) {
      throw new Error(
        'Static Lore active snapshot changed before its ledger was prepared.',
      );
    }
    ensurePreparedStaticLoreIntake(database, {
      intakeId,
      snapshotId,
      mode: activeSnapshotId ? 'reconcile' : 'initial',
      extractor,
      timestamp,
    });
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may have failed before BEGIN completed.
    }
    throw error;
  } finally {
    database.close();
  }
}

function commitStaticLoreIntakeToLedger({
  ledgerPath,
  chatId,
  snapshotId,
  intakeId,
  extractor,
  concepts,
  registryDefinitions,
  projection,
  previousSnapshotId,
  timestamp,
}) {
  const database = new DatabaseSync(ledgerPath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const snapshot = database.prepare(`
      SELECT snapshot_id, status
      FROM static_lore_snapshots
      WHERE
        snapshot_id = ?
        AND chat_id = ?
        AND status IN ('captured', 'superseded')
    `).get(snapshotId, chatId);
    if (!snapshot) {
      throw new Error(
        'Static Lore Snapshot is not available for intake in this chat.',
      );
    }
    const activeSnapshots = database.prepare(`
      SELECT snapshot_id
      FROM static_lore_snapshots
      WHERE chat_id = ? AND status = 'active'
      ORDER BY captured_at DESC, snapshot_id DESC
    `).all(chatId);
    if (activeSnapshots.length > 1) {
      throw new Error('Chat has more than one active Static Lore Snapshot.');
    }
    const activeSnapshotId = activeSnapshots[0]?.snapshot_id ?? null;
    if (activeSnapshotId !== (previousSnapshotId ?? null)) {
      throw new Error(
        'Static Lore active snapshot changed while its projection was compiling.',
      );
    }
    const mode = activeSnapshotId ? 'reconcile' : 'initial';
    ensurePreparedStaticLoreIntake(database, {
      intakeId,
      snapshotId,
      mode,
      extractor,
      timestamp,
    });

    if (mode === 'reconcile') {
      database.prepare(`
        UPDATE concept_versions
        SET status = 'superseded'
        WHERE
          snapshot_id = ?
          AND patch_id IS NULL
          AND status = 'baseline'
      `).run(activeSnapshotId);
      database.prepare(`
        UPDATE claims
        SET status = 'superseded'
        WHERE
          snapshot_id = ?
          AND patch_id IS NULL
          AND status = 'baseline'
      `).run(activeSnapshotId);
      database.prepare(`
        UPDATE typed_link_changes
        SET status = 'superseded'
        WHERE
          snapshot_id = ?
          AND patch_id IS NULL
          AND status = 'active'
      `).run(activeSnapshotId);
      database.prepare(`
        UPDATE attribute_registry_versions
        SET status = 'superseded'
        WHERE snapshot_id = ? AND status = 'active'
      `).run(activeSnapshotId);
    }
    const findPathOwner = database.prepare(`
      SELECT entity_id
      FROM concept_versions
      WHERE relative_path = ? AND entity_id <> ?
      LIMIT 1
    `);
    const insertConcept = database.prepare(`
      INSERT INTO concept_versions (
        entity_id,
        version_hash,
        relative_path,
        status,
        created_at,
        snapshot_id,
        intake_id
      ) VALUES (?, ?, ?, 'baseline', ?, ?, ?)
      ON CONFLICT(entity_id, version_hash) DO UPDATE SET
        relative_path = excluded.relative_path,
        status = 'baseline',
        created_at = excluded.created_at,
        snapshot_id = excluded.snapshot_id,
        intake_id = excluded.intake_id
      WHERE concept_versions.patch_id IS NULL
    `);
    const insertClaim = database.prepare(`
      INSERT INTO claims (
        claim_id,
        concept_entity_id,
        section_ref,
        claim_hash,
        status,
        snapshot_id,
        intake_id
      ) VALUES (?, ?, ?, ?, 'baseline', ?, ?)
      ON CONFLICT(claim_id) DO UPDATE SET
        concept_entity_id = excluded.concept_entity_id,
        section_ref = excluded.section_ref,
        claim_hash = excluded.claim_hash,
        status = 'baseline',
        snapshot_id = excluded.snapshot_id,
        intake_id = excluded.intake_id
      WHERE claims.patch_id IS NULL
    `);
    const insertClaimSource = database.prepare(`
      INSERT OR IGNORE INTO claim_sources (claim_id, source_ref)
      VALUES (?, ?)
    `);
    const insertLink = database.prepare(`
      INSERT INTO typed_link_changes (
        link_change_id,
        source_entity_id,
        target_entity_id,
        relation_id,
        operation,
        source_ref,
        snapshot_id,
        intake_id,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(link_change_id) DO UPDATE SET
        source_entity_id = excluded.source_entity_id,
        target_entity_id = excluded.target_entity_id,
        relation_id = excluded.relation_id,
        operation = excluded.operation,
        source_ref = excluded.source_ref,
        snapshot_id = excluded.snapshot_id,
        intake_id = excluded.intake_id,
        status = 'active'
      WHERE typed_link_changes.patch_id IS NULL
    `);
    for (const concept of concepts) {
      const pathOwner = findPathOwner.get(
        concept.relative_path,
        concept.entity_id,
      );
      if (pathOwner) {
        throw new Error(
          `Static Lore concept path was already owned by another entity: ${concept.relative_path}`,
        );
      }
      const insertedConcept = insertConcept.run(
        concept.entity_id,
        concept.version_hash,
        concept.relative_path,
        timestamp,
        snapshotId,
        intakeId,
      );
      if (insertedConcept.changes !== 1) {
        throw new Error(
          `Static Lore concept conflicts with a dynamic concept version: ${concept.entity_id}`,
        );
      }
      for (const claim of concept.claims) {
        const insertedClaim = insertClaim.run(
          claim.claim_id,
          concept.entity_id,
          claim.section_ref,
          claim.claim_hash,
          snapshotId,
          intakeId,
        );
        if (insertedClaim.changes !== 1) {
          throw new Error(
            `Static Lore claim conflicts with a dynamic claim: ${claim.claim_id}`,
          );
        }
        for (const sourceRef of claim.source_refs) {
          insertClaimSource.run(claim.claim_id, sourceRef);
        }
      }
      for (const link of concept.links) {
        const insertedLink = insertLink.run(
          link.link_change_id,
          concept.entity_id,
          link.target_entity_id,
          link.relation_id,
          mode === 'reconcile' ? 'reconcile' : 'initialize',
          link.source_ref,
          snapshotId,
          intakeId,
        );
        if (insertedLink.changes !== 1) {
          throw new Error(
            `Static Lore link conflicts with a dynamic link: ${link.link_change_id}`,
          );
        }
      }
    }

    database.prepare(`
      UPDATE attribute_registry
      SET status = 'superseded'
      WHERE status = 'active' AND patch_id IS NULL
    `).run();
    const insertRegistryDefinition = database.prepare(`
      INSERT INTO attribute_registry (
        attribute_id,
        definition_hash,
        status
      ) VALUES (?, ?, 'active')
      ON CONFLICT(attribute_id) DO UPDATE SET
        definition_hash = excluded.definition_hash,
        status = 'active'
      WHERE attribute_registry.patch_id IS NULL
    `);
    for (const definition of registryDefinitions) {
      const updated = insertRegistryDefinition.run(
        definition.attribute_id,
        definition.definition_hash,
      );
      if (updated.changes !== 1) {
        throw new Error(
          `Static Lore attribute conflicts with a dynamic registry definition: ${definition.attribute_id}`,
        );
      }
      database.prepare(`
        INSERT INTO attribute_registry_versions (
          attribute_id,
          definition_hash,
          snapshot_id,
          intake_id,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, 'active', ?)
      `).run(
        definition.attribute_id,
        definition.definition_hash,
        snapshotId,
        intakeId,
        timestamp,
      );
    }
    database.prepare(`
      UPDATE derived_state
      SET status = 'superseded', updated_at = ?
      WHERE
        chat_id = ?
        AND projection_kind = 'runtime_world'
        AND status = 'ready'
    `).run(timestamp, chatId);
    database.prepare(`
      INSERT INTO derived_state (
        projection_id,
        chat_id,
        projection_kind,
        source_version_hash,
        status,
        updated_at
      ) VALUES (?, ?, ?, ?, 'ready', ?)
    `).run(
      projection.projection_id,
      chatId,
      projection.projection_kind,
      projection.source_version_hash,
      timestamp,
    );
    database.prepare(`
      UPDATE static_lore_snapshots
      SET status = 'superseded'
      WHERE chat_id = ? AND status = 'active' AND snapshot_id <> ?
    `).run(chatId, snapshotId);
    const activated = database.prepare(`
      UPDATE static_lore_snapshots
      SET status = 'active'
      WHERE
        snapshot_id = ?
        AND chat_id = ?
        AND status IN ('captured', 'superseded')
    `).run(snapshotId, chatId);
    if (activated.changes !== 1) {
      throw new Error('Static Lore Snapshot could not be activated.');
    }
    const completed = database.prepare(`
      UPDATE intake_runs
      SET status = 'completed', completed_at = ?
      WHERE intake_id = ? AND status = 'prepared'
    `).run(timestamp, intakeId);
    if (completed.changes !== 1) {
      throw new Error('Static Lore prepared intake could not be completed.');
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may have failed before BEGIN completed.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function createChatSaveStore(options = {}) {
  if (
    !options
    || typeof options !== 'object'
    || Array.isArray(options)
  ) {
    throw new TypeError('Chat-save store options must be an object.');
  }
  if (Object.hasOwn(options, 'sqliteRuntime')) {
    const error = new Error(
      'The chat-save storage seam does not accept a SQLite runtime override.',
    );
    error.code = 'SQLITE_WAL_RUNTIME_OVERRIDE_FORBIDDEN';
    throw error;
  }
  const {
    rootDir,
    now = () => new Date(),
  } = options;
  if (!rootDir) {
    throw new Error('A chat-save rootDir is required.');
  }
  const sqliteRuntimePolicy = sqliteWalRuntimePolicyFromHarness();
  const sqliteRuntime = sqliteRuntimePolicy.context === 'production'
    ? probeSqliteWalRuntime()
    : { sqlite_version: process.versions.sqlite };
  assertSqliteWalRuntimeSafe({
    context: sqliteRuntimePolicy.context,
    sqliteVersion: sqliteRuntime.sqlite_version,
  });
  const resolvedRoot = path.resolve(rootDir);

  function resolveChatSavePath(chatId) {
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('chatId is required.');
    }
    return path.join(resolvedRoot, chatDirectoryName(chatId));
  }

  async function persistStaticLoreSnapshot({
    chatId,
    snapshot,
    requireExactExisting = false,
  }) {
    if (
      snapshot?.schema !== 'mnemosyne.static-lore-snapshot.v1'
      || snapshot.chat_id !== chatId
      || typeof snapshot.character_id !== 'string'
      || !snapshot.character_id
      || typeof snapshot.captured_at !== 'string'
      || new Date(snapshot.captured_at).toISOString() !== snapshot.captured_at
    ) {
      throw new Error('Static Lore replay snapshot is invalid.');
    }
    assertStaticLoreInput({
      hostBinding: snapshot.host_binding,
      sources: snapshot.sources,
      promptFingerprints: snapshot.prompt_fingerprints,
    });
    const snapshotHash = staticLoreSnapshotHash(snapshot.sources);
    const snapshotId = `snapshot_${snapshotHash.slice(0, 24)}`;
    if (
      snapshot.snapshot_id !== snapshotId
      || snapshot.snapshot_hash !== snapshotHash
    ) {
      throw new Error('Static Lore replay snapshot identity mismatch.');
    }

    const chatSavePath = resolveChatSavePath(chatId);
    const manifestPath = path.join(chatSavePath, 'manifest.yaml');
    if (!await exists(manifestPath)) {
      throw new Error('Chat-save must be initialized before Static Lore capture.');
    }
    const manifest = parse(await readFile(manifestPath, 'utf8'));
    assertManifestIdentity(manifest, {
      chatId,
      characterId: snapshot.character_id,
    });
    const snapshotRelativePath = path.posix.join(
      'author-sources',
      'static-lore',
      snapshotId,
      'snapshot.json',
    );
    const snapshotPath = path.join(chatSavePath, snapshotRelativePath);
    const ledgerPath = path.join(chatSavePath, 'memory-ledger.sqlite');
    const database = new DatabaseSync(ledgerPath);
    let existingSnapshot;
    try {
      existingSnapshot = database.prepare(`
        SELECT snapshot_id
        FROM static_lore_snapshots
        WHERE chat_id = ? AND aggregate_hash = ?
      `).get(chatId, snapshotHash);
    } finally {
      database.close();
    }
    if (existingSnapshot) {
      if (requireExactExisting) {
        const stored = JSON.parse(await readFile(snapshotPath, 'utf8'));
        if (
          existingSnapshot.snapshot_id !== snapshotId
          || canonicalJson(stored) !== canonicalJson(snapshot)
        ) {
          throw new Error(
            'Existing Static Lore replay snapshot does not match.',
          );
        }
      }
      return {
        schema: 'mnemosyne.static-lore-capture-result.v1',
        status: 'existing',
        snapshot_id: existingSnapshot.snapshot_id,
        snapshot_hash: snapshotHash,
      };
    }

    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeOnce(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    const stored = JSON.parse(await readFile(snapshotPath, 'utf8'));
    if (canonicalJson(stored) !== canonicalJson(snapshot)) {
      throw new Error('Stored Static Lore replay snapshot does not match.');
    }

    const writableDatabase = new DatabaseSync(ledgerPath);
    try {
      writableDatabase.exec('BEGIN IMMEDIATE');
      writableDatabase.prepare(`
        INSERT INTO static_lore_snapshots (
          snapshot_id,
          chat_id,
          aggregate_hash,
          relative_path,
          host_binding_hash,
          status,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, 'captured', ?)
      `).run(
        snapshotId,
        chatId,
        snapshotHash,
        snapshotRelativePath,
        sha256(canonicalJson(snapshot.host_binding)),
        snapshot.captured_at,
      );
      const insertSource = writableDatabase.prepare(`
        INSERT INTO static_lore_sources (
          snapshot_id,
          source_id,
          source_kind,
          source_hash,
          relative_path,
          host_ref_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const source of snapshot.sources) {
        insertSource.run(
          snapshotId,
          source.source_id,
          source.source_kind,
          sha256(canonicalJson(source.data)),
          snapshotRelativePath,
          sha256(source.host_ref),
        );
      }
      const insertFingerprint = writableDatabase.prepare(`
        INSERT INTO source_prompt_fingerprints (
          snapshot_id,
          identifier,
          source_label,
          prompt_message_hash
        ) VALUES (?, ?, ?, ?)
      `);
      for (const fingerprint of snapshot.prompt_fingerprints) {
        insertFingerprint.run(
          snapshotId,
          fingerprint.identifier,
          fingerprint.source_label,
          fingerprint.prompt_message_hash,
        );
      }
      writableDatabase.exec('COMMIT');
    } catch (error) {
      try {
        writableDatabase.exec('ROLLBACK');
      } catch {
        // The transaction may have failed before BEGIN completed.
      }
      throw error;
    } finally {
      writableDatabase.close();
    }

    return {
      schema: 'mnemosyne.static-lore-capture-result.v1',
      status: 'captured',
      snapshot_id: snapshotId,
      snapshot_hash: snapshotHash,
    };
  }

  return Object.freeze({
    async initializeChat({ chatId, characterId }) {
      if (!characterId || typeof characterId !== 'string') {
        throw new Error('characterId is required.');
      }

      const chatSavePath = resolveChatSavePath(chatId);
      return withChatInitializationLock(chatSavePath, async () => {
        const manifestPath = path.join(chatSavePath, 'manifest.yaml');
        const alreadyExists = await exists(manifestPath);

        await mkdir(path.join(chatSavePath, 'story-memory'), { recursive: true });
        await Promise.all(STORY_MEMORY_DIRECTORIES.map(directory => (
          mkdir(path.join(chatSavePath, 'story-memory', directory), { recursive: true })
        )));
        await mkdir(path.join(chatSavePath, 'author-sources', 'static-lore'), {
          recursive: true,
        });
        await mkdir(path.join(chatSavePath, 'derived'), { recursive: true });

        const manifest = createManifest({
          chatId,
          characterId,
          createdAt: now().toISOString(),
        });
        if (!alreadyExists) {
          await writeOnce(manifestPath, stringify(manifest));
        }

        const storedManifest = parse(await readFile(manifestPath, 'utf8'));
        assertManifestIdentity(storedManifest, { chatId, characterId });

        await writeOnce(
          path.join(chatSavePath, 'story-memory', 'index.md'),
          '# Story Memory\n',
        );
        await writeOnce(
          path.join(chatSavePath, 'story-memory', 'log.md'),
          '# Memory Log\n',
        );
        await writeOnce(
          path.join(chatSavePath, 'story-memory', 'redirects.yaml'),
          stringify({ schema: 'mnemosyne.redirects.v1', redirects: [] }),
        );
        await writeOnce(
          path.join(chatSavePath, 'story-memory', 'relation-registry.yaml'),
          stringify({
            schema: 'mnemosyne.relation-registry.v1',
            relations: CORE_RELATION_DEFINITIONS,
          }),
        );
        await writeOnce(
          path.join(chatSavePath, 'story-memory', 'attribute-registry.yaml'),
          stringify({
            schema: 'mnemosyne.attribute-registry.v1',
            attributes: [],
            progression_tracks: [],
          }),
        );

        initializeLedger(
          path.join(chatSavePath, 'memory-ledger.sqlite'),
          storedManifest,
        );

        return {
          schema: 'mnemosyne.chat-save-result.v1',
          status: alreadyExists ? 'ready' : 'created',
          chat_save_path: chatSavePath,
          manifest: storedManifest,
        };
      });
    },

    async captureStaticLore({
      chatId,
      hostBinding,
      sources,
      promptFingerprints,
    }) {
      assertStaticLoreInput({ hostBinding, sources, promptFingerprints });
      const chatSavePath = resolveChatSavePath(chatId);
      const manifestPath = path.join(chatSavePath, 'manifest.yaml');
      if (!await exists(manifestPath)) {
        throw new Error('Chat-save must be initialized before Static Lore capture.');
      }
      const manifest = parse(await readFile(manifestPath, 'utf8'));
      if (manifest.chat_id !== chatId) {
        throw new Error('Chat-save manifest identity mismatch.');
      }

      const snapshot = {
        schema: 'mnemosyne.static-lore-snapshot.v1',
        snapshot_id: `snapshot_${staticLoreSnapshotHash(sources).slice(0, 24)}`,
        snapshot_hash: staticLoreSnapshotHash(sources),
        chat_id: chatId,
        character_id: manifest.character_id,
        captured_at: now().toISOString(),
        host_binding: {
          schema: 'mnemosyne.main-host-binding.v1',
          ...structuredClone(hostBinding),
        },
        sources: structuredClone(sources),
        prompt_fingerprints: structuredClone(promptFingerprints),
      };
      return persistStaticLoreSnapshot({ chatId, snapshot });
    },

    async restoreStaticLoreSnapshotForAdmin({ chatId, snapshot }) {
      return persistStaticLoreSnapshot({
        chatId,
        snapshot: structuredClone(snapshot),
        requireExactExisting: true,
      });
    },

    async readStaticLoreSnapshotForAdmin({ chatId, snapshotId }) {
      const chatSavePath = resolveChatSavePath(chatId);
      const snapshotPath = path.join(
        chatSavePath,
        'author-sources',
        'static-lore',
        snapshotId,
        'snapshot.json',
      );
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
      if (snapshot.chat_id !== chatId || snapshot.snapshot_id !== snapshotId) {
        throw new Error('Static Lore Snapshot identity mismatch.');
      }
      return snapshot;
    },

    async getActiveStaticLoreSnapshotForAdmin({ chatId }) {
      const opened = await this.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, { readOnly: true });
      try {
        const active = database.prepare(`
          SELECT snapshot_id, aggregate_hash
          FROM static_lore_snapshots
          WHERE chat_id = ? AND status = 'active'
          ORDER BY captured_at DESC, snapshot_id DESC
        `).all(chatId);
        if (active.length > 1) {
          throw new Error('Chat has more than one active Static Lore Snapshot.');
        }
        if (active.length === 0) return null;
        return {
          snapshot_id: active[0].snapshot_id,
          snapshot_hash: active[0].aggregate_hash,
        };
      } finally {
        database.close();
      }
    },

    async getCompletedStaticLoreIntakeForAdmin({
      chatId,
      snapshotId,
      intakeId,
    }) {
      const opened = await this.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, { readOnly: true });
      try {
        const completed = database.prepare(`
          SELECT
            intake_runs.intake_id,
            intake_runs.snapshot_id,
            static_lore_snapshots.aggregate_hash
          FROM intake_runs
          JOIN static_lore_snapshots
            ON static_lore_snapshots.snapshot_id = intake_runs.snapshot_id
          WHERE
            intake_runs.intake_id = ?
            AND intake_runs.snapshot_id = ?
            AND intake_runs.status = 'completed'
            AND static_lore_snapshots.chat_id = ?
            AND static_lore_snapshots.status = 'active'
        `).get(intakeId, snapshotId, chatId);
        if (!completed) return null;
        return {
          intake_id: completed.intake_id,
          snapshot_id: completed.snapshot_id,
          snapshot_hash: completed.aggregate_hash,
          runtime_projection_hashes: database.prepare(`
            SELECT source_version_hash
            FROM derived_state
            WHERE
              chat_id = ?
              AND projection_kind = 'runtime_world'
              AND status = 'ready'
          `).all(chatId).map(row => row.source_version_hash),
        };
      } finally {
        database.close();
      }
    },

    async openChatForAdmin({ chatId }) {
      const chatSavePath = resolveChatSavePath(chatId);
      const manifestPath = path.join(chatSavePath, 'manifest.yaml');
      if (!await exists(manifestPath)) {
        throw new Error('Chat-save must be initialized before it can be opened.');
      }
      const manifest = parse(await readFile(manifestPath, 'utf8'));
      if (manifest.chat_id !== chatId) {
        throw new Error('Chat-save manifest identity mismatch.');
      }
      const ledgerPath = path.join(chatSavePath, manifest.ledger_path);
      migrateLedgerToLatest(ledgerPath, now().toISOString());
      return {
        chat_save_path: chatSavePath,
        ledger_path: ledgerPath,
        manifest,
      };
    },

    async openChatForAdminIfInitialized({ chatId }) {
      const chatSavePath = resolveChatSavePath(chatId);
      const manifestPath = path.join(chatSavePath, 'manifest.yaml');
      if (!await exists(manifestPath)) return null;
      return this.openChatForAdmin({ chatId });
    },

    async inspectStaticLoreStateForAdmin({ chatId }) {
      const opened = await this.openChatForAdmin({ chatId });
      const database = new DatabaseSync(opened.ledger_path, { readOnly: true });
      try {
        const activeSnapshots = database.prepare(`
          SELECT snapshot_id, aggregate_hash
          FROM static_lore_snapshots
          WHERE chat_id = ? AND status = 'active'
          ORDER BY captured_at DESC, snapshot_id DESC
        `).all(chatId);
        if (activeSnapshots.length > 1) {
          throw new Error('Chat has more than one active Static Lore Snapshot.');
        }
        const activeSnapshot = activeSnapshots[0] ?? null;
        const count = (sql, ...parameters) => Number(
          database.prepare(sql).get(...parameters)?.count ?? 0,
        );
        const dynamicState = {
          applied_patches: count(`
            SELECT COUNT(*) AS count
            FROM patches
            WHERE chat_id = ? AND status = 'applied'
          `, chatId),
          prepared_patches: count(`
            SELECT COUNT(*) AS count
            FROM patches
            WHERE chat_id = ? AND status = 'prepared'
          `, chatId),
          non_baseline_concepts: count(`
            SELECT COUNT(*) AS count
            FROM concept_versions
            WHERE status NOT IN ('baseline', 'superseded')
          `),
          non_baseline_claims: count(`
            SELECT COUNT(*) AS count
            FROM claims
            WHERE status NOT IN ('baseline', 'superseded')
          `),
          active_patch_attributes: count(`
            SELECT COUNT(*) AS count
            FROM attribute_registry
            WHERE patch_id IS NOT NULL AND status = 'active'
          `),
          active_patch_links: count(`
            SELECT COUNT(*) AS count
            FROM typed_link_changes
            WHERE patch_id IS NOT NULL AND status = 'active'
          `),
          attribute_value_changes: count(`
            SELECT COUNT(*) AS count
            FROM attribute_value_changes
          `),
        };
        const dynamicIndicators = Object.entries(dynamicState)
          .filter(([, value]) => value > 0)
          .map(([kind, value]) => ({ kind, count: value }));
        const activeStaticRegistryHashes = database.prepare(`
          SELECT attribute_id, definition_hash
          FROM attribute_registry
          WHERE patch_id IS NULL AND status = 'active'
          ORDER BY attribute_id
        `).all().map(row => ({ ...row }));
        return {
          schema: 'mnemosyne.static-lore-state-inspection.v1',
          chat_id: chatId,
          active_snapshot: activeSnapshot
            ? {
                snapshot_id: activeSnapshot.snapshot_id,
                snapshot_hash: activeSnapshot.aggregate_hash,
              }
            : null,
          baseline_concepts: activeSnapshot
            ? database.prepare(`
                SELECT entity_id, version_hash, relative_path
                FROM concept_versions
                WHERE
                  snapshot_id = ?
                  AND patch_id IS NULL
                  AND status = 'baseline'
                ORDER BY entity_id, version_hash, relative_path
              `).all(activeSnapshot.snapshot_id).map(row => ({ ...row }))
            : [],
          ready_runtime_projection_hashes: database.prepare(`
            SELECT source_version_hash
            FROM derived_state
            WHERE
              chat_id = ?
              AND projection_kind = 'runtime_world'
              AND status = 'ready'
            ORDER BY source_version_hash
          `).all(chatId).map(row => row.source_version_hash),
          active_static_registry_hashes: activeStaticRegistryHashes,
          active_static_registry_definitions: structuredClone(
            activeStaticRegistryHashes,
          ),
          dynamic_state: {
            has_dynamic_state: dynamicIndicators.length > 0,
            indicators: dynamicIndicators,
            ...dynamicState,
          },
        };
      } finally {
        database.close();
      }
    },

    async writeStaticLoreReconcilePlanForAdmin({
      chatId,
      snapshotId,
      plan,
    }) {
      assertStaticLoreSnapshotId(snapshotId);
      assertReconcilePlanIdentity(plan, { chatId, snapshotId });
      const opened = await this.openChatForAdmin({ chatId });
      const relativePath = path.posix.join(
        'derived',
        'reconcile-plans',
        `${snapshotId}.json`,
      );
      const planPath = path.join(opened.chat_save_path, relativePath);
      const temporaryPath = `${planPath}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(planPath), { recursive: true });
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify(plan, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx' },
        );
        await rename(temporaryPath, planPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return { relative_path: relativePath };
    },

    async readStaticLoreReconcilePlanForAdmin({ chatId, snapshotId }) {
      assertStaticLoreSnapshotId(snapshotId);
      const opened = await this.openChatForAdmin({ chatId });
      try {
        const plan = JSON.parse(await readFile(path.join(
          opened.chat_save_path,
          'derived',
          'reconcile-plans',
          `${snapshotId}.json`,
        ), 'utf8'));
        assertReconcilePlanIdentity(plan, { chatId, snapshotId });
        return plan;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    async writeIntakeArtifactForAdmin({
      chatId,
      requestId,
      modelResponse,
      requestMetadata = {},
    }) {
      if (!/^[A-Za-z0-9_-]+$/.test(requestId ?? '')) {
        throw new Error('Static Lore Intake request id is invalid.');
      }
      const opened = await this.openChatForAdmin({ chatId });
      const responseHash = sha256(canonicalJson(modelResponse));
      const relativePath = path.posix.join(
        'derived',
        'intake-artifacts',
        requestId,
        'model-response.json',
      );
      const artifact = {
        schema: 'mnemosyne.static-lore-model-artifact.v1',
        request_id: requestId,
        response_hash: responseHash,
        captured_at: now().toISOString(),
        request_metadata: structuredClone(requestMetadata),
        model_response: structuredClone(modelResponse),
      };
      const artifactPath = path.join(opened.chat_save_path, relativePath);
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeOnce(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
      const stored = JSON.parse(await readFile(artifactPath, 'utf8'));
      if (stored.response_hash !== responseHash) {
        throw new Error('Static Lore Intake artifact request id was reused.');
      }
      return {
        relative_path: relativePath,
        response_hash: responseHash,
      };
    },

    async readIntakeArtifactForAdmin({ chatId, requestId }) {
      if (!/^[A-Za-z0-9_-]+$/.test(requestId ?? '')) {
        throw new Error('Static Lore Intake request id is invalid.');
      }
      const opened = await this.openChatForAdmin({ chatId });
      return JSON.parse(await readFile(path.join(
        opened.chat_save_path,
        'derived',
        'intake-artifacts',
        requestId,
        'model-response.json',
      ), 'utf8'));
    },

    async writeIntakeSessionForAdmin({
      chatId,
      snapshotId,
      session,
    }) {
      if (!/^snapshot_[a-f0-9]{24}$/.test(snapshotId ?? '')) {
        throw new Error('Static Lore Intake snapshot id is invalid.');
      }
      if (
        session?.chat_id !== chatId
        || session?.snapshot_id !== snapshotId
      ) {
        throw new Error('Static Lore Intake session identity mismatch.');
      }
      const opened = await this.openChatForAdmin({ chatId });
      const sessionPath = path.join(
        opened.chat_save_path,
        'derived',
        'intake-sessions',
        `${snapshotId}.json`,
      );
      const temporaryPath = `${sessionPath}.tmp`;
      await mkdir(path.dirname(sessionPath), { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(session, null, 2)}\n`,
        'utf8',
      );
      await rename(temporaryPath, sessionPath);
      return {
        relative_path: path.posix.join(
          'derived',
          'intake-sessions',
          `${snapshotId}.json`,
        ),
      };
    },

    async readIntakeSessionForAdmin({ chatId, snapshotId }) {
      if (!/^snapshot_[a-f0-9]{24}$/.test(snapshotId ?? '')) {
        throw new Error('Static Lore Intake snapshot id is invalid.');
      }
      const opened = await this.openChatForAdmin({ chatId });
      try {
        const session = JSON.parse(await readFile(path.join(
          opened.chat_save_path,
          'derived',
          'intake-sessions',
          `${snapshotId}.json`,
        ), 'utf8'));
        if (
          session?.chat_id !== chatId
          || session?.snapshot_id !== snapshotId
        ) {
          throw new Error('Static Lore Intake session identity mismatch.');
        }
        return session;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    async commitStaticLoreIntake({
      chatId,
      snapshotId,
      intakeId,
      extractor,
      concepts,
      registryDefinitions,
      projection,
      previousSnapshotId,
      supersededEntityIds,
      timestamp,
    }) {
      const opened = await this.openChatForAdmin({ chatId });
      commitStaticLoreIntakeToLedger({
        ledgerPath: opened.ledger_path,
        chatId,
        snapshotId,
        intakeId,
        extractor,
        concepts,
        registryDefinitions,
        projection,
        previousSnapshotId,
        supersededEntityIds,
        timestamp,
      });
    },

    async prepareStaticLoreIntakeForAdmin({
      chatId,
      snapshotId,
      intakeId,
      extractor,
      previousSnapshotId,
      timestamp,
    }) {
      const opened = await this.openChatForAdmin({ chatId });
      prepareStaticLoreIntakeInLedger({
        ledgerPath: opened.ledger_path,
        chatId,
        snapshotId,
        intakeId,
        extractor,
        previousSnapshotId,
        timestamp,
      });
    },

    async findGrantLedgerForAdmin({ grantId }) {
      if (typeof grantId !== 'string' || !grantId.trim()) return null;
      const entries = await readdir(resolvedRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('chat-')) continue;
        const chatSavePath = path.join(resolvedRoot, entry.name);
        const ledgerPath = path.join(chatSavePath, 'memory-ledger.sqlite');
        if (!await exists(ledgerPath)) continue;
        const database = new DatabaseSync(ledgerPath, { readOnly: true });
        try {
          const found = database.prepare(`
            SELECT 1
            FROM source_removal_grants
            WHERE grant_id = ?
          `).get(grantId);
          if (found) {
            return {
              chat_save_path: chatSavePath,
              ledger_path: ledgerPath,
            };
          }
        } finally {
          database.close();
        }
      }
      return null;
    },

    async inspectChat({ chatId }) {
      const chatSavePath = resolveChatSavePath(chatId);
      const missingPaths = [];
      for (const relativePath of REQUIRED_RELATIVE_PATHS) {
        if (!await exists(path.join(chatSavePath, relativePath))) {
          missingPaths.push(relativePath);
        }
      }

      if (missingPaths.length > 0) {
        return {
          schema: 'mnemosyne.chat-save-inspection.v1',
          status: 'unavailable',
          missing_paths: missingPaths,
          ledger_schema_version: 0,
        };
      }

      const ledger = inspectLedger(
        path.join(chatSavePath, 'memory-ledger.sqlite'),
      );
      const staticLore = readStaticLoreLedgerStatus(
        path.join(chatSavePath, 'memory-ledger.sqlite'),
      );
      return {
        schema: 'mnemosyne.chat-save-inspection.v1',
        status: 'ready',
        missing_paths: [],
        ledger_schema_version: ledger.schemaVersion,
        ledger_tables: ledger.tables,
        ledger_columns: ledger.columns,
        static_lore_snapshot_count: staticLore.count,
        latest_static_lore_snapshot_hash: staticLore.latestHash,
        runtime_readers: ['story-memory'],
      };
    },
  });
}
