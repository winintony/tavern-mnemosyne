import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) return null;
  const parsed = match.slice(1).map(Number);
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function isAffectedVersion(sqliteVersion) {
  const parsed = parseVersion(sqliteVersion);
  if (!parsed) return false;
  const fixedBackportLine = (
    parsed[0] === 3
    && (
      (parsed[1] === 44 && parsed[2] >= 6)
      || (parsed[1] === 50 && parsed[2] >= 7)
    )
  );
  if (fixedBackportLine) return false;
  return (
    compareVersions(parsed, [3, 7, 0]) >= 0
    && compareVersions(parsed, [3, 51, 2]) <= 0
  );
}

function classifySqliteWalRuntime(sqliteVersion) {
  const parsed = parseVersion(sqliteVersion);
  if (!parsed || parsed[0] !== 3) {
    return {
      status: 'unknown',
      reason_code: 'sqlite_version_unknown',
    };
  }
  if (compareVersions(parsed, [3, 7, 0]) < 0) {
    return {
      status: 'unsupported',
      reason_code: 'wal_not_supported',
    };
  }
  if (isAffectedVersion(sqliteVersion)) {
    return {
      status: 'affected',
      reason_code: 'wal_reset_bug_affected',
    };
  }
  return {
    status: 'safe',
    reason_code: 'wal_reset_fix_present',
  };
}

function runtimeHealth(sqliteVersion, enforcement) {
  return Object.freeze({
    schema: 'mnemosyne.sqlite-wal-runtime-health.v1',
    ...classifySqliteWalRuntime(sqliteVersion),
    sqlite_version: sqliteVersion,
    enforcement,
  });
}

function forbiddenTestOverride(message) {
  const error = new Error(message);
  error.code = 'SQLITE_WAL_TEST_OVERRIDE_FORBIDDEN';
  return error;
}

export function probeSqliteWalRuntime() {
  const probeDirectory = mkdtempSync(
    path.join(os.tmpdir(), 'tavern-mnemosyne-sqlite-probe-'),
  );
  const databasePath = path.join(probeDirectory, 'runtime.sqlite');
  let database;
  try {
    database = new DatabaseSync(databasePath);
    const versionRow = database.prepare(
      'SELECT sqlite_version() AS version, sqlite_source_id() AS source_id',
    ).get();
    const journalRow = database.prepare(
      'PRAGMA journal_mode = WAL',
    ).get();
    database.exec(
      'CREATE TABLE probe (value INTEGER NOT NULL);'
      + ' INSERT INTO probe (value) VALUES (1);',
    );
    const roundTripRow = database.prepare(
      'SELECT COUNT(*) AS count FROM probe WHERE value = 1',
    ).get();
    const sqliteVersion = versionRow?.version;
    const sqliteSourceId = versionRow?.source_id;
    const walMode = journalRow?.journal_mode;
    if (
      typeof sqliteVersion !== 'string'
      || typeof sqliteSourceId !== 'string'
      || walMode !== 'wal'
      || roundTripRow?.count !== 1
    ) {
      const error = new Error(
        'SQLite runtime probe could not establish a WAL round trip.',
      );
      error.code = 'SQLITE_WAL_RUNTIME_PROBE_FAILED';
      throw error;
    }
    return Object.freeze({
      sqlite_version: sqliteVersion,
      sqlite_source_id: sqliteSourceId,
      wal_mode: walMode,
      wal_round_trip: 'ok',
      probe: 'database_connection',
    });
  } finally {
    try {
      database?.close();
    } finally {
      rmSync(probeDirectory, { recursive: true, force: true });
    }
  }
}

export function sqliteWalRuntimePolicyFromHarness() {
  const injection = globalThis[
    Symbol.for('tavern-mnemosyne.sqlite-test-runtime.v1')
  ];
  if (injection === undefined) {
    return Object.freeze({ context: 'production' });
  }
  if (
    !process.env.NODE_TEST_CONTEXT
    || !injection
    || typeof injection !== 'object'
    || Array.isArray(injection)
    || Object.keys(injection).length !== 1
    || injection.context !== 'test'
  ) {
    throw forbiddenTestOverride(
      'SQLite test context is available only through the Node test harness.',
    );
  }
  return Object.freeze({ context: 'test' });
}

export function assertSqliteWalRuntimeSafe({
  sqliteVersion = process.versions.sqlite,
  context = 'production',
} = {}) {
  if (!['production', 'test'].includes(context)) {
    const error = new Error(
      `Unknown SQLite runtime safety context: ${String(context)}.`,
    );
    error.code = 'SQLITE_WAL_RUNTIME_CONTEXT_INVALID';
    throw error;
  }
  if (context === 'test' && !process.env.NODE_TEST_CONTEXT) {
    throw forbiddenTestOverride(
      'SQLite test override requires the Node test harness.',
    );
  }
  const classification = classifySqliteWalRuntime(sqliteVersion);
  if (context === 'test' && classification.status === 'affected') {
    return runtimeHealth(sqliteVersion, 'test_override');
  }

  if (classification.status !== 'safe') {
    const health = runtimeHealth(sqliteVersion, 'blocked');
    const message = {
      affected: (
        `SQLite ${sqliteVersion} is affected by the WAL-reset bug. `
        + 'Use SQLite 3.51.3 or newer, or the fixed backports '
        + '3.50.7 and 3.44.6.'
      ),
      unknown: `SQLite runtime version is unknown: ${String(sqliteVersion)}.`,
      unsupported: `SQLite ${sqliteVersion} does not support WAL mode.`,
    }[classification.status];
    const error = new Error(message);
    error.code = 'SQLITE_WAL_RUNTIME_UNSAFE';
    error.health = health;
    throw error;
  }

  return runtimeHealth(sqliteVersion, 'enforced');
}
