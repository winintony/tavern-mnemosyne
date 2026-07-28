const PRESENTATION_SCHEMA =
  'mnemosyne.continuity-feedback-presentation.v1';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const QUESTIONNAIRE_FIELD_KEYS = Object.freeze([
  'reviewed_reply',
  'continuity_severity',
  'facet_rating',
  'intervention',
  'older_context_handling',
  'confidence',
  'confounders',
]);
const ANSWER_KEYS = Object.freeze([
  'reviewed_reply',
  'continuity_severity',
  'facet_ratings',
  'intervention',
  'older_context_handling',
  'confidence',
  'confounders',
]);
const QUICK_ANSWER_STRATEGIES = Object.freeze([
  'all_clear',
  'single_facet_minor',
  'single_facet_major',
  'unjudgeable',
  'not_reviewed',
]);
const FACET_REQUIRED_STRATEGIES = new Set([
  'single_facet_minor',
  'single_facet_major',
]);

function feedbackError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

function invalidFeedback(message) {
  return feedbackError('feedback_input_invalid', message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, field) {
  if (!isPlainObject(value)) {
    throw invalidFeedback(`${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    throw invalidFeedback(`${field} has unsupported fields.`);
  }
}

function assertSafeId(value, field) {
  if (
    typeof value !== 'string'
    || value.length > 256
    || !SAFE_ID_PATTERN.test(value)
  ) {
    throw invalidFeedback(`${field} is invalid.`);
  }
}

function assertOpaqueChatId(value) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidFeedback('chatId is invalid.');
  }
}

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value ?? '')) {
    throw invalidFeedback(`${field} is invalid.`);
  }
}

function assertDisplayText(value, field, maximumLength = 2048) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maximumLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw invalidFeedback(`${field} is invalid.`);
  }
}

function assertUniqueIdList(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    throw invalidFeedback(`${field} must be a non-empty array.`);
  }
  for (const value of values) assertSafeId(value, field);
  if (new Set(values).size !== values.length) {
    throw invalidFeedback(`${field} contains duplicates.`);
  }
}

function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) {
    throw invalidFeedback(`${field} is invalid.`);
  }
}

function inspectQuestionnaire(questionnaire) {
  if (!isPlainObject(questionnaire)) {
    throw invalidFeedback('questionnaire must be an object.');
  }
  assertSafeId(questionnaire.version, 'questionnaire.version');
  if (questionnaire.schema !== questionnaire.version) {
    throw invalidFeedback(
      'questionnaire.schema must match questionnaire.version.',
    );
  }
  assertDisplayText(
    questionnaire.language,
    'questionnaire.language',
    64,
  );
  assertUniqueIdList(questionnaire.facets, 'questionnaire.facets');
  assertExactKeys(
    questionnaire.fields,
    QUESTIONNAIRE_FIELD_KEYS,
    'questionnaire.fields',
  );
  const fieldSets = {};
  for (const field of QUESTIONNAIRE_FIELD_KEYS) {
    assertUniqueIdList(
      questionnaire.fields[field],
      `questionnaire.fields.${field}`,
    );
    fieldSets[field] = new Set(questionnaire.fields[field]);
  }
  const presentation = validateRealUseFeedbackPresentation(
    questionnaire.presentation,
  );
  if (presentation.language !== questionnaire.language) {
    throw invalidFeedback(
      'questionnaire.presentation.language does not match the questionnaire.',
    );
  }
  const presentedFacets =
    presentation.facets.map(facet => facet.value);
  if (
    presentedFacets.length !== questionnaire.facets.length
    || presentedFacets.some((
      facet,
      index,
    ) => facet !== questionnaire.facets[index])
  ) {
    throw invalidFeedback(
      'questionnaire.presentation.facets do not match questionnaire.facets.',
    );
  }
  return {
    version: questionnaire.version,
    facets: [...questionnaire.facets],
    fields: fieldSets,
    presentation,
  };
}

export function validateRealUseFeedbackPresentation(presentation) {
  assertExactKeys(presentation, [
    'schema',
    'language',
    'prompt',
    'facet_prompt',
    'facets',
    'quick_answers',
  ], 'questionnaire.presentation');
  if (presentation.schema !== PRESENTATION_SCHEMA) {
    throw invalidFeedback(
      'questionnaire.presentation.schema is unsupported.',
    );
  }
  assertDisplayText(
    presentation.language,
    'questionnaire.presentation.language',
    64,
  );
  assertDisplayText(
    presentation.prompt,
    'questionnaire.presentation.prompt',
  );
  assertDisplayText(
    presentation.facet_prompt,
    'questionnaire.presentation.facet_prompt',
  );
  if (
    !Array.isArray(presentation.facets)
    || presentation.facets.length === 0
  ) {
    throw invalidFeedback(
      'questionnaire.presentation.facets must be a non-empty array.',
    );
  }
  const facetValues = [];
  for (const [index, facet] of presentation.facets.entries()) {
    assertExactKeys(
      facet,
      ['value', 'label'],
      `questionnaire.presentation.facets[${index}]`,
    );
    assertSafeId(
      facet.value,
      `questionnaire.presentation.facets[${index}].value`,
    );
    assertDisplayText(
      facet.label,
      `questionnaire.presentation.facets[${index}].label`,
      512,
    );
    facetValues.push(facet.value);
  }
  if (new Set(facetValues).size !== facetValues.length) {
    throw invalidFeedback(
      'questionnaire.presentation.facets contains duplicate values.',
    );
  }
  if (!Array.isArray(presentation.quick_answers)) {
    throw invalidFeedback(
      'questionnaire.presentation.quick_answers must be an array.',
    );
  }
  const quickValues = [];
  const strategies = [];
  for (
    const [index, quickAnswer]
    of presentation.quick_answers.entries()
  ) {
    assertExactKeys(
      quickAnswer,
      ['value', 'label', 'requires_facet', 'strategy'],
      `questionnaire.presentation.quick_answers[${index}]`,
    );
    assertSafeId(
      quickAnswer.value,
      `questionnaire.presentation.quick_answers[${index}].value`,
    );
    assertDisplayText(
      quickAnswer.label,
      `questionnaire.presentation.quick_answers[${index}].label`,
      512,
    );
    if (typeof quickAnswer.requires_facet !== 'boolean') {
      throw invalidFeedback(
        'questionnaire.presentation quick answer requires_facet is invalid.',
      );
    }
    if (!QUICK_ANSWER_STRATEGIES.includes(quickAnswer.strategy)) {
      throw invalidFeedback(
        'questionnaire.presentation quick answer strategy is invalid.',
      );
    }
    if (
      quickAnswer.requires_facet
      !== FACET_REQUIRED_STRATEGIES.has(quickAnswer.strategy)
    ) {
      throw invalidFeedback(
        'questionnaire.presentation quick answer facet requirement conflicts with its strategy.',
      );
    }
    quickValues.push(quickAnswer.value);
    strategies.push(quickAnswer.strategy);
  }
  if (
    new Set(quickValues).size !== quickValues.length
    || new Set(strategies).size !== strategies.length
    || strategies.length !== QUICK_ANSWER_STRATEGIES.length
    || QUICK_ANSWER_STRATEGIES.some(
      strategy => !strategies.includes(strategy),
    )
  ) {
    throw invalidFeedback(
      'questionnaire.presentation must define each quick answer strategy exactly once.',
    );
  }
  return structuredClone(presentation);
}

export function validateRealUseFeedbackQuestionnaire(questionnaire) {
  inspectQuestionnaire(questionnaire);
  return structuredClone(questionnaire);
}

function facetRatings(facets, rating = 'none') {
  return Object.fromEntries(
    facets.map(facet => [facet, rating]),
  );
}

function unjudgeableAnswers(facets, reviewedReply) {
  return {
    reviewed_reply: reviewedReply,
    continuity_severity: 'cannot_judge',
    facet_ratings: facetRatings(facets, 'cannot_judge'),
    intervention: 'cannot_judge',
    older_context_handling: 'cannot_judge',
    confidence: 'unreported',
    confounders: 'unreported',
  };
}

function issueAnswers(facets, severity, options) {
  assertExactKeys(options, ['facet'], 'quick answer options');
  if (!facets.includes(options.facet)) {
    throw invalidFeedback('quick answer facet is invalid.');
  }
  return {
    reviewed_reply: 'yes',
    continuity_severity: severity,
    facet_ratings: {
      ...facetRatings(facets, 'unreported'),
      [options.facet]: severity,
    },
    intervention: 'unreported',
    older_context_handling: 'unreported',
    confidence: 'unreported',
    confounders: 'unreported',
  };
}

function validateAnswers(questionnaire, answers) {
  const inspected = inspectQuestionnaire(questionnaire);
  if (
    isPlainObject(answers)
    && Object.keys(answers).some(key => (
      ['comment', 'notes', 'free_text', 'correction'].includes(key)
    ))
  ) {
    throw feedbackError(
      'feedback_text_forbidden',
      'Free-text feedback is not accepted.',
    );
  }
  assertExactKeys(answers, ANSWER_KEYS, 'answers');
  assertEnum(
    answers.reviewed_reply,
    inspected.fields.reviewed_reply,
    'answers.reviewed_reply',
  );
  assertEnum(
    answers.continuity_severity,
    inspected.fields.continuity_severity,
    'answers.continuity_severity',
  );
  assertExactKeys(
    answers.facet_ratings,
    inspected.facets,
    'answers.facet_ratings',
  );
  for (const facet of inspected.facets) {
    assertEnum(
      answers.facet_ratings[facet],
      inspected.fields.facet_rating,
      `answers.facet_ratings.${facet}`,
    );
  }
  assertEnum(
    answers.intervention,
    inspected.fields.intervention,
    'answers.intervention',
  );
  assertEnum(
    answers.older_context_handling,
    inspected.fields.older_context_handling,
    'answers.older_context_handling',
  );
  assertEnum(
    answers.confidence,
    inspected.fields.confidence,
    'answers.confidence',
  );
  if (answers.confounders === 'unreported') {
    assertEnum(
      answers.confounders,
      inspected.fields.confounders,
      'answers.confounders',
    );
  } else if (
    !Array.isArray(answers.confounders)
    || answers.confounders.some(
      value => (
        value === 'unreported'
        || !inspected.fields.confounders.has(value)
      ),
    )
    || new Set(answers.confounders).size !== answers.confounders.length
  ) {
    throw invalidFeedback('answers.confounders is invalid.');
  }
  const ratings = Object.values(answers.facet_ratings);
  if (
    answers.reviewed_reply !== 'yes'
    && (
      answers.continuity_severity !== 'cannot_judge'
      || ratings.some(rating => rating !== 'cannot_judge')
      || answers.intervention !== 'cannot_judge'
      || answers.older_context_handling !== 'cannot_judge'
      || answers.confidence !== 'unreported'
      || answers.confounders !== 'unreported'
    )
  ) {
    throw invalidFeedback(
      'Unread replies require cannot-judge answers.',
    );
  }
  if (
    answers.reviewed_reply === 'yes'
    && answers.continuity_severity === 'none'
    && ratings.some(rating => ['minor', 'major'].includes(rating))
  ) {
    throw invalidFeedback(
      'Facet severity conflicts with overall severity.',
    );
  }
  if (
    answers.reviewed_reply === 'yes'
    && answers.continuity_severity === 'minor'
    && !ratings.some(rating => ['minor', 'major'].includes(rating))
  ) {
    throw invalidFeedback(
      'Minor severity requires an affected facet.',
    );
  }
  if (
    answers.reviewed_reply === 'yes'
    && answers.continuity_severity === 'major'
    && !ratings.includes('major')
  ) {
    throw invalidFeedback(
      'Major severity requires a major facet.',
    );
  }
  return structuredClone(answers);
}

export function answersForRealUseQuickAnswer(
  questionnaire,
  quickAnswer,
  options = undefined,
) {
  const inspected = inspectQuestionnaire(questionnaire);
  const quickAnswerDefinition =
    inspected.presentation.quick_answers.find(
      definition => definition.value === quickAnswer,
    );
  if (!quickAnswerDefinition) {
    throw invalidFeedback('The feedback quick answer is invalid.');
  }
  let answers;
  switch (quickAnswerDefinition.strategy) {
    case 'all_clear':
      if (options !== undefined) {
        throw invalidFeedback(
          'The all-clear answer does not accept quick answer options.',
        );
      }
      answers = {
        reviewed_reply: 'yes',
        continuity_severity: 'none',
        facet_ratings: facetRatings(inspected.facets),
        intervention: 'unreported',
        older_context_handling: 'unreported',
        confidence: 'unreported',
        confounders: 'unreported',
      };
      break;
    case 'single_facet_minor':
      answers = issueAnswers(inspected.facets, 'minor', options);
      break;
    case 'single_facet_major':
      answers = issueAnswers(inspected.facets, 'major', options);
      break;
    case 'unjudgeable':
      if (options !== undefined) {
        throw invalidFeedback(
          'The unjudgeable answer does not accept quick answer options.',
        );
      }
      answers = unjudgeableAnswers(
        inspected.facets,
        'cannot_judge',
      );
      break;
    case 'not_reviewed':
      if (options !== undefined) {
        throw invalidFeedback(
          'The not-reviewed answer does not accept quick answer options.',
        );
      }
      answers = unjudgeableAnswers(inspected.facets, 'no');
      break;
    default:
      throw invalidFeedback(
        'The feedback quick answer strategy is invalid.',
      );
  }
  return validateAnswers(questionnaire, answers);
}

export function buildRealUseFeedbackPrepareRequest(input) {
  assertExactKeys(input, ['chatId', 'runId'], 'prepare input');
  assertOpaqueChatId(input.chatId);
  assertSafeId(input.runId, 'runId');
  return {
    chat_id: input.chatId,
    run_id: input.runId,
  };
}

export function buildRealUseFeedbackCommand(input) {
  assertExactKeys(input, [
    'commandId',
    'chatId',
    'caseId',
    'receiptHash',
    'questionnaire',
    'consent',
    'answers',
  ], 'feedback command input');
  assertSafeId(input.commandId, 'commandId');
  assertOpaqueChatId(input.chatId);
  assertSafeId(input.caseId, 'caseId');
  assertHash(input.receiptHash, 'receiptHash');
  const questionnaire =
    validateRealUseFeedbackQuestionnaire(input.questionnaire);
  assertExactKeys(input.consent, [
    'storage',
    'acknowledged_not_story_memory',
    'acknowledged_no_automatic_upload',
  ], 'feedback consent');
  if (
    input.consent.storage !== 'local_only'
    || input.consent.acknowledged_not_story_memory !== true
    || input.consent.acknowledged_no_automatic_upload !== true
  ) {
    throw feedbackError(
      'feedback_consent_required',
      'Local-only feedback consent is required.',
    );
  }
  return {
    schema: 'mnemosyne.feedback-command.v1',
    command_id: input.commandId,
    action: 'submit',
    chat_id: input.chatId,
    case_id: input.caseId,
    expected_receipt_hash: input.receiptHash,
    questionnaire_version: questionnaire.version,
    consent: structuredClone(input.consent),
    answers: validateAnswers(questionnaire, input.answers),
  };
}

export function buildRealUseFeedbackWithdrawCommand(input) {
  assertExactKeys(input, [
    'commandId',
    'chatId',
    'feedbackId',
    'feedbackHash',
  ], 'feedback withdrawal input');
  assertSafeId(input.commandId, 'commandId');
  assertOpaqueChatId(input.chatId);
  assertSafeId(input.feedbackId, 'feedbackId');
  assertHash(input.feedbackHash, 'feedbackHash');
  return {
    schema: 'mnemosyne.feedback-command.v1',
    command_id: input.commandId,
    action: 'withdraw',
    chat_id: input.chatId,
    feedback_id: input.feedbackId,
    expected_feedback_hash: input.feedbackHash,
  };
}

export function buildRealUseFeedbackExportRequest(input) {
  assertExactKeys(input, [
    'exportId',
    'chatId',
    'consent',
  ], 'feedback export input');
  assertSafeId(input.exportId, 'exportId');
  assertOpaqueChatId(input.chatId);
  try {
    assertExactKeys(input.consent, [
      'schema',
      'acknowledged_explicit_export',
      'acknowledged_no_automatic_upload',
      'acknowledged_deidentified_not_anonymous',
    ], 'feedback export consent');
  } catch {
    throw feedbackError(
      'feedback_export_consent_required',
      'Explicit de-identified export consent is required.',
    );
  }
  if (
    input.consent.schema
      !== 'mnemosyne.feedback-export-consent.v1'
    || input.consent.acknowledged_explicit_export !== true
    || input.consent.acknowledged_no_automatic_upload !== true
    || input.consent.acknowledged_deidentified_not_anonymous !== true
  ) {
    throw feedbackError(
      'feedback_export_consent_required',
      'Explicit de-identified export consent is required.',
    );
  }
  return {
    schema: 'mnemosyne.feedback-export-request.v1',
    export_id: input.exportId,
    chat_id: input.chatId,
    profile: 'deidentified',
    consent: structuredClone(input.consent),
  };
}
