import { MnemosyneRequestError } from '../contracts/errors.js';

// Story Craft Harness batch-A configuration. Every mechanism defaults OFF;
// default-on may only ever be granted by an M13 blinded pairwise ablation,
// never by this module.
const DEFAULTS = Object.freeze({
  promise_due_surfacing: Object.freeze({
    enabled: false,
    top_k: 3,
  }),
  beat_rhythm: Object.freeze({
    enabled: false,
    window_scenes: 10,
    sequence_length: 5,
    trigger_same_type_run: 3,
    trigger_positive_run: 4,
  }),
  obligation_spotlight: Object.freeze({
    enabled: false,
    quota_seats: 2,
  }),
  quality_telemetry: Object.freeze({
    enabled: false,
    history_window_turns: 20,
    trend_window_turns: 10,
    positivity_lexicon_path: null,
  }),
  slop_detection: Object.freeze({
    enabled: false,
    lexicon_path: null,
  }),
  continuity_rules: Object.freeze({
    enabled: false,
  }),
});

function fail(message, details) {
  throw new MnemosyneRequestError(
    'story_craft_config_invalid',
    message,
    details,
  );
}

function isObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function readSection(config, key) {
  const section = config[key];
  if (section === undefined) return {};
  if (!isObject(section)) {
    fail(`Story craft config ${key} must be an object.`, { section: key });
  }
  return section;
}

function assertSectionKeys(section, sectionKey) {
  const allowed = Object.keys(DEFAULTS[sectionKey]);
  const unknown = Object.keys(section).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`Story craft config ${sectionKey} contains unknown fields.`, {
      section: sectionKey,
      fields: unknown,
    });
  }
}

function readBoolean(section, sectionKey, key, fallback) {
  const value = section[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    fail(
      `Story craft config ${sectionKey}.${key} must be a boolean.`,
      { section: sectionKey, field: key },
    );
  }
  return value;
}

function readBoundedInteger(section, sectionKey, key, fallback, {
  min,
  max,
}) {
  const value = section[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(
      `Story craft config ${sectionKey}.${key} must be an integer in [${min}, ${max}].`,
      { section: sectionKey, field: key },
    );
  }
  return value;
}

function readNullableString(section, sectionKey, key, fallback) {
  const value = section[key];
  if (value === undefined) return fallback;
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    fail(
      `Story craft config ${sectionKey}.${key} must be null or a non-empty string.`,
      { section: sectionKey, field: key },
    );
  }
  return value;
}

export function normalizeStoryCraftConfig(config = {}) {
  if (!isObject(config)) {
    fail('Story craft config must be a JSON object.');
  }
  const knownKeys = Object.keys(DEFAULTS);
  const unknown = Object.keys(config).filter(key => (
    !knownKeys.includes(key)
  ));
  if (unknown.length > 0) {
    fail('Story craft config contains unknown sections.', {
      sections: unknown,
    });
  }
  const promiseDue = readSection(config, 'promise_due_surfacing');
  const beatRhythm = readSection(config, 'beat_rhythm');
  const spotlight = readSection(config, 'obligation_spotlight');
  const telemetry = readSection(config, 'quality_telemetry');
  const slop = readSection(config, 'slop_detection');
  const continuityRules = readSection(config, 'continuity_rules');
  for (const [sectionKey, section] of [
    ['promise_due_surfacing', promiseDue],
    ['beat_rhythm', beatRhythm],
    ['obligation_spotlight', spotlight],
    ['quality_telemetry', telemetry],
    ['slop_detection', slop],
    ['continuity_rules', continuityRules],
  ]) {
    assertSectionKeys(section, sectionKey);
  }
  return Object.freeze({
    promise_due_surfacing: Object.freeze({
      enabled: readBoolean(
        promiseDue,
        'promise_due_surfacing',
        'enabled',
        DEFAULTS.promise_due_surfacing.enabled,
      ),
      top_k: readBoundedInteger(
        promiseDue,
        'promise_due_surfacing',
        'top_k',
        DEFAULTS.promise_due_surfacing.top_k,
        { min: 1, max: 8 },
      ),
    }),
    beat_rhythm: Object.freeze({
      enabled: readBoolean(
        beatRhythm,
        'beat_rhythm',
        'enabled',
        DEFAULTS.beat_rhythm.enabled,
      ),
      window_scenes: readBoundedInteger(
        beatRhythm,
        'beat_rhythm',
        'window_scenes',
        DEFAULTS.beat_rhythm.window_scenes,
        { min: 5, max: 20 },
      ),
      sequence_length: readBoundedInteger(
        beatRhythm,
        'beat_rhythm',
        'sequence_length',
        DEFAULTS.beat_rhythm.sequence_length,
        { min: 3, max: 10 },
      ),
      trigger_same_type_run: readBoundedInteger(
        beatRhythm,
        'beat_rhythm',
        'trigger_same_type_run',
        DEFAULTS.beat_rhythm.trigger_same_type_run,
        { min: 2, max: 10 },
      ),
      trigger_positive_run: readBoundedInteger(
        beatRhythm,
        'beat_rhythm',
        'trigger_positive_run',
        DEFAULTS.beat_rhythm.trigger_positive_run,
        { min: 2, max: 10 },
      ),
    }),
    obligation_spotlight: Object.freeze({
      enabled: readBoolean(
        spotlight,
        'obligation_spotlight',
        'enabled',
        DEFAULTS.obligation_spotlight.enabled,
      ),
      quota_seats: readBoundedInteger(
        spotlight,
        'obligation_spotlight',
        'quota_seats',
        DEFAULTS.obligation_spotlight.quota_seats,
        { min: 1, max: 4 },
      ),
    }),
    quality_telemetry: Object.freeze({
      enabled: readBoolean(
        telemetry,
        'quality_telemetry',
        'enabled',
        DEFAULTS.quality_telemetry.enabled,
      ),
      history_window_turns: readBoundedInteger(
        telemetry,
        'quality_telemetry',
        'history_window_turns',
        DEFAULTS.quality_telemetry.history_window_turns,
        { min: 5, max: 50 },
      ),
      trend_window_turns: readBoundedInteger(
        telemetry,
        'quality_telemetry',
        'trend_window_turns',
        DEFAULTS.quality_telemetry.trend_window_turns,
        { min: 3, max: 20 },
      ),
      positivity_lexicon_path: readNullableString(
        telemetry,
        'quality_telemetry',
        'positivity_lexicon_path',
        DEFAULTS.quality_telemetry.positivity_lexicon_path,
      ),
    }),
    slop_detection: Object.freeze({
      enabled: readBoolean(
        slop,
        'slop_detection',
        'enabled',
        DEFAULTS.slop_detection.enabled,
      ),
      lexicon_path: readNullableString(
        slop,
        'slop_detection',
        'lexicon_path',
        DEFAULTS.slop_detection.lexicon_path,
      ),
    }),
    continuity_rules: Object.freeze({
      enabled: readBoolean(
        continuityRules,
        'continuity_rules',
        'enabled',
        DEFAULTS.continuity_rules.enabled,
      ),
    }),
  });
}

export function defaultStoryCraftConfig() {
  return normalizeStoryCraftConfig({});
}
