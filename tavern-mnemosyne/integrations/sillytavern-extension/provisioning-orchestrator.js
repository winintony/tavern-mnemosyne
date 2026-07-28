import {
    browserFolderEligibility,
    provisionBrowserFolder,
} from './browser-folder-provisioning.js';

function orchestratorError(reasonCode, message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.reasonCode = reasonCode;
    return error;
}

function delay(milliseconds) {
    return new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

export function createProvisioningOrchestrator({
    pageUrl = globalThis.location?.href,
    secureContext = globalThis.isSecureContext,
    showDirectoryPicker = globalThis.showDirectoryPicker,
    controlClient,
    loadBrowserFolderInput,
    now,
    randomUUID,
} = {}) {
    if (
        !controlClient
        || typeof controlClient.resolveRootTransport !== 'function'
    ) {
        throw new TypeError(
            'ProvisioningOrchestrator requires a Control Client.',
        );
    }
    if (typeof loadBrowserFolderInput !== 'function') {
        throw new TypeError(
            'ProvisioningOrchestrator requires BrowserFolder inputs.',
        );
    }

    async function inspect() {
        try {
            const lease = await controlClient.resolveRootTransport();
            return Object.freeze({
                status: 'ready',
                adapter: lease.adapter_id === 'bridge'
                    ? 'server'
                    : 'existing-loopback',
                lease,
                restart_required: false,
            });
        } catch (controlError) {
            const eligibility = browserFolderEligibility({
                pageUrl,
                secureContext,
                showDirectoryPicker,
            });
            if (eligibility.applicable) {
                return Object.freeze({
                    status: 'available',
                    adapter: 'browser-folder',
                    lease: null,
                    restart_required: true,
                    prior_error: controlError?.reasonCode
                        ?? controlError?.message
                        ?? 'runtime_unavailable',
                });
            }
            return Object.freeze({
                status: 'unsupported',
                adapter: null,
                lease: null,
                restart_required: false,
                reason_code: eligibility.reason_code,
                prior_error: controlError?.reasonCode
                    ?? controlError?.message
                    ?? 'runtime_unavailable',
            });
        }
    }

    async function verify({
        timeoutMs = 0,
        intervalMs = 2_000,
        onAttempt = () => {},
    } = {}) {
        const startedAt = Date.now();
        let lastError = null;
        do {
            try {
                const lease = await controlClient.resolveRootTransport({
                    force: true,
                });
                return Object.freeze({
                    status: 'ready',
                    adapter: lease.adapter_id === 'bridge'
                        ? 'server'
                        : 'existing-loopback',
                    lease,
                    restart_required: false,
                });
            } catch (error) {
                lastError = error;
                await onAttempt(error);
                if (Date.now() - startedAt >= timeoutMs) break;
                await delay(Math.min(
                    intervalMs,
                    Math.max(0, timeoutMs - (Date.now() - startedAt)),
                ));
            }
        } while (Date.now() - startedAt <= timeoutMs);
        throw orchestratorError(
            'mnemosyne_provisioning_verification_failed',
            'Mnemosyne did not become healthy after provisioning.',
            lastError,
        );
    }

    async function enable({
        onPlan,
    } = {}) {
        const current = await inspect();
        if (current.status === 'ready') return current;
        if (current.adapter !== 'browser-folder') {
            throw orchestratorError(
                current.reason_code
                    ?? 'mnemosyne_provisioning_unsupported',
                'This SillyTavern deployment has no supported one-action provisioner.',
            );
        }
        const rootHandle = await showDirectoryPicker({
            id: 'mnemosyne-st-root',
            mode: 'readwrite',
        });
        if (typeof rootHandle.queryPermission === 'function') {
            const permission = await rootHandle.queryPermission({
                mode: 'readwrite',
            });
            if (permission !== 'granted') {
                throw orchestratorError(
                    'browser_folder_permission_not_granted',
                    'Directory read/write permission was not granted.',
                );
            }
        }
        const input = await loadBrowserFolderInput();
        const receipt = await provisionBrowserFolder({
            rootHandle,
            ...input,
            onPlan,
            now,
            randomUUID,
        });
        return Object.freeze({
            status: receipt.status,
            adapter: 'browser-folder',
            restart_required: true,
            receipt,
        });
    }

    return Object.freeze({
        inspect,
        enable,
        verify,
    });
}
