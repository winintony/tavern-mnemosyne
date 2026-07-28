export function buildSourceRemovalRunScope({
    chatId,
    runId,
    hostRunScope,
} = {}) {
    if (
        typeof chatId !== 'string'
        || !chatId
        || typeof runId !== 'string'
        || !runId
        || !hostRunScope
        || typeof hostRunScope !== 'object'
        || Array.isArray(hostRunScope)
        || hostRunScope.chat_id !== chatId
        || !Number.isInteger(hostRunScope.branch_epoch)
        || hostRunScope.branch_epoch < 0
        || !Number.isInteger(hostRunScope.target_turn_index)
        || hostRunScope.target_turn_index < 0
    ) {
        const error = new Error(
            'Source removal requires the exact target story run scope.',
        );
        error.reasonCode = 'source_removal_run_scope_invalid';
        throw error;
    }
    return Object.freeze({
        chat_id: chatId,
        run_id: runId,
        branch_id: 'main',
        branch_epoch: hostRunScope.branch_epoch,
        turn_index: hostRunScope.target_turn_index,
    });
}

function sourceRemovalGrantResponseError(response, body) {
    const reasonCode =
        body?.error?.reason_code
        ?? 'source_removal_grant_failed';
    const error = new Error(
        body?.error?.message
        ?? `Source-removal grant request failed with status ${response?.status}.`,
    );
    error.reasonCode = reasonCode;
    return error;
}

export function resolveSourceRemovalGrantEvidence(response, body) {
    if (response?.ok && body?.status === 'issued') {
        if (!Array.isArray(body.grants)) {
            const error = new Error(
                'Source-removal issuance returned no grant array.',
            );
            error.reasonCode = 'source_removal_grant_response_invalid';
            throw error;
        }
        if (body.grants.length === 0) {
            return Object.freeze({
                grants: [],
                sourceCoverage: null,
            });
        }
        if (
            !body.coverage_binding
            || typeof body.coverage_binding !== 'object'
            || Array.isArray(body.coverage_binding)
            || typeof body.coverage_binding_hash !== 'string'
            || !/^[a-f0-9]{64}$/.test(body.coverage_binding_hash)
        ) {
            const error = new Error(
                'Source-removal issuance returned no trusted coverage binding.',
            );
            error.reasonCode = 'source_removal_grant_response_invalid';
            throw error;
        }
        return Object.freeze({
            grants: structuredClone(body.grants),
            sourceCoverage: Object.freeze({
                binding: structuredClone(body.coverage_binding),
                binding_hash: body.coverage_binding_hash,
            }),
        });
    }
    throw sourceRemovalGrantResponseError(response, body);
}

export function resolveSourceRemovalGrantResponse(response, body) {
    return resolveSourceRemovalGrantEvidence(response, body).grants;
}
