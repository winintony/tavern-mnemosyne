const AUTHENTICATION_STATUS_CODES = new Set([401, 403]);
const AUTHENTICATION_MESSAGE =
  /(?:unauthori[sz]ed|authentication|invalid\s+(?:api\s+)?key|api\s+key\s+invalid)/i;
const REQUEST_COMPATIBILITY_STATUS_CODES = new Set([400, 404, 405, 422]);

function plainObject(value) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function bindPreparedIntakeHostRequest({
  modelRequest,
  requestId,
  executionLease,
  intakeCapability,
  proxyBaseUrl,
}) {
  if (
    !plainObject(modelRequest)
    || typeof requestId !== 'string'
    || !requestId
    || !plainObject(executionLease)
    || typeof intakeCapability !== 'string'
    || !intakeCapability
    || typeof proxyBaseUrl !== 'string'
    || !proxyBaseUrl
    || Object.hasOwn(
      modelRequest,
      'mnemosyne_intake_request_id',
    )
    || Object.hasOwn(
      modelRequest,
      'mnemosyne_intake_execution_lease',
    )
  ) {
    throw new TypeError(
      'Prepared Static Lore host transport binding is invalid.',
    );
  }
  const transportBody = {
    ...structuredClone(modelRequest),
    mnemosyne_intake_request_id: requestId,
    mnemosyne_intake_execution_lease:
      structuredClone(executionLease),
  };
  return {
    ...structuredClone(modelRequest),
    chat_completion_source: 'custom',
    custom_url:
      `${proxyBaseUrl.replace(/\/+$/, '')}/v1/mnemosyne/intake`,
    // SillyTavern reconstructs Custom OpenAI requests from a fixed set of
    // top-level fields. The custom body is its supported lossless transport
    // for provider-specific fields such as DeepSeek's `thinking`.
    custom_include_body: JSON.stringify(transportBody),
    custom_exclude_body: '',
    custom_include_headers: JSON.stringify({
      'x-mnemosyne-intake-capability': intakeCapability,
    }),
    custom_prompt_post_processing: '',
  };
}

export function classifyIntakeModelFailure({
  responseOk,
  responseStatus,
  completion,
}) {
  const error = completion?.error;
  const upstreamStatus =
    error?.upstream_status
    ?? error?.details?.upstream_status
    ?? completion?.upstream_status
    ?? null;
  const message = [
    error?.message,
    error?.type,
    error?.code,
  ].filter(value => typeof value === 'string').join(' ');
  if (
    AUTHENTICATION_STATUS_CODES.has(responseStatus)
    || AUTHENTICATION_STATUS_CODES.has(upstreamStatus)
    || AUTHENTICATION_MESSAGE.test(message)
  ) {
    return 'upstream_authentication_failed';
  }
  if (typeof error?.reason_code === 'string' && error.reason_code) {
    return error.reason_code;
  }
  if (
    REQUEST_COMPATIBILITY_STATUS_CODES.has(responseStatus)
    || REQUEST_COMPATIBILITY_STATUS_CODES.has(upstreamStatus)
    || /\bbad request\b/i.test(message)
  ) {
    return 'upstream_model_request_incompatible';
  }
  return responseOk
    ? 'static_lore_intake_model_failed'
    : 'static_lore_intake_upstream_response_error';
}
