const AUTHENTICATION_STATUS_CODES = new Set([401, 403]);
const AUTHENTICATION_MESSAGE =
  /(?:unauthori[sz]ed|authentication|invalid\s+(?:api\s+)?key|api\s+key\s+invalid)/i;
const REQUEST_COMPATIBILITY_STATUS_CODES = new Set([400, 404, 405, 422]);

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
