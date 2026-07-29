// Phase 0.5 gate-family census dashboard — browser side. Mirrors
// src/inspection/gate-census.js's API and record shape, but cannot share
// code with it: this directory is loaded by the host browser via relative
// paths only, and tests/contracts/installed-extension-sync.test.js requires
// this directory's file set and per-file sha256 to match the installed
// SillyTavern copy exactly. Must not import any module — from this repo or
// from a sibling file in this directory — to stay import-cycle-free the
// same way src/inspection/gate-census.js must.
//
// Disabled state must never touch `Error#stack` on a caller's error
// instance. Call sites pass the error object itself via `ctx.errorForSite`;
// the property read (and any parsing) happens only inside `mark()`, after
// the enabled check, inside the try/catch.
//
// The ring buffer's capacity cap is an invariant, not best-effort: it is
// enforced immediately after a record is pushed, before the (possibly
// throwing, possibly re-entrant) sink ever runs (Codex re-audit P1-4).
//
// Public API: censusMark(family, phase, ctx), censusDrain().

const MAX_BUFFER_RECORDS = 8192;
const EVICT_FRACTION = 0.25;

function readEnabled() {
  try {
    return localStorage.getItem('MNEMOSYNE_GATE_CENSUS') === '1';
  } catch {
    return false;
  }
}

const ENABLED = readEnabled();

// Frame 1 is whatever called directly into the constructor; frame 2 is one
// level further up (the real site when a shared `fail()` helper did the
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
      side: 'browser',
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
        // `.stack` is read here, never earlier — see module header.
        const resolved = resolveSites(ctx.errorForSite.stack);
        site = resolved.site;
        site2 = resolved.site2;
      }
      record = {
        v: 1,
        side: 'browser',
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

function consoleSink(record) {
  console.debug(`MNEMOSYNE_CENSUS ${JSON.stringify(record)}`);
}

// Fallback/authoritative channel (§1.5): console buffering alone can be
// truncated or drowned out by host logging, which would silently read as
// "never reached" — exactly the false signal this dashboard exists to kill.
//
// Reuse semantics (Codex re-audit P1-5): reading the existing global and
// each of its two members happens exactly once, inside one try/catch — a
// hostile getter must not fail module load. The shape check requires both
// `censusMark` and `drain` to be functions (a one-method object is not a
// usable hook). Valid methods are bound to their hook to preserve `this`,
// then hidden behind self-swallowing proxies. If a prior load installed a
// valid hook, this module reuses those proxies instead of creating a
// second, disconnected singleton — otherwise this module's records and
// the page's authoritative `drain()` would silently diverge into two
// buffers. Only when no valid hook exists does this module create a local
// singleton and attempt to install it; if that assignment fails
// (non-writable global), it keeps using the local instance. No path throws
// during module load or from an instrumentation call.
function resolveExistingHook() {
  try {
    const existing = globalThis.__mnemosyneGateCensus;
    if (!existing) return null;
    const existingCensusMark = existing.censusMark;
    const existingDrain = existing.drain;
    if (
      typeof existingCensusMark !== 'function'
      || typeof existingDrain !== 'function'
    ) return null;
    const boundCensusMark = existingCensusMark.bind(existing);
    const boundDrain = existingDrain.bind(existing);
    return {
      mark(family, phase, ctx) {
        try {
          boundCensusMark(family, phase, ctx);
        } catch {
          // An adopted hook remains diagnostic-only even if it breaks.
        }
      },
      drain() {
        try {
          return boundDrain();
        } catch {
          return [];
        }
      },
    };
  } catch {
    // Reading (or shape-checking) the global itself threw: treat as "no
    // usable hook" rather than let that escape module evaluation.
  }
  return null;
}

function installGlobalHook(hook) {
  try {
    globalThis.__mnemosyneGateCensus = hook;
  } catch {
    // Non-writable global: the caller keeps using its local instance.
  }
}

let censusMarkImpl = () => {};
let censusDrainImpl = () => [];

if (ENABLED) {
  const existingHook = resolveExistingHook();
  if (existingHook) {
    censusMarkImpl = existingHook.mark;
    censusDrainImpl = existingHook.drain;
  } else {
    const localSingleton = createGateCensus({ enabled: true, sink: consoleSink });
    censusMarkImpl = (family, phase, ctx) => localSingleton.mark(family, phase, ctx);
    censusDrainImpl = () => localSingleton.drain();
    installGlobalHook({ drain: censusDrainImpl, censusMark: censusMarkImpl });
  }
}

export function censusMark(family, phase, ctx) {
  if (!ENABLED) return;
  try {
    censusMarkImpl(family, phase, ctx);
  } catch {
    // No census implementation may affect an instrumentation caller.
  }
}

export function censusDrain() {
  if (!ENABLED) return [];
  try {
    return censusDrainImpl();
  } catch {
    return [];
  }
}
