import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { readActiveLaneBodies } from './active-lane-bodies.js';
import {
  QUALITY_METRICS_ENGINE_VERSION,
  TOKENIZER_CONFIG_HASH,
  TOKENIZER_PROFILE,
  computeQualityMetrics,
} from './quality-metrics.js';

export const QUALITY_METRICS_EVENT_TYPE = 'quality_metrics.v1';
export const QUALITY_METRICS_PASS_FAILED_EVENT_TYPE =
  'quality_metrics_pass_failed';

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

export function qualityMetricsEventSealHash(event) {
  return sha256(canonicalJson({
    engine_version: event.engine_version,
    tokenizer_profile: event.tokenizer_profile,
    tokenizer_config_hash: event.tokenizer_config_hash,
    coordinate: event.coordinate,
    window: event.window,
    lexicons: event.lexicons,
    metrics: event.metrics,
    disabled_metrics: event.disabled_metrics,
    degradation: event.degradation,
    slop_detail: event.slop_detail ?? null,
  }));
}

// Replay semantics (铁律⑪): verify the sealed values, do not recompute and
// require equality with a possibly newer engine. Version drift is reported
// explicitly by comparing engine_version, never silently passed.
export function verifyQualityMetricsEvent(event, {
  currentEngineVersion = QUALITY_METRICS_ENGINE_VERSION,
} = {}) {
  if (
    !event
    || typeof event !== 'object'
    || event.type !== QUALITY_METRICS_EVENT_TYPE
    || typeof event.metrics_hash !== 'string'
  ) {
    fail(
      'quality_metrics_event_invalid',
      'A quality metrics event is missing its sealed shape.',
    );
  }
  if (event.metrics_hash !== qualityMetricsEventSealHash(event)) {
    fail(
      'quality_metrics_seal_mismatch',
      'A quality metrics event no longer matches its sealed hash.',
    );
  }
  return {
    verified: true,
    engine_version: event.engine_version,
    engine_version_drift:
      event.engine_version !== currentEngineVersion,
  };
}

// The pass runs in the Run Kernel journal stage strictly after a successful
// writeback. Its own failure degrades to a pass_failed journal event; the
// turn result is never blocked (fail-closed governs the fact plane, and is
// not amplified into a generation-plane outage).
export function createQualityTelemetryPass({
  store,
  config,
  positivityLexicon = null,
  slopDetector = null,
} = {}) {
  if (!store?.openChatForAdmin) {
    throw new Error(
      'Quality telemetry requires a trusted chat-save store.',
    );
  }
  if (
    !Number.isInteger(config?.history_window_turns)
    || !Number.isInteger(config?.trend_window_turns)
  ) {
    throw new Error('Quality telemetry requires normalized config.');
  }

  return Object.freeze({
    async buildJournalEvent({
      runScope,
      committedBody,
      deltaMode,
      recordCount,
    } = {}) {
      if (
        typeof runScope?.chat_id !== 'string'
        || typeof committedBody !== 'string'
      ) {
        fail(
          'quality_metrics_input_invalid',
          'The telemetry pass needs the run scope and committed body.',
        );
      }
      const opened = await store.openChatForAdmin({
        chatId: runScope.chat_id,
      });
      const historyBodies = runScope.turn_index > 0
        ? await readActiveLaneBodies({
            chatSavePath: opened.chat_save_path,
            ledgerPath: opened.ledger_path,
            chatId: runScope.chat_id,
            branchId: runScope.branch_id,
            branchEpoch: runScope.branch_epoch,
            throughTurnIndex: runScope.turn_index - 1,
            limitTurns: config.history_window_turns,
          })
        : [];
      const slopResult = slopDetector
        ? slopDetector.detect({
            body: committedBody,
            historyBodies,
          })
        : null;
      const { metrics, disabledMetrics, degradation } =
        computeQualityMetrics({
          body: committedBody,
          historyBodies,
          deltaMode,
          recordCount,
          trendWindowTurns: config.trend_window_turns,
          positivityLexicon,
          slopResult,
        });
      const lexicons = {
        positivity: positivityLexicon
          ? {
              status: 'active',
              lexicon_id: positivityLexicon.lexicon_id,
              version: positivityLexicon.version,
              content_hash: positivityLexicon.content_hash,
            }
          : {
              status: 'disabled',
              reason_code: 'lexicon_not_configured',
            },
        slop: slopDetector
          ? slopDetector.seal()
          : {
              status: 'disabled',
              reason_code: 'slop_detection_not_configured',
            },
      };
      const event = {
        type: QUALITY_METRICS_EVENT_TYPE,
        engine_version: QUALITY_METRICS_ENGINE_VERSION,
        tokenizer_profile: TOKENIZER_PROFILE.id,
        tokenizer_config_hash: TOKENIZER_CONFIG_HASH,
        coordinate: {
          chat_id: runScope.chat_id,
          branch_id: runScope.branch_id,
          branch_epoch: runScope.branch_epoch,
          turn_index: runScope.turn_index,
          candidate_id: runScope.candidate_id,
          swipe_id: runScope.swipe_id ?? 0,
        },
        window: {
          history_window_turns: config.history_window_turns,
          trend_window_turns: config.trend_window_turns,
          history_turns_used: historyBodies.length,
          from_turn_index:
            historyBodies[0]?.turn_index ?? null,
          through_turn_index:
            historyBodies.at(-1)?.turn_index ?? null,
        },
        lexicons,
        metrics,
        disabled_metrics: disabledMetrics,
        degradation,
        slop_detail: slopResult
          ? { hits: slopResult.hits }
          : null,
      };
      event.metrics_hash = qualityMetricsEventSealHash(event);
      return event;
    },
  });
}
