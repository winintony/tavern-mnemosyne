import {
    browserFolderEligibility,
    provisionBrowserFolder as provisionBrowserFolderDefault,
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
    loadSavedDirectoryHandle = async () => null,
    saveDirectoryHandle = async () => {},
    clearSavedDirectoryHandle = async () => {},
    controlClient,
    loadBrowserFolderInput,
    loadExpectedRuntimeBuildId = null,
    validateReadyLease = async () => {},
    provisionBrowserFolder = provisionBrowserFolderDefault,
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
    if (typeof validateReadyLease !== 'function') {
        throw new TypeError(
            'ProvisioningOrchestrator ready-lease validator is invalid.',
        );
    }

    // The extension version is not a usable trigger: several deployments in a
    // row shipped as 0.2.7, so anything keyed on it silently kept the old
    // runtime. The installed runtime build id is a content fingerprint, and a
    // healthy runtime that does not match the one this extension ships with
    // has to be reinstalled rather than settled for.
    async function expectedRuntimeBuildId() {
        if (typeof loadExpectedRuntimeBuildId !== 'function') return null;
        let expected;
        try {
            expected = await loadExpectedRuntimeBuildId();
        } catch (error) {
            throw orchestratorError(
                'browser_folder_runtime_fingerprint_unavailable',
                'The shipped Mnemosyne runtime fingerprint is unavailable.',
                error,
            );
        }
        if (typeof expected !== 'string' || !expected) {
            throw orchestratorError(
                'browser_folder_runtime_fingerprint_unavailable',
                'The shipped Mnemosyne runtime fingerprint is invalid.',
            );
        }
        return expected;
    }

    async function attestReadyLease(lease, {
        explicit = false,
        expectedBuildId = null,
    } = {}) {
        if (
            expectedBuildId
            && lease?.runtime_build_id !== expectedBuildId
        ) {
            throw orchestratorError(
                'browser_folder_runtime_build_mismatch',
                'The running Mnemosyne build is not the shipped build.',
            );
        }
        await validateReadyLease(lease, { explicit });
        return lease;
    }

    async function inspect({
        explicit = true,
    } = {}) {
        try {
            const lease = await controlClient.resolveRootTransport();
            const expected = await expectedRuntimeBuildId();
            const adapter = lease.adapter_id === 'bridge'
                ? 'server'
                : 'existing-loopback';
            try {
                await attestReadyLease(lease, {
                    explicit,
                    expectedBuildId: expected,
                });
            } catch (error) {
                if (
                    error?.reasonCode
                        !== 'browser_folder_runtime_build_mismatch'
                ) {
                    throw error;
                }
                const eligibility = browserFolderEligibility({
                    pageUrl,
                    secureContext,
                    showDirectoryPicker,
                });
                return Object.freeze({
                    status: 'stale',
                    adapter: eligibility.applicable
                        ? 'browser-folder'
                        : adapter,
                    lease,
                    restart_required: true,
                    installed_runtime_build_id: lease.runtime_build_id ?? null,
                    expected_runtime_build_id: expected,
                    ...(eligibility.applicable
                        ? {}
                        : { reason_code: eligibility.reason_code }),
                });
            }
            return Object.freeze({
                status: 'ready',
                adapter,
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
        const expected = await expectedRuntimeBuildId();
        do {
            try {
                const lease = await controlClient.resolveRootTransport({
                    force: true,
                });
                await attestReadyLease(lease, {
                    explicit: true,
                    expectedBuildId: expected,
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
        const current = await inspect({ explicit: true });
        if (current.status === 'ready') return current;
        if (current.adapter !== 'browser-folder') {
            throw orchestratorError(
                current.reason_code
                    ?? 'mnemosyne_provisioning_unsupported',
                'This SillyTavern deployment has no supported one-action provisioner.',
            );
        }
        const validDirectoryHandle = handle => (
            handle?.kind === 'directory'
            && typeof handle.getDirectoryHandle === 'function'
        );
        const hasReadWritePermission = async handle => {
            if (typeof handle.queryPermission !== 'function') return true;
            let permission = await handle.queryPermission({
                mode: 'readwrite',
            });
            if (
                permission === 'prompt'
                && typeof handle.requestPermission === 'function'
            ) {
                permission = await handle.requestPermission({
                    mode: 'readwrite',
                });
            }
            return permission === 'granted';
        };
        let rootHandle = await loadSavedDirectoryHandle();
        if (
            validDirectoryHandle(rootHandle)
            && !await hasReadWritePermission(rootHandle)
        ) {
            await clearSavedDirectoryHandle();
            rootHandle = null;
        }
        if (!validDirectoryHandle(rootHandle)) {
            rootHandle = await showDirectoryPicker({
                id: 'mnemosyne-st-root',
                mode: 'readwrite',
            });
            if (
                !validDirectoryHandle(rootHandle)
                || !await hasReadWritePermission(rootHandle)
            ) {
                await clearSavedDirectoryHandle();
                throw orchestratorError(
                    'browser_folder_permission_not_granted',
                    'Directory read/write permission was not granted.',
                );
            }
            await saveDirectoryHandle(rootHandle);
        }
        let receipt;
        try {
            const input = await loadBrowserFolderInput({
                rootHandle,
                explicit: true,
            });
            const reconciled = await inspect();
            if (reconciled.status === 'ready') return reconciled;
            receipt = await provisionBrowserFolder({
                rootHandle,
                ...input,
                onPlan,
                now,
                randomUUID,
            });
        } catch (error) {
            if (
                error?.name === 'NotFoundError'
                || [
                    'browser_folder_wrong_sillytavern_root',
                    'browser_folder_extension_install_not_found',
                ].includes(error?.reasonCode)
            ) {
                await clearSavedDirectoryHandle();
            }
            throw error;
        }
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
