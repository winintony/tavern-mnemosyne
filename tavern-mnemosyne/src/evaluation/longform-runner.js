// Longform fixture runner (issue 19, slices 2 and 5).
//
// Assembles the same production pieces
// tests/integration/long-horizon-story-coverage.test.js already wires up
// (chat-save store / State History / Dynamic Story Projector / Memory
// Reader / Run Kernel) and drives a validated fixture bundle
// (loadLongformFixture) through a complete root run per step, feeding:
//   - evaluateTurnCaptureManifest (capture + continuation_use, per step)
//   - createStoryMemorySemanticEvaluator (governance_retrieval/semantic,
//     per step, partitioned by the oracle's layer_map)
//   - evaluateStoryCraftMechanics (craft_dimensions, once, over the final
//     active lane) via createQualityTelemetryPass / createContinuityRulesPass
//     / readVerifiedActiveHistory / collectObligationDormancy -- the same
//     production passes and row query the runtime uses, not a
//     reimplementation.
// It never constructs a real provider itself -- scripted mode is the only
// path npm test can reach; audit mode requires a caller-supplied provider
// plus a double environment-variable switch, and this module still never
// imports the real provider/network code that a caller would inject.
//
// Zero-payment / zero-network guard (issue 19 priority 3): this file's
// own import graph is provider/network-free by construction -- it only
// imports storage, history, harness, craft, and evaluation modules, plus
// the scripted provider in this same directory (which itself has zero
// imports). See tests/contracts/longform-zero-network-guard.test.js.
//
// Step/turn coordinates (issue 19 "定版增补"): the fixture's unit of
// on-disk identity is a global step sequence, not a turn number -- a
// swipe adds a second candidate at the same turn_index, and a
// branch_fork/truncate starts a new branch_epoch that reuses turn_index
// numbers the old epoch already used. This runner iterates by `sequence`
// and tracks the *current* (turn_index -> candidate_id) map and the
// *current* branch_epoch as derived, swipe/branch/truncate-aware state:
// a swipe overwrites its turn_index's entry (the kernel activates the new
// candidate automatically); a branch_fork/truncate first truncates the
// ledger, then drops every tracked turn_index >= the cutoff before
// resuming -- so a superseded/abandoned turn falls out of every
// downstream denominator without any special-casing at the report layer.
// Fixture authors keep candidate_id globally unique (never reused across
// swipes or epochs) so this tracking alone is enough to disambiguate.

import { createChatSaveStore } from '../storage/chat-save-store.js';
import { createStateHistory } from '../history/state-history.js';
import {
  createDynamicStoryProjector,
  readVerifiedActiveHistory,
} from '../history/dynamic-story-projector.js';
import { createMemoryReader } from '../memory/memory-reader.js';
import { createRunKernel } from '../harness/run-kernel.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { createQualityTelemetryPass } from '../craft/quality-telemetry-pass.js';
import { createContinuityRulesPass } from '../craft/continuity-rule-auditor.js';
import { collectObligationDormancy } from '../craft/obligation-spotlight.js';
import {
  createLongformScriptedTurnProvider,
} from './longform-scripted-provider.js';
import { evaluateTurnCaptureManifest } from './turn-capture-manifest.js';
import {
  createStoryMemorySemanticEvaluator,
} from './story-memory-semantic-evaluator.js';
import { evaluateStoryCraftMechanics } from './story-craft-mechanical-evaluator.js';
import { buildLongformEvalReport } from './longform-eval-report.js';

export const LONGFORM_PROVIDER_MODE_SCRIPTED = 'scripted';
export const LONGFORM_PROVIDER_MODE_AUDIT = 'audit';

const AUDIT_MODE_ENV_VAR = 'MNEMOSYNE_LONGFORM_AUDIT_MODE';
const AUDIT_PROVIDER_ENV_VAR = 'MNEMOSYNE_LONGFORM_AUDIT_PROVIDER';
const QUALITY_TELEMETRY_CONFIG = Object.freeze({
  history_window_turns: 20,
  trend_window_turns: 10,
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

// Double switch (issue 19 priority 3): audit mode requires both an
// explicit caller opt-in (auditMode: true) *and* both environment
// variables. Neither switch alone is enough, and this function is the
// only place either switch is read.
export function resolveLongformProviderMode({
  auditMode = false,
  env = process.env,
} = {}) {
  if (!auditMode) return LONGFORM_PROVIDER_MODE_SCRIPTED;
  const modeSwitch = env[AUDIT_MODE_ENV_VAR] === '1';
  const providerSwitch = (
    typeof env[AUDIT_PROVIDER_ENV_VAR] === 'string'
    && env[AUDIT_PROVIDER_ENV_VAR].trim() !== ''
  );
  if (!modeSwitch || !providerSwitch) {
    throw fail(
      'LONGFORM_AUDIT_MODE_SWITCH_MISSING',
      `Longform audit mode requires both ${AUDIT_MODE_ENV_VAR}=1 and ` +
        `${AUDIT_PROVIDER_ENV_VAR} to be set.`,
    );
  }
  return LONGFORM_PROVIDER_MODE_AUDIT;
}

function fixtureBundleHash({ fixture, scripts, oracles }) {
  return sha256(canonicalJson({
    fixture,
    scripts: [...scripts.entries()].sort(([left], [right]) => left - right),
    oracles: [...oracles.entries()].sort(([left], [right]) => left - right),
  }));
}

function cursorSecretFor(fixtureId) {
  // 32+ bytes, deterministic per fixture -- Run Kernel only uses this to
  // sign memory-read continuation cursors within a single run.
  return sha256(`${fixtureId}:longform-runner-cursor-secret`);
}

function pruneFromCutoff(map, cutoffTurnIndex) {
  for (const turnIndex of [...map.keys()]) {
    if (turnIndex >= cutoffTurnIndex) map.delete(turnIndex);
  }
}

// Runs one validated fixture bundle (as returned by loadLongformFixture())
// end to end and returns the assembled mnemosyne.longform-eval-report.v1
// plus the raw per-step evidence that produced it.
export async function runLongformFixture({
  fixtureBundle,
  rootDir,
  now = () => new Date(),
  auditMode = false,
  auditProvider = null,
  env = process.env,
} = {}) {
  if (!isObject(fixtureBundle)) {
    throw fail(
      'LONGFORM_RUNNER_INPUT_INVALID',
      'runLongformFixture requires a validated fixtureBundle.',
    );
  }
  const providerMode = resolveLongformProviderMode({ auditMode, env });
  if (
    providerMode === LONGFORM_PROVIDER_MODE_AUDIT
    && typeof auditProvider?.completeToolStep !== 'function'
  ) {
    throw fail(
      'LONGFORM_RUNNER_AUDIT_PROVIDER_MISSING',
      'Audit mode requires a caller-supplied provider adapter.',
    );
  }

  const { fixture, scripts, oracles } = fixtureBundle;
  const fixtureHash = fixtureBundleHash(fixtureBundle);

  const store = createChatSaveStore({ rootDir });
  await store.initializeChat({
    chatId: fixture.chat_id,
    characterId: `${fixture.fixture_id}-character`,
  });
  const opened = await store.openChatForAdmin({ chatId: fixture.chat_id });
  const stateHistory = createStateHistory({ store, now });
  const projector = createDynamicStoryProjector({ store });
  const memoryReader = createMemoryReader({ store });
  const semanticEvaluator = createStoryMemorySemanticEvaluator({
    memoryReader,
    stateHistory,
  });
  const qualityTelemetryPass = createQualityTelemetryPass({
    store,
    config: QUALITY_TELEMETRY_CONFIG,
    positivityLexicon: null,
    slopDetector: null,
  });
  const continuityRulesPass = createContinuityRulesPass({ store });
  const memoryCursorSecret = cursorSecretFor(fixture.fixture_id);

  const captureEntries = [];
  const semanticEntries = [];
  const activeCandidates = new Map();
  const recordsByTurnIndex = new Map();
  const qualityEvents = [];
  const continuityRuleEvents = [];
  const dormancySnapshots = [];
  let visibleTurnIndex = 0;
  let visibleBranchEpoch = 0;
  let latestActiveRows = [];

  for (let sequence = 1; sequence <= fixture.total_steps; sequence += 1) {
    const script = scripts.get(sequence);
    const oracle = oracles.get(sequence);

    if (script.lane_op === 'branch_fork' || script.lane_op === 'truncate') {
      await stateHistory.truncateBranch({
        commandId: `${fixture.fixture_id}-laneop-${sequence}`,
        chatId: fixture.chat_id,
        branchId: script.branch_id,
        expectedBranchEpoch: script.lane_op_params.expected_branch_epoch,
        cutoffTurnIndex: script.lane_op_params.cutoff_turn_index,
        reasonCode: script.lane_op_params.reason_code,
      });
      pruneFromCutoff(recordsByTurnIndex, script.lane_op_params.cutoff_turn_index);
      pruneFromCutoff(activeCandidates, script.lane_op_params.cutoff_turn_index);
      visibleBranchEpoch = script.branch_epoch;
    }

    const provider = providerMode === LONGFORM_PROVIDER_MODE_SCRIPTED
      ? createLongformScriptedTurnProvider({ turnScript: script })
      : auditProvider;

    const kernel = createRunKernel({
      provider,
      stateHistory,
      memoryReader,
      projector,
      memoryCursorSecret,
      maxToolSteps: Math.max(4, script.tool_script.length + 3),
    });

    const runScope = {
      chat_id: fixture.chat_id,
      run_id: `run-${fixture.fixture_id}-step-${sequence}`,
      turn_id: script.turn_id,
      candidate_id: script.candidate_id,
      turn_index: script.turn_index,
      memory_turn_index: Math.max(0, script.turn_index - 1),
      branch_id: script.branch_id,
      branch_epoch: script.branch_epoch,
      swipe_id: script.swipe_id,
    };

    await kernel.executeRootTurn({
      requestBody: {
        model: 'longform-fixture-host-model',
        messages: [
          { role: 'system', content: 'Use governed memory only.' },
          { role: 'user', content: script.user_message },
        ],
      },
      runScope,
    });

    // A swipe overwrites its turn_index's entry (last write wins, same as
    // the kernel's own "just-committed candidate becomes active" rule);
    // a fresh turn_index just adds one.
    activeCandidates.set(script.turn_index, script.candidate_id);
    visibleTurnIndex = script.turn_index;
    visibleBranchEpoch = script.branch_epoch;

    const artifact = await stateHistory.readTurn({
      chatId: fixture.chat_id,
      turnId: script.turn_id,
      candidateId: script.candidate_id,
    });
    recordsByTurnIndex.set(script.turn_index, artifact.delta.records);

    const activeBefore = [...recordsByTurnIndex.keys()]
      .filter(index => index < script.turn_index)
      .sort((left, right) => left - right)
      .flatMap(index => recordsByTurnIndex.get(index));
    const activeAfter = [...activeBefore, ...artifact.delta.records];

    captureEntries.push(evaluateTurnCaptureManifest({
      manifest: oracle.capture_manifest,
      artifact,
      activeBefore,
      activeAfter,
      continuationBody: artifact.assistant_message.content,
    }));

    semanticEntries.push({
      report: await semanticEvaluator.evaluateCase(oracle.semantic_case),
      layer_map: oracle.layer_map,
      // story-memory-semantic-case coordinates carry no candidate_id;
      // the runner supplies the one it evaluated this case under so the
      // report builder can filter by activeCandidates the same way the
      // capture rollup does (see longform-eval-report.js).
      candidate_id: script.candidate_id,
    });

    // Craft-mechanics evidence (issue 19 slice 5): the same production
    // passes the runtime uses, run read-only and offline against this
    // fixture's own committed history -- never a reimplementation.
    qualityEvents.push(await qualityTelemetryPass.buildJournalEvent({
      runScope,
      committedBody: artifact.assistant_message.content,
      deltaMode: script.typed_delta.mode,
      recordCount: artifact.delta.records.length,
    }));
    continuityRuleEvents.push(
      await continuityRulesPass.buildJournalEvent({ runScope }),
    );
    ({ rows: latestActiveRows } = await readVerifiedActiveHistory({
      ledgerPath: opened.ledger_path,
      chatSavePath: opened.chat_save_path,
      chatId: fixture.chat_id,
      branchId: script.branch_id,
      branchEpoch: script.branch_epoch,
      turnIndex: script.turn_index,
    }));
    const dormancy = collectObligationDormancy({
      rows: latestActiveRows,
      bodies: [],
      retrievalActivity: {},
      visibleTurnIndex: script.turn_index,
    });
    dormancySnapshots.push({
      turn_index: script.turn_index,
      candidate_id: script.candidate_id,
      entries: dormancy.map(entry => ({
        dormancy_turns: entry.dormancy_turns,
      })),
    });
  }

  // Obligation-spotlight seat rotation (applySpotlightRotation) needs an
  // "eligible obligations lane" this runner slice does not construct --
  // spotlightDecisions stays honestly empty rather than fabricated, so
  // rotation_coverage_rate reports null while dormancy_mean/slope stay
  // real, derived data.
  const craftReport = evaluateStoryCraftMechanics({
    rows: latestActiveRows,
    activeCandidates,
    qualityEvents,
    continuityRuleEvents,
    dormancySnapshots,
    spotlightDecisions: [],
    visibleTurnIndex,
  });

  const report = buildLongformEvalReport({
    fixtureId: fixture.fixture_id,
    fixtureHash,
    providerMode,
    captureEntries,
    semanticEntries,
    activeCandidates,
    visibleTurnIndex,
    craftReport,
    qualityEvents,
  });

  return Object.freeze({
    report,
    captureEntries: Object.freeze(captureEntries),
    semanticEntries: Object.freeze(semanticEntries),
    craftReport,
    activeCandidates,
    visibleTurnIndex,
    visibleBranchEpoch,
  });
}
