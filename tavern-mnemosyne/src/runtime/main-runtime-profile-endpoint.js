import {
  normalizeMainRuntimeProfile,
} from './main-runtime-profile-contract.js';

export const MAIN_RUNTIME_PROFILE_ROUTE =
  '/v1/runtime-profile/activate';

function send(response, statusCode, body) {
  response.setHeader?.('cache-control', 'no-store');
  return response.status(statusCode).json(body);
}

function blocked(reasonCode) {
  return {
    schema: 'mnemosyne.runtime-profile-activation.v1',
    status: 'blocked',
    active_profile_hash: null,
    reason_code: reasonCode,
  };
}

export function createMainRuntimeProfileEndpoint({
  supervisor,
} = {}) {
  if (typeof supervisor?.activate !== 'function') {
    throw new TypeError(
      'Main runtime profile endpoint requires a supervisor.',
    );
  }

  async function handle(request, response) {
    const body = request?.body;
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.getPrototypeOf(body) !== Object.prototype
      || Object.keys(body).length !== 1
      || !Object.hasOwn(body, 'profile')
    ) {
      return send(
        response,
        422,
        blocked('runtime_profile_request_invalid'),
      );
    }
    let profile;
    try {
      profile = normalizeMainRuntimeProfile(body.profile);
    } catch (error) {
      return send(
        response,
        422,
        blocked(
          error?.reasonCode ?? 'runtime_profile_request_invalid',
        ),
      );
    }
    let result;
    try {
      result = await supervisor.activate(profile);
    } catch {
      result = {
        status: 'blocked',
        active_profile_hash: null,
        reasonCode: 'runtime_profile_activation_unavailable',
      };
    }
    if (result?.status === 'ready') {
      return send(response, 200, {
        schema: 'mnemosyne.runtime-profile-activation.v1',
        status: 'ready',
        active_profile_hash: result.active_profile_hash,
        runtime_instance_id: result.runtime_instance_id,
        reused: result.reused === true,
      });
    }
    const reasonCode = (
      typeof result?.reasonCode === 'string'
      && result.reasonCode
    )
      ? result.reasonCode
      : 'runtime_profile_activation_unavailable';
    const statusCode = [
      'runtime_profile_operation_busy',
      'runtime_profile_switch_busy',
    ].includes(reasonCode)
      ? 409
      : 503;
    return send(response, statusCode, {
      ...blocked(reasonCode),
      ...(typeof result?.rolled_back === 'boolean'
        ? { rolled_back: result.rolled_back }
        : {}),
      ...(typeof result?.active_profile_hash === 'string'
        ? {
            active_profile_hash:
              result.active_profile_hash,
          }
        : {}),
    });
  }

  function register(router) {
    router.post(MAIN_RUNTIME_PROFILE_ROUTE, handle);
  }

  return Object.freeze({
    handle,
    register,
  });
}
