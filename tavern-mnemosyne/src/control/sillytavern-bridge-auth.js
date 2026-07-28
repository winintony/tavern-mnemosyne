import { randomUUID } from 'node:crypto';

function sendRejection(response, reasonCode) {
  const traceId = randomUUID();
  response.setHeader?.('cache-control', 'no-store');
  response.setHeader?.('x-request-id', traceId);
  response.setHeader?.('x-content-type-options', 'nosniff');
  return response.status(403).json({
    schema: 'mnemosyne.bridge-error.v1',
    error: {
      reason_code: reasonCode,
      origin: 'bridge',
      bridge_stage: 'bridge_rejected',
      operation: null,
      trace_id: traceId,
      delivery_state: 'not_dispatched',
      retry_disposition: 'never',
      protocol_version: '1',
      runtime_build_id: null,
      runtime_instance_id: null,
    },
  });
}

export function requireSillyTavernBridgeSession(
  request,
  response,
  next,
) {
  if (!request?.user) {
    return sendRejection(
      response,
      'bridge_session_required',
    );
  }
  if (request.method === 'GET') {
    return next();
  }
  const csrfToken = request.headers?.['x-csrf-token'];
  if (
    typeof csrfToken !== 'string'
    || !csrfToken
    || csrfToken.length > 512
    || /[\u0000-\u001f\u007f]/.test(csrfToken)
  ) {
    return sendRejection(
      response,
      'bridge_csrf_header_required',
    );
  }
  return next();
}
