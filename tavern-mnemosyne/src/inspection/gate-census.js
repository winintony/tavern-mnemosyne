// Phase 0.5 gate-family census dashboard — Node/server side.
//
// Diagnostic instrumentation only: every insertion point calls censusMark()
// as an independent statement so it cannot affect any branch, return value,
// or thrown error. Zero semantic impact by construction; see the governed
// gate-census embedding map for the complete insertion-point proof.
//
// Hard constraints:
//   - Must not import any module from this repository. `errors.js` imports
//     this module; any reverse dependency would create an import cycle.
//     `node:fs` (a Node builtin, not a repo module) is the sole import, and
//     the write stream it creates is built lazily on first use.
//   - Must never carry story text, message content, or host data beyond the
//     small control fields below (see src/inspection/live-run-activity.js
//     for the same de-identification discipline).
//   - Disabled state must never touch `Error#stack` on a caller's error
//     instance. Call sites pass the error object itself via
//     `ctx.errorForSite`; the property read (and any parsing) happens only
//     inside `mark()`, after the enabled check, inside the try/catch. Merely
//     *referencing* an error object is free; reading `.stack` is not — it
//     can invoke a host-installed `Error.prepareStackTrace` that throws.
//   - The ring buffer's capacity cap is an invariant, not best-effort: it is
//     enforced immediately after a record is pushed, before the (possibly
//     throwing, possibly re-entrant) sink ever runs, so a hostile sink can
//     never grow the buffer past bound (Codex re-audit P1-4).
//
// Public API: censusMark(family, phase, ctx), censusDrain().

import { createWriteStream } from 'node:fs';

const SIDE = 'server';
const MAX_BUFFER_RECORDS = 8192;
const EVICT_FRACTION = 0.25;

// Frame 1 is whatever called directly into the constructor (the real site
// for a bare `throw new MnemosyneRequestError(...)`); frame 2 is one level
// further up (the real site when a shared `fail()` helper did the
// constructing). Recording both and letting analysis pick the right one
// avoids guessing at embed time which shape a given call site has.
function resolveSites(stack) {
  if (typeof stack !== 'string') return { site: null, site2: null };
  const lines = stack.split('\n');
  const frame = index => {
    const line = lines[index];
    const match = line && line.match(/([^\s(]+:\d+):\d+\)?\s*$/);
    return match ? match[1] : null;
  };
  return { site: frame(1), site2: frame(2) };
}

export function createGateCensus({ enabled, sink } = {}) {
  let seq = 0;
  let buffer = [];

  // Capacity enforcement is unconditional: it runs immediately after a
  // push, in the same synchronous step, before control ever reaches the
  // caller-supplied sink. Nothing the sink does — throwing, re-entering
  // mark(), or anything else — can run before this has already completed.
  function enforceCapacity() {
    if (buffer.length <= MAX_BUFFER_RECORDS) return;
    const evictCount = Math.ceil(buffer.length * EVICT_FRACTION);
    buffer = buffer.slice(evictCount);
    const metaRecord = {
      v: 1,
      side: SIDE,
      family: 'CENSUS',
      phase: 'meta',
      run_id: null,
      reason_code: null,
      stage: null,
      site: null,
      site2: null,
      cls: null,
      original_reason_code: null,
      candidate_id: null,
      id_source: null,
      pid: process.pid,
      seq: seq++,
      at: Date.now(),
      dropped: evictCount,
    };
    buffer.push(metaRecord);
    try {
      if (sink) sink(metaRecord);
    } catch {
      // Sink failures never affect the buffer/capacity invariant above.
    }
  }

  function mark(family, phase, ctx = {}) {
    if (!enabled) return;
    let record;
    try {
      let { site = null, site2 = null } = ctx;
      if (ctx.errorForSite) {
        // `.stack` is read here, never earlier: this line only runs once
        // `enabled` is confirmed true, and any throw from a hostile
        // `prepareStackTrace` is caught below like everything else.
        const resolved = resolveSites(ctx.errorForSite.stack);
        site = resolved.site;
        site2 = resolved.site2;
      }
      record = {
        v: 1,
        side: SIDE,
        family,
        phase,
        run_id: ctx.runId ?? null,
        reason_code: ctx.reasonCode ?? null,
        stage: ctx.stage ?? null,
        site,
        site2,
        cls: ctx.cls ?? null,
        original_reason_code: ctx.originalReasonCode ?? null,
        candidate_id: ctx.candidateId ?? null,
        id_source: ctx.idSource ?? null,
        pid: process.pid,
        seq: seq++,
        at: Date.now(),
      };
    } catch {
      // A poisoned ctx (e.g. a throwing getter) never gets buffered or
      // sunk — nothing was pushed, so there is nothing to evict either.
      return;
    }
    buffer.push(record);
    enforceCapacity();
    // Sink is best-effort and isolated in its own try/catch, strictly after
    // the capacity invariant above has already been restored.
    try {
      if (sink) sink(record);
    } catch {
      // Census must never interrupt a round.
    }
  }

  function drain() {
    if (!enabled) return [];
    return buffer.splice(0, buffer.length);
  }

  return { mark, drain };
}

const ENABLED = process.env.MNEMOSYNE_GATE_CENSUS === '1';

let stream = null;
let streamBusy = false;
let streamDead = false;
let streamPending = [];
let stderrGuardInstalled = false;
let stderrBusy = false;
let stderrDead = false;
let stderrPending = [];

function flushStderrPending() {
  while (stderrPending.length > 0 && !stderrBusy && !stderrDead) {
    const line = stderrPending.shift();
    if (process.stderr.write(line) === false) stderrBusy = true;
  }
}

function ensureStderrErrorGuard() {
  if (stderrGuardInstalled) return;
  stderrGuardInstalled = true;
  // Without this, an async write failure (EPIPE et al.) surfaces as an
  // 'error' event with no listener, which crashes the process.
  process.stderr.on('error', () => {
    // Match the file sink's terminal failure semantics: stop all later
    // writes and discard backpressure backlog, while the in-memory census
    // buffer and drain() remain fully operational.
    stderrDead = true;
    stderrPending = [];
  });
  process.stderr.on('drain', () => {
    stderrBusy = false;
    flushStderrPending();
  });
}

function writeStderr(line) {
  ensureStderrErrorGuard();
  if (stderrDead) return;
  // Same busy/pending discipline as the file path below: a slow stderr
  // consumer queues in memory instead of silently dropping lines.
  if (stderrBusy) {
    stderrPending.push(line);
    return;
  }
  if (process.stderr.write(line) === false) stderrBusy = true;
}

function flushStreamPending() {
  while (streamPending.length > 0 && !streamBusy && !streamDead) {
    const line = streamPending.shift();
    if (stream.write(line) === false) streamBusy = true;
  }
}

function writeFile(line, path) {
  if (!stream) {
    stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', () => {
      // The stream is broken (e.g. disk full, permission revoked mid-run):
      // stop trying to persist to it. This never touches `streamBusy` —
      // it is a distinct terminal state, not an indefinite backpressure
      // wait — and never touches the in-memory ring buffer or drain(),
      // which keep working regardless of on-disk sink health.
      streamDead = true;
      streamPending = [];
    });
    stream.on('drain', () => {
      streamBusy = false;
      flushStreamPending();
    });
  }
  if (streamDead) return;
  if (streamBusy) {
    streamPending.push(line);
    return;
  }
  if (stream.write(line) === false) streamBusy = true;
}

function fileOrStderrSink(record) {
  const line = `${JSON.stringify(record)}\n`;
  const path = process.env.MNEMOSYNE_GATE_CENSUS_PATH;
  if (!path) {
    // Never fall back to stdout: src/proxy/cli.js writes onAudit JSONL to
    // stdout, and this would corrupt that stream.
    writeStderr(`MNEMOSYNE_CENSUS ${line}`);
    return;
  }
  writeFile(line, path);
}

const singleton = createGateCensus({
  enabled: ENABLED,
  sink: ENABLED ? fileOrStderrSink : undefined,
});

export function censusMark(family, phase, ctx) {
  if (!ENABLED) return; // Disabled state: one resolved boolean check, no more.
  singleton.mark(family, phase, ctx);
}

export function censusDrain() {
  if (!ENABLED) return [];
  return singleton.drain();
}
