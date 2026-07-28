import { MnemosyneRequestError } from '../contracts/errors.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import {
  readVerifiedActiveHistory,
} from '../history/dynamic-story-projector.js';

export const CONTINUITY_RULES_EVENT_TYPE = 'continuity_rules.v1';
export const CONTINUITY_RULES_ENGINE_VERSION =
  'mnemosyne.continuity-rules-engine.v1';

const TERMINAL_LIFE_VALUES = new Set([
  'dead',
  'deceased',
  '死亡',
  '已死亡',
]);

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function parsePayload(row) {
  if (typeof row.record_payload_json !== 'string') return null;
  try {
    return JSON.parse(row.record_payload_json);
  } catch {
    fail(
      'continuity_rules_payload_invalid',
      'A typed record payload is not valid JSON.',
      { record_id: row.record_id },
    );
  }
}

function parseStateValue(row) {
  if (row.state_value_json === null) return null;
  try {
    return JSON.parse(row.state_value_json);
  } catch {
    fail(
      'continuity_rules_state_invalid',
      'A current-state value is not valid JSON.',
      { record_id: row.record_id },
    );
  }
}

function stateCoordinate(row) {
  return canonicalJson([
    row.entity_ref,
    row.state_domain,
    row.state_key,
  ]);
}

function terminalLifeState(row) {
  const domain = String(row.state_domain ?? '').toLowerCase();
  const key = String(row.state_key ?? '').toLowerCase();
  const coordinate = `${domain}.${key}`;
  const value = parseStateValue(row);
  if (row.state_operation === 'unset') return false;
  if (
    /\b(?:alive|is_alive|living)\b/u.test(coordinate)
    && value === false
  ) {
    return true;
  }
  if (!/(?:life|health|alive|death|dead|status|condition|生命|生死|存活|死亡)/u
    .test(coordinate)) {
    return false;
  }
  if (
    typeof value === 'string'
    && TERMINAL_LIFE_VALUES.has(value.toLowerCase())
  ) {
    return true;
  }
  if (!isObject(value)) return false;
  return ['status', 'state', 'life_status'].some(field => (
    typeof value[field] === 'string'
    && TERMINAL_LIFE_VALUES.has(value[field].toLowerCase())
  ));
}

function finding(ruleId, row, entityRef) {
  return {
    rule_id: ruleId,
    severity: 'hard',
    turn_index: row.turn_index,
    candidate_id_hash: sha256(row.candidate_id),
    entity_ref_hash: sha256(entityRef),
  };
}

// Only mechanically provable contradictions are emitted. No fuzzy trait,
// tone, surprise, or "should write" judgement is part of this layer.
export function detectContinuityRuleFindings({ rows } = {}) {
  if (!Array.isArray(rows)) {
    fail(
      'continuity_rules_input_invalid',
      'Continuity rules require active, verified history rows.',
    );
  }
  const latestState = new Map();
  for (const row of rows) {
    if (row.state_domain === null || row.state_key === null) continue;
    latestState.set(stateCoordinate(row), row);
  }
  const terminalEntities = new Set(
    [...latestState.values()]
      .filter(terminalLifeState)
      .map(row => row.entity_ref),
  );
  const findings = [];
  const latestScene = [...rows].reverse().find(
    row => row.record_kind === 'scene_state',
  );
  if (latestScene) {
    const scene = parsePayload(latestScene);
    for (const participant of scene?.participants ?? []) {
      if (terminalEntities.has(participant)) {
        findings.push(finding(
          'terminal_character_in_active_scene',
          latestScene,
          participant,
        ));
      }
    }
  }

  const cognitionByTurn = new Map();
  for (const row of rows) {
    if (row.record_kind !== 'character_cognition') continue;
    const cognition = parsePayload(row);
    if (!cognition) continue;
    const key = canonicalJson([
      row.turn_index,
      cognition.owner_ref,
      cognition.about_ref,
    ]);
    const group = cognitionByTurn.get(key) ?? {
      owner_ref: cognition.owner_ref,
      row,
      states: new Set(),
    };
    group.states.add(cognition.knowledge_state);
    cognitionByTurn.set(key, group);
  }
  for (const group of cognitionByTurn.values()) {
    if (
      group.states.has('knows')
      && group.states.has('does_not_know')
    ) {
      findings.push(finding(
        'same_turn_knowledge_boundary_collision',
        group.row,
        group.owner_ref,
      ));
    }
  }
  findings.sort((left, right) => (
    left.turn_index - right.turn_index
    || left.rule_id.localeCompare(right.rule_id)
    || left.entity_ref_hash.localeCompare(right.entity_ref_hash)
  ));
  return findings;
}

export function continuityRulesEventSealHash(event) {
  return sha256(canonicalJson({
    engine_version: event.engine_version,
    consumers: event.consumers,
    coordinate: event.coordinate,
    findings: event.findings,
    summary: event.summary,
  }));
}

export function verifyContinuityRulesEvent(event) {
  if (
    !isObject(event)
    || event.type !== CONTINUITY_RULES_EVENT_TYPE
    || event.engine_version !== CONTINUITY_RULES_ENGINE_VERSION
    || event.consumers !== 'none'
    || !Array.isArray(event.findings)
    || !isObject(event.summary)
    || event.event_hash !== continuityRulesEventSealHash(event)
  ) {
    fail(
      'continuity_rules_event_invalid',
      'A continuity-rules event failed its sealed contract.',
    );
  }
  return { verified: true };
}

export function createContinuityRulesPass({ store } = {}) {
  if (!store?.openChatForAdmin) {
    throw new TypeError(
      'Continuity rules require a trusted chat-save store.',
    );
  }
  return Object.freeze({
    async buildJournalEvent({ runScope } = {}) {
      const opened = await store.openChatForAdmin({
        chatId: runScope?.chat_id,
      });
      const { rows } = await readVerifiedActiveHistory({
        ledgerPath: opened.ledger_path,
        chatSavePath: opened.chat_save_path,
        chatId: runScope.chat_id,
        branchId: runScope.branch_id,
        branchEpoch: runScope.branch_epoch,
        turnIndex: runScope.turn_index,
      });
      const findings = detectContinuityRuleFindings({ rows });
      const counts = {};
      for (const findingEntry of findings) {
        counts[findingEntry.rule_id] =
          (counts[findingEntry.rule_id] ?? 0) + 1;
      }
      const event = {
        type: CONTINUITY_RULES_EVENT_TYPE,
        engine_version: CONTINUITY_RULES_ENGINE_VERSION,
        consumers: 'none',
        coordinate: {
          chat_id: runScope.chat_id,
          branch_id: runScope.branch_id,
          branch_epoch: runScope.branch_epoch,
          turn_index: runScope.turn_index,
          candidate_id: runScope.candidate_id,
          swipe_id: runScope.swipe_id ?? 0,
        },
        findings,
        summary: {
          hard_count: findings.length,
          rule_counts: Object.fromEntries(
            Object.entries(counts).sort(([left], [right]) => (
              left.localeCompare(right)
            )),
          ),
        },
      };
      event.event_hash = continuityRulesEventSealHash(event);
      return event;
    },
  });
}
