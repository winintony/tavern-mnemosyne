const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const BROWSER_FOLDER_PATHS = Object.freeze({
    package: 'package.json',
    config: 'config.yaml',
    codeRoot: 'data/default-user/extensions/tavern-mnemosyne',
    codeManifest:
        'data/default-user/extensions/tavern-mnemosyne/manifest.json',
    extensionManifest:
        'data/default-user/extensions/tavern-mnemosyne/'
        + 'tavern-mnemosyne/integrations/sillytavern-extension/'
        + 'manifest.json',
    runtimeManifest:
        'data/default-user/extensions/tavern-mnemosyne/'
        + 'tavern-mnemosyne/distribution/runtime-bundle/'
        + 'manifest.json',
    stub: 'plugins/tavern-mnemosyne/index.mjs',
    binding: 'plugins/tavern-mnemosyne/binding.json',
    stateRoot: 'data/_mnemosyne',
    runtimeConfig: 'data/_mnemosyne/config/runtime.json',
    installRoot: 'data/_mnemosyne/install',
});

const SAFE_BUILD_ID = /^[A-Za-z0-9@._+-]{1,160}$/;
const MANIFEST_SCHEMA =
    'mnemosyne.self-contained-runtime-bundle.v1';
const BINDING_SCHEMA = 'mnemosyne.bootstrap-binding.v1';
const RECEIPT_SCHEMA = 'mnemosyne.browser-folder-install.v1';

function provisioningError(reasonCode, message) {
    const error = new Error(message);
    error.reasonCode = reasonCode;
    return error;
}

function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength,
        );
    }
    return TEXT_ENCODER.encode(String(value));
}

function equalBytes(left, right) {
    const a = bytes(left);
    const b = bytes(right);
    if (a.byteLength !== b.byteLength) return false;
    let mismatch = 0;
    for (let index = 0; index < a.byteLength; index += 1) {
        mismatch |= a[index] ^ b[index];
    }
    return mismatch === 0;
}

export async function sha256Hex(value, {
    crypto = globalThis.crypto,
} = {}) {
    if (!crypto?.subtle) {
        throw provisioningError(
            'browser_folder_crypto_unavailable',
            'The browser cannot calculate installation integrity hashes.',
        );
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes(value));
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function browserFolderEligibility({
    pageUrl,
    secureContext = globalThis.isSecureContext,
    showDirectoryPicker = globalThis.showDirectoryPicker,
} = {}) {
    let url;
    try {
        url = new URL(pageUrl ?? globalThis.location?.href);
    } catch {
        return Object.freeze({
            applicable: false,
            reason_code: 'browser_folder_page_url_invalid',
        });
    }
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(
        url.hostname,
    );
    if (!localHost) {
        return Object.freeze({
            applicable: false,
            reason_code: 'browser_folder_requires_local_host',
        });
    }
    if (!secureContext) {
        return Object.freeze({
            applicable: false,
            reason_code: 'browser_folder_requires_secure_context',
        });
    }
    if (typeof showDirectoryPicker !== 'function') {
        return Object.freeze({
            applicable: false,
            reason_code: 'browser_folder_api_unavailable',
        });
    }
    return Object.freeze({
        applicable: true,
        reason_code: null,
    });
}

function pathSegments(relativePath) {
    const value = String(relativePath ?? '').replaceAll('\\', '/');
    const parts = value.split('/');
    if (
        !value
        || value.startsWith('/')
        || /^[A-Za-z]:\//.test(value)
        || parts.some(part => !part || part === '.' || part === '..')
    ) {
        throw provisioningError(
            'browser_folder_path_unsafe',
            `Unsafe installation path: ${relativePath}`,
        );
    }
    return parts;
}

async function directoryAt(root, segments, { create = false } = {}) {
    let directory = root;
    for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, {
            create,
        });
    }
    return directory;
}

async function fileHandleAt(root, relativePath, {
    create = false,
} = {}) {
    const parts = pathSegments(relativePath);
    const name = parts.pop();
    const directory = await directoryAt(root, parts, { create });
    return directory.getFileHandle(name, { create });
}

async function readFileBytes(root, relativePath) {
    const handle = await fileHandleAt(root, relativePath);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
}

async function readFileText(root, relativePath) {
    return TEXT_DECODER.decode(await readFileBytes(root, relativePath));
}

async function writeFileVerified(root, relativePath, content) {
    const value = bytes(content);
    const handle = await fileHandleAt(root, relativePath, {
        create: true,
    });
    const writable = await handle.createWritable();
    try {
        await writable.write(value);
        await writable.close();
    } catch (error) {
        try {
            await writable.abort?.();
        } catch {
            // The original write failure is the actionable error.
        }
        throw error;
    }
    const reread = await readFileBytes(root, relativePath);
    if (!equalBytes(value, reread)) {
        throw provisioningError(
            'browser_folder_write_verification_failed',
            `The browser could not verify ${relativePath} after writing it.`,
        );
    }
    return Object.freeze({
        path: relativePath,
        sha256: await sha256Hex(value),
        bytes: value.byteLength,
    });
}

async function removeFileIfPresent(root, relativePath) {
    const parts = pathSegments(relativePath);
    const name = parts.pop();
    try {
        const directory = await directoryAt(root, parts);
        await directory.removeEntry(name);
    } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
    }
}

function parseJson(text, reasonCode, description) {
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('not an object');
        }
        return value;
    } catch {
        throw provisioningError(
            reasonCode,
            `${description} is not a valid JSON object.`,
        );
    }
}

function parseTopLevelYamlSetting(line, key) {
    const match = line.match(
        /^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_]+))\s*:(.*)$/,
    );
    if (!match || match[1] !== '') return null;
    const parsedKey = match[2] ?? match[3] ?? match[4];
    if (parsedKey !== key) return null;
    const tail = match[5];
    let quote = null;
    let commentAt = -1;
    for (let index = 0; index < tail.length; index += 1) {
        const character = tail[index];
        if (quote) {
            if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === '#') {
            commentAt = index;
            break;
        }
    }
    return Object.freeze({
        prefix: line.slice(0, line.indexOf(':') + 1),
        comment: commentAt === -1 ? '' : tail.slice(commentAt),
    });
}

export function rewriteServerPluginConfig(source) {
    if (typeof source !== 'string') {
        throw provisioningError(
            'browser_folder_config_invalid',
            'config.yaml must be text.',
        );
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const trailingNewline = source.endsWith('\n');
    const lines = source.replaceAll('\r\n', '\n').split('\n');
    if (trailingNewline) lines.pop();
    const settings = new Map([
        ['enableServerPlugins', 'true'],
        ['enableServerPluginsAutoUpdate', 'false'],
    ]);
    for (const [key, value] of settings) {
        const matches = [];
        for (let index = 0; index < lines.length; index += 1) {
            const parsed = parseTopLevelYamlSetting(lines[index], key);
            if (parsed) matches.push({ index, parsed });
        }
        if (matches.length > 1) {
            throw provisioningError(
                'browser_folder_config_duplicate_key',
                `config.yaml contains more than one ${key} field.`,
            );
        }
        if (matches.length === 1) {
            const { index, parsed } = matches[0];
            lines[index] = `${parsed.prefix} ${value}${
                parsed.comment ? ` ${parsed.comment.trimStart()}` : ''
            }`;
        } else {
            lines.push(`${key}: ${value}`);
        }
    }
    return `${lines.join(newline)}${trailingNewline ? newline : ''}`;
}

function parseTarOctal(header, start, length) {
    const raw = TEXT_DECODER.decode(
        header.subarray(start, start + length),
    ).replaceAll('\0', '').trim();
    if (!/^[0-7]*$/.test(raw)) {
        throw provisioningError(
            'browser_folder_runtime_archive_invalid',
            'The runtime archive contains an invalid numeric field.',
        );
    }
    return raw ? Number.parseInt(raw, 8) : 0;
}

function tarHeaderChecksum(header) {
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    return sum;
}

function tarString(header, start, length) {
    return TEXT_DECODER.decode(
        header.subarray(start, start + length),
    ).replace(/\0.*$/s, '');
}

export function parseRuntimeTar(tarBytes) {
    const archive = bytes(tarBytes);
    const files = new Map();
    let offset = 0;
    while (offset + 512 <= archive.byteLength) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const expectedChecksum = parseTarOctal(header, 148, 8);
        if (tarHeaderChecksum(header) !== expectedChecksum) {
            throw provisioningError(
                'browser_folder_runtime_archive_checksum_mismatch',
                'The runtime archive header checksum does not match.',
            );
        }
        const name = tarString(header, 0, 100);
        pathSegments(name);
        const type = String.fromCharCode(header[156] || 0x30);
        if (type !== '0' && type !== '\0') {
            throw provisioningError(
                'browser_folder_runtime_archive_entry_unsupported',
                `The runtime archive contains unsupported entry ${name}.`,
            );
        }
        if (files.has(name)) {
            throw provisioningError(
                'browser_folder_runtime_archive_duplicate_entry',
                `The runtime archive contains duplicate entry ${name}.`,
            );
        }
        const size = parseTarOctal(header, 124, 12);
        const contentStart = offset + 512;
        const contentEnd = contentStart + size;
        if (contentEnd > archive.byteLength) {
            throw provisioningError(
                'browser_folder_runtime_archive_truncated',
                `The runtime archive is truncated at ${name}.`,
            );
        }
        files.set(name, archive.slice(contentStart, contentEnd));
        offset = contentStart + Math.ceil(size / 512) * 512;
    }
    return files;
}

export async function decodeAndVerifyRuntimeBundle({
    manifest,
    archiveBytes,
    decompressionStream = globalThis.DecompressionStream,
}) {
    if (
        manifest?.schema !== MANIFEST_SCHEMA
        || !SAFE_BUILD_ID.test(manifest.runtime_build_id ?? '')
        || manifest.archive !== 'runtime.tar.gz'
        || !Array.isArray(manifest.files)
    ) {
        throw provisioningError(
            'browser_folder_runtime_manifest_invalid',
            'The bundled runtime manifest is invalid.',
        );
    }
    const archive = bytes(archiveBytes);
    const archiveHash = await sha256Hex(archive);
    if (archiveHash !== manifest.archive_sha256) {
        throw provisioningError(
            'browser_folder_runtime_archive_hash_mismatch',
            'The bundled runtime archive does not match its manifest.',
        );
    }
    if (typeof decompressionStream !== 'function') {
        throw provisioningError(
            'browser_folder_decompression_unavailable',
            'This browser cannot unpack the bundled runtime.',
        );
    }
    const decompressed = await new Response(
        new Blob([archive]).stream().pipeThrough(
            new decompressionStream('gzip'),
        ),
    ).arrayBuffer();
    const unpacked = parseRuntimeTar(decompressed);
    const expectedPaths = new Set();
    for (const record of manifest.files) {
        if (
            !record
            || typeof record.path !== 'string'
            || !Number.isSafeInteger(record.bytes)
            || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')
        ) {
            throw provisioningError(
                'browser_folder_runtime_manifest_invalid',
                'The bundled runtime file manifest is invalid.',
            );
        }
        pathSegments(record.path);
        if (expectedPaths.has(record.path)) {
            throw provisioningError(
                'browser_folder_runtime_manifest_duplicate',
                `The runtime manifest repeats ${record.path}.`,
            );
        }
        expectedPaths.add(record.path);
        const content = unpacked.get(record.path);
        if (
            !content
            || content.byteLength !== record.bytes
            || await sha256Hex(content) !== record.sha256
        ) {
            throw provisioningError(
                'browser_folder_runtime_file_hash_mismatch',
                `The bundled runtime file ${record.path} is invalid.`,
            );
        }
    }
    if (
        unpacked.size !== expectedPaths.size
        || [...unpacked.keys()].some(path => !expectedPaths.has(path))
    ) {
        throw provisioningError(
            'browser_folder_runtime_archive_extra_entry',
            'The runtime archive contains files not sealed by its manifest.',
        );
    }
    return Object.freeze({
        runtime_build_id: manifest.runtime_build_id,
        files: unpacked,
    });
}

export function createBrowserFolderRuntimeConfig({
    upstreamBaseUrl,
    upstreamModel,
    providerContextTokens,
    providerOutputReserveTokens,
}) {
    let parsedUrl;
    try {
        parsedUrl = new URL(upstreamBaseUrl);
    } catch {
        throw provisioningError(
            'browser_folder_upstream_url_invalid',
            'The active Custom OpenAI endpoint is not a valid URL.',
        );
    }
    if (
        !['http:', 'https:'].includes(parsedUrl.protocol)
        || ['127.0.0.1', 'localhost', '::1'].includes(
            parsedUrl.hostname,
        )
        || parsedUrl.username
        || parsedUrl.password
        || parsedUrl.hash
        || [...parsedUrl.searchParams.keys()].some(key => (
            /(?:api[-_]?key|secret|token|signature|credential)/i
                .test(key)
        ))
    ) {
        throw provisioningError(
            'browser_folder_upstream_url_invalid',
            'Select the real upstream Custom OpenAI endpoint before enabling Mnemosyne.',
        );
    }
    const model = String(upstreamModel ?? '').trim();
    const context = Number(providerContextTokens);
    const reserve = Number(providerOutputReserveTokens);
    if (!model) {
        throw provisioningError(
            'browser_folder_upstream_model_missing',
            'The active Custom OpenAI model is required.',
        );
    }
    if (
        !Number.isSafeInteger(context)
        || !Number.isSafeInteger(reserve)
        || context <= 0
        || reserve <= 0
        || reserve >= context
    ) {
        throw provisioningError(
            'browser_folder_provider_budget_invalid',
            'The active model context and output token budgets are invalid.',
        );
    }
    return Object.freeze({
        schema: 'mnemosyne.runtime-config.v1',
        host: '127.0.0.1',
        port: 18991,
        upstreamBaseUrl: parsedUrl.href.replace(/\/+$/, ''),
        upstreamModel: model,
        upstreamAuthMode: 'passthrough',
        providerContextTokens: context,
        providerOutputReserveTokens: reserve,
        contextMode: 'production',
    });
}

export async function readInstalledBrowserFolderRuntimeConfig(rootHandle) {
    let source;
    try {
        source = await readFileText(
            rootHandle,
            BROWSER_FOLDER_PATHS.runtimeConfig,
        );
    } catch (error) {
        if (error?.name === 'NotFoundError') return null;
        throw error;
    }
    const parsed = parseJson(
        source,
        'browser_folder_runtime_config_invalid',
        'The installed Mnemosyne runtime config',
    );
    return createBrowserFolderRuntimeConfig({
        upstreamBaseUrl: parsed.upstreamBaseUrl,
        upstreamModel: parsed.upstreamModel,
        providerContextTokens: parsed.providerContextTokens,
        providerOutputReserveTokens:
            parsed.providerOutputReserveTokens,
    });
}

async function validateSelectedRoot({
    rootHandle,
    hostVersion,
    expectedExtensionVersion,
}) {
    const packageJson = parseJson(
        await readFileText(rootHandle, BROWSER_FOLDER_PATHS.package),
        'browser_folder_sillytavern_package_invalid',
        'The selected SillyTavern package.json',
    );
    if (
        String(packageJson.name ?? '').toLowerCase() !== 'sillytavern'
        || (
            hostVersion
            && packageJson.version !== hostVersion
        )
    ) {
        throw provisioningError(
            'browser_folder_wrong_sillytavern_root',
            'The selected folder is not the SillyTavern instance serving this page.',
        );
    }
    const configSource = await readFileText(
        rootHandle,
        BROWSER_FOLDER_PATHS.config,
    );
    rewriteServerPluginConfig(configSource);
    const codeManifest = parseJson(
        await readFileText(
            rootHandle,
            BROWSER_FOLDER_PATHS.codeManifest,
        ),
        'browser_folder_code_manifest_invalid',
        'The installed extension manifest',
    );
    const extensionManifest = parseJson(
        await readFileText(
            rootHandle,
            BROWSER_FOLDER_PATHS.extensionManifest,
        ),
        'browser_folder_extension_manifest_invalid',
        'The Mnemosyne extension manifest',
    );
    if (
        codeManifest.version !== extensionManifest.version
        || (
            expectedExtensionVersion
            && codeManifest.version !== expectedExtensionVersion
        )
    ) {
        throw provisioningError(
            'browser_folder_extension_version_mismatch',
            'The selected Mnemosyne clone does not match the running extension.',
        );
    }
    const runtimeManifestBytes = await readFileBytes(
        rootHandle,
        BROWSER_FOLDER_PATHS.runtimeManifest,
    );
    const runtimeManifest = parseJson(
        TEXT_DECODER.decode(runtimeManifestBytes),
        'browser_folder_runtime_manifest_invalid',
        'The bundled runtime manifest',
    );
    if (runtimeManifest.package_version !== codeManifest.version) {
        throw provisioningError(
            'browser_folder_runtime_version_mismatch',
            'The bundled runtime version does not match the installed extension.',
        );
    }
    return Object.freeze({
        packageJson,
        configSource,
        codeManifest,
        runtimeManifest,
        runtimeManifestBytes,
    });
}

async function ensureContentAddressedBackup({
    rootHandle,
    configSource,
    configHash,
}) {
    const path = `${BROWSER_FOLDER_PATHS.installRoot}/backups/`
        + `config.yaml.sha256-${configHash}.bak`;
    try {
        const existing = await readFileBytes(rootHandle, path);
        if (!equalBytes(existing, configSource)) {
            throw provisioningError(
                'browser_folder_config_backup_conflict',
                'An existing content-addressed config backup is corrupt.',
            );
        }
        return Object.freeze({ path, sha256: configHash, reused: true });
    } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
    }
    await writeFileVerified(rootHandle, path, configSource);
    return Object.freeze({ path, sha256: configHash, reused: false });
}

function recoveryGuide(installId) {
    return Object.freeze({
        schema: 'mnemosyne.browser-folder-recovery.v1',
        install_id: installId,
        disposition: 'inspect_before_retry',
        failure_receipt:
            `${BROWSER_FOLDER_PATHS.installRoot}/`
            + `failure-${installId}.json`,
        config_backup_directory:
            `${BROWSER_FOLDER_PATHS.installRoot}/backups`,
        staged_paths: Object.freeze([
            `${BROWSER_FOLDER_PATHS.stub}.staged-${installId}`,
            `${BROWSER_FOLDER_PATHS.binding}.staged-${installId}`,
        ]),
        instructions: Object.freeze([
            'Do not restart SillyTavern while installation is incomplete.',
            'Preserve the failure receipt and content-addressed config backup.',
            'Compare the current config.yaml with its matching backup before restoring it.',
            'Fix the reported permission, space, or concurrent-change cause, then retry from the same settings card.',
        ]),
    });
}

async function bestEffortFailureReceipt({
    rootHandle,
    installId,
    now,
    error,
    recovery,
}) {
    try {
        await writeFileVerified(
            rootHandle,
            `${BROWSER_FOLDER_PATHS.installRoot}/`
            + `failure-${installId}.json`,
            `${JSON.stringify({
                schema: RECEIPT_SCHEMA,
                status: 'failed',
                install_id: installId,
                failed_at: now(),
                reason_code:
                    error?.reasonCode
                    ?? 'browser_folder_install_failed',
                message: error instanceof Error
                    ? error.message
                    : String(error),
                recovery,
            }, null, 2)}\n`,
        );
    } catch {
        // Permission loss or a full disk can also prevent recording failure.
    }
}

export async function provisionBrowserFolder({
    rootHandle,
    hostVersion,
    expectedExtensionVersion,
    runtimeConfig,
    bootstrapSource,
    onPlan = () => {},
    now = () => new Date().toISOString(),
    randomUUID = () => globalThis.crypto.randomUUID(),
}) {
    const installId = randomUUID();
    try {
        if (
            !rootHandle
            || rootHandle.kind !== 'directory'
            || typeof rootHandle.getDirectoryHandle !== 'function'
        ) {
            throw provisioningError(
                'browser_folder_handle_invalid',
                'A SillyTavern directory permission is required.',
            );
        }
        if (
            typeof bootstrapSource !== 'string'
            || !bootstrapSource.includes(BINDING_SCHEMA)
        ) {
            throw provisioningError(
                'browser_folder_bootstrap_invalid',
                'The bundled Mnemosyne bootstrap is invalid.',
            );
        }
        const sealedRuntimeConfig = createBrowserFolderRuntimeConfig({
            upstreamBaseUrl: runtimeConfig?.upstreamBaseUrl,
            upstreamModel: runtimeConfig?.upstreamModel,
            providerContextTokens:
                runtimeConfig?.providerContextTokens,
            providerOutputReserveTokens:
                runtimeConfig?.providerOutputReserveTokens,
        });
        if (
            runtimeConfig?.schema
                !== 'mnemosyne.runtime-config.v1'
            || JSON.stringify(Object.keys(runtimeConfig).sort())
                !== JSON.stringify(
                    Object.keys(sealedRuntimeConfig).sort(),
                )
        ) {
            throw provisioningError(
                'browser_folder_runtime_config_invalid',
                'Runtime configuration must contain only the sealed non-secret fields.',
            );
        }
        const validated = await validateSelectedRoot({
            rootHandle,
            hostVersion,
            expectedExtensionVersion,
        });
        const manifestHash = await sha256Hex(
            validated.runtimeManifestBytes,
        );
        const configHash = await sha256Hex(validated.configSource);
        const binding = Object.freeze({
            schema: BINDING_SCHEMA,
            relative_code_root: BROWSER_FOLDER_PATHS.codeRoot,
            extension_version: validated.codeManifest.version,
            runtime_build_id:
                validated.runtimeManifest.runtime_build_id,
            manifest_hash: manifestHash,
        });
        const bindingSource = `${JSON.stringify(binding, null, 2)}\n`;
        const configNext = rewriteServerPluginConfig(
            validated.configSource,
        );
        const stagingSuffix = `.staged-${installId}`;
        const plan = Object.freeze({
            schema: 'mnemosyne.browser-folder-plan.v1',
            install_id: installId,
            restart_required: true,
            runtime_release_asset: Object.freeze({
                install_on_restart: true,
                archive_sha256:
                    validated.runtimeManifest.archive_sha256,
                archive_bytes:
                    validated.runtimeManifest.archive_bytes,
                file_count:
                    validated.runtimeManifest.files.length,
            }),
            input_hashes: Object.freeze({
                config_sha256: configHash,
                runtime_manifest_sha256: manifestHash,
                runtime_archive_sha256:
                    validated.runtimeManifest.archive_sha256,
            }),
            modified_files: Object.freeze([
                BROWSER_FOLDER_PATHS.stub,
                BROWSER_FOLDER_PATHS.binding,
                BROWSER_FOLDER_PATHS.config,
                BROWSER_FOLDER_PATHS.runtimeConfig,
                `${BROWSER_FOLDER_PATHS.installRoot}/backups/`
                + `config.yaml.sha256-${configHash}.bak`,
                `${BROWSER_FOLDER_PATHS.installRoot}/complete.json`,
            ]),
        });
        await onPlan(plan);
        await writeFileVerified(
            rootHandle,
            `${BROWSER_FOLDER_PATHS.stub}${stagingSuffix}`,
            bootstrapSource,
        );
        await writeFileVerified(
            rootHandle,
            `${BROWSER_FOLDER_PATHS.binding}${stagingSuffix}`,
            bindingSource,
        );
        await writeFileVerified(
            rootHandle,
            BROWSER_FOLDER_PATHS.runtimeConfig,
            `${JSON.stringify(sealedRuntimeConfig, null, 2)}\n`,
        );
        const backup = await ensureContentAddressedBackup({
            rootHandle,
            configSource: validated.configSource,
            configHash,
        });
        const currentConfig = await readFileText(
            rootHandle,
            BROWSER_FOLDER_PATHS.config,
        );
        if (
            await sha256Hex(currentConfig) !== configHash
            || currentConfig !== validated.configSource
        ) {
            throw provisioningError(
                'browser_folder_config_changed_concurrently',
                'config.yaml changed while Mnemosyne was being installed.',
            );
        }
        await writeFileVerified(
            rootHandle,
            BROWSER_FOLDER_PATHS.stub,
            bootstrapSource,
        );
        await writeFileVerified(
            rootHandle,
            BROWSER_FOLDER_PATHS.binding,
            bindingSource,
        );
        await writeFileVerified(
            rootHandle,
            BROWSER_FOLDER_PATHS.config,
            configNext,
        );
        const receipt = Object.freeze({
            schema: RECEIPT_SCHEMA,
            status: 'restart_required',
            install_id: installId,
            completed_at: now(),
            restart_required: true,
            binding,
            backup,
            plan_hash: await sha256Hex(JSON.stringify(plan)),
        });
        await writeFileVerified(
            rootHandle,
            `${BROWSER_FOLDER_PATHS.installRoot}/complete.json`,
            `${JSON.stringify(receipt, null, 2)}\n`,
        );
        await removeFileIfPresent(
            rootHandle,
            `${BROWSER_FOLDER_PATHS.stub}${stagingSuffix}`,
        );
        await removeFileIfPresent(
            rootHandle,
            `${BROWSER_FOLDER_PATHS.binding}${stagingSuffix}`,
        );
        return receipt;
    } catch (error) {
        const recovery = recoveryGuide(installId);
        try {
            Object.defineProperty(error, 'recovery', {
                value: recovery,
                configurable: true,
            });
        } catch {
            // Some browser-native errors are non-extensible; the receipt still
            // carries the same recovery instructions when storage is writable.
        }
        await bestEffortFailureReceipt({
            rootHandle,
            installId,
            now,
            error,
            recovery,
        });
        throw error;
    }
}

export function localRuntimeProxyUrl() {
    return 'http://127.0.0.1:18991/v1';
}
