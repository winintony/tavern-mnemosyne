import {
    characters,
    changeMainAPI,
    eventSource,
    event_types,
    extension_prompts,
    extension_prompt_roles,
    extension_prompt_types,
    getCharacterCardFields,
    main_api,
    saveMetadata,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    this_chid,
} from '/script.js';
import {
    extension_settings,
    getContext,
    saveMetadataDebounced,
} from '/scripts/extensions.js';
import {
    ChatCompletion,
    formatWorldInfo,
    getChatCompletionPreset,
    oai_settings,
    promptManager,
} from '/scripts/openai.js';
import { countTokensOpenAIAsync } from '/scripts/tokenizers.js';
import { hasPendingFileAttachment } from '/scripts/chats.js';
import { getGroupNames } from '/scripts/group-chats.js';
import { persona_description_positions, power_user } from '/scripts/power-user.js';
import { getCharaFilename } from '/scripts/utils.js';
import {
    getRegexedString,
    regex_placement,
} from '/scripts/extensions/regex/engine.js';
import {
    DEFAULT_DEPTH,
    loadWorldInfo,
    selected_world_info,
    world_info,
    world_info_position,
} from '/scripts/world-info.js';

import {
    applyHostMessageTransforms,
    assertGovernedHistoryCheckpoint,
    assertForwardingProbeLease,
    assertStoryRunLease,
    buildGenerationRunScope,
    buildHostAssemblySourceCandidates,
    buildSourcePromptFingerprints,
    buildStaticLoreSources,
    buildWorldInfoDepthRouteOverrides,
    captureGenerationHistoryOrigin,
    captureStoryRunLease,
    claimExtensionRuntime,
    classifyPromptReadyOwnership,
    classifyGovernedHistorySuffix,
    completeDryRunLifecycle,
    createForeignDryFrameCoordinator,
    createGovernedHistoryCheckpoint,
    createHostAssemblyBaseSourceSeal,
    createHostAssemblyBudgetPlan,
    createStoryPromptHistoryBinding,
    createProviderBudgetBinding,
    createForwardingProbeLease,
    createForwardingProbeRequest,
    finalizePromptTrace,
    findUntraceableAbsorbedSources,
    findGovernedHistoryInvalidationCutoff,
    findHostHistoryInvalidationCutoff,
    findMessageEditCutoff,
    findMessageDeletionCutoff,
    forwardingProbeResponsePassed,
    generationTerminalStatus,
    hashHostChatId,
    inspectHostProfile,
    inspectForeignDryPromptFrame,
    inspectPromptRunMarkers,
    mergeCustomIncludeBody,
    normalizeLoopbackProxyBaseUrl,
    normalizeProviderBudgetPolicyHealth,
    parseSavedCharacterCard,
    partitionLegacyTavernDbWorldInfoEntries,
    promptMarkerFailureReason,
    promptMessagesBelongToRun,
    providerInputBudgetFromContext,
    recoverGovernedHistoryCheckpoint,
    sealHostHistoryCoordinateBasis,
    shouldReservePendingUserTurn,
    snapshotHostHistory,
    verifyHostHistoryBinding,
} from './runtime.js';
import {
    assertHistoryInvalidationGuard,
    assertHistoryLifecycleLease,
    consumeGenerationAbortReason,
    createHistoryInvalidationGuard,
    createHistoryInvalidationCoordinator,
    createHistoryLifecycleLease,
    mergeHistoryInvalidationGuard,
    planHistoryInvalidationResolution,
    reconcileHistoryInvalidationGuard,
    requiresFreshChatForUncheckpointedHistory,
} from './history-invalidation-guard.js';
import {
    createHistoryLifecycleDurableStore,
} from './history-lifecycle-durable-store.js';
import {
    resolveProvisioningUpstreamUrl,
} from './provisioning-upstream-url.js';
import {
    createAutoIntakeScheduler,
} from './auto-intake-scheduler.js';
import {
    appendSubjectiveFeedbackNote,
    bindSubjectiveFeedbackNote,
    removeSubjectiveFeedbackNotes,
    SUBJECTIVE_FEEDBACK_NOTE_LIMIT,
} from './subjective-feedback-notes.js';
import {
    buildSourceRemovalRunScope,
    resolveSourceRemovalGrantEvidence,
} from './source-removal-grant-response.js';
import {
    createHostAssemblyLeaseManager,
} from './host-assembly-lease.js';
import {
    buildWorldInfoComponentProvenance,
    hashHostProvenanceContent,
} from './host-provenance-adapter.js';
import {
    createAbsorbedSourceIsolationLease,
    restoreAbsorbedSourceIsolationLease,
} from './source-isolation-lease.js';
import {
    createRealUseFeedbackController,
} from './real-use-feedback-controller.js';
import {
    createRunActivityController,
    runActivityStatusLabel,
} from './run-activity-controller.js';
import {
    createMnemosyneControlClient,
} from './mnemosyne-control-client.js';
import {
    createBrowserFolderRuntimeConfig,
    localRuntimeProxyUrl,
    readInstalledBrowserFolderRuntimeConfig,
} from './browser-folder-provisioning.js';
import {
    createProvisioningOrchestrator,
} from './provisioning-orchestrator.js';
import {
    createBrowserFolderHandleStore,
} from './browser-folder-handle-store.js';
import {
    captureUpstreamConnectionProfile,
    restoreUpstreamConnectionProfile,
} from './connection-profile-protection.js';
import {
    mergeTransportLeaseIntoCustomBody,
} from './root-transport-lease.js';

claimExtensionRuntime(globalThis);

const MODULE_NAME = 'tavern_mnemosyne';
const RUNTIME_KEY = 'tavern_mnemosyne_runtime_contract';
const PAYLOAD_KEY = 'tavern_mnemosyne_continuity_payload';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    proxyBaseUrl: 'http://127.0.0.1:18991',
    sessionToken: '',
    realUseFeedbackEnabled: false,
    provisioningPending: false,
    // The user's real Custom OpenAI endpoint, captured before provisioning
    // rewrites custom_url to the local runtime. Re-provisioning must read
    // this snapshot, never the (possibly loopback) live custom_url.
    upstreamCustomUrl: '',
    upstreamConnectionProfileId: '',
    upstreamConnectionProfileUrl: '',
});

const browserFolderHandleStore = createBrowserFolderHandleStore();

const state = {
    runId: null,
    contextResponse: null,
    promptTrace: null,
    promptTraceInputs: null,
    providerMessages: null,
    worldInfoEntries: [],
    worldInfoComponentProvenance: [],
    hostSourceRoutes: {},
    mainHostBinding: null,
    sourceRemovalAuthorizations: [],
    sourceIsolationLease: null,
    preSquashInternalMessages: null,
    generationHistoryOriginCapture: null,
    blockReason: null,
    dryCheckPending: false,
    generationAbortReason: null,
    exclusiveOperation: null,
    intakePending: false,
    preparedIntake: null,
    lastDryCheck: null,
    generationType: null,
    runScope: null,
    activeRunMarker: null,
    transportLease: null,
    hostAssemblyBudgetLease: null,
    providerBudget: null,
    providerBudgetPolicy: null,
    forwardingProbeLease: null,
    chatSnapshot: [],
    chatSnapshotChatId: null,
    suppressedMessageDeletion: null,
    status: 'Disabled',
};

let hostAssemblyLeaseManager = null;
let hostAssemblyPromptManager = null;
let controlClient = null;
let controlClientKey = null;
const historyInvalidationCoordinator =
    createHistoryInvalidationCoordinator({
        lockManager:
            globalThis.navigator?.locks
            ?? null,
    });
const historyLifecycleDurableStore =
    createHistoryLifecycleDurableStore();

function currentHostAssemblyLeaseManager() {
    if (
        hostAssemblyLeaseManager
        && hostAssemblyPromptManager === promptManager
    ) {
        return hostAssemblyLeaseManager;
    }
    if (state.hostAssemblyBudgetLease !== null) {
        const error = new Error(
            'PromptManager changed while a host assembly frame was active.',
        );
        error.reasonCode = 'host_prompt_budget_service_settings_changed';
        throw error;
    }
    hostAssemblyPromptManager = promptManager;
    hostAssemblyLeaseManager = createHostAssemblyLeaseManager({
        promptManager,
    });
    return hostAssemblyLeaseManager;
}

function settings() {
    extension_settings[MODULE_NAME] ??= {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

function configuredRuntimeProxyUrl() {
    const baseUrl = normalizeLoopbackProxyBaseUrl(
        settings().proxyBaseUrl || DEFAULT_SETTINGS.proxyBaseUrl,
    );
    return `${baseUrl}/v1`;
}

function proxyUrl(pathname) {
    const baseUrl = normalizeLoopbackProxyBaseUrl(
        settings().proxyBaseUrl || DEFAULT_SETTINGS.proxyBaseUrl,
    );
    return `${baseUrl}${pathname}`;
}

function deploymentModeForPage() {
    try {
        return ['127.0.0.1', 'localhost', '::1'].includes(
            globalThis.location?.hostname,
        )
            ? 'local'
            : 'cloud';
    } catch {
        return 'cloud';
    }
}

function currentControlClient() {
    const key = JSON.stringify({
        page: globalThis.location?.origin ?? '',
        deploymentMode: deploymentModeForPage(),
        loopbackBaseUrl:
            settings().proxyBaseUrl || DEFAULT_SETTINGS.proxyBaseUrl,
    });
    if (controlClient && controlClientKey === key) {
        return controlClient;
    }
    controlClientKey = key;
    controlClient = createMnemosyneControlClient({
        pageUrl: globalThis.location?.href,
        deploymentMode: deploymentModeForPage(),
        loopbackBaseUrl:
            settings().proxyBaseUrl || DEFAULT_SETTINGS.proxyBaseUrl,
        getHostAuthContext: () => ({
            headers: getContext().getRequestHeaders(),
            credentials: 'same-origin',
        }),
        getLoopbackHeaders: privateProxyHeaders,
    });
    return controlClient;
}

async function resolveControlLease({
    bindToRootRun = false,
} = {}) {
    if (state.transportLease) return state.transportLease;
    const lease = await currentControlClient().resolveRootTransport();
    if (lease.adapter_id === 'bridge' && settings().sessionToken) {
        settings().sessionToken = '';
        saveSettingsDebounced();
    }
    if (bindToRootRun) state.transportLease = lease;
    return lease;
}

async function invokeControl(methodName, payload, {
    lease = null,
} = {}) {
    const client = currentControlClient();
    const resolvedLease = lease ?? await resolveControlLease();
    return client[methodName](payload, {
        lease: resolvedLease,
    });
}

const STATUS_DISPLAY_TEXT = Object.freeze({
    'Ready': '已就绪',
    'Disabled': '已关闭',
    'Preparing': '准备中…',
    'Checking': '检查中…',
    'Unavailable': '运行时不可用',
    'Dry check passed': '检查通过',
    'Running dry check': '正在运行检查…',
    'Running forwarding check': '正在检查转发…',
    'Preparing intake': '正在准备设定导入…',
    'Checking model deployment': '正在检查模型部署…',
    'Static Lore sources or intake state changed':
        '设定来源已变化，将重新导入。',
    'Blocked: enable Mnemosyne': '请先开启 Mnemosyne。',
    'Blocked: run dry check first': '请先运行一次检查。',
});

const BLOCK_REASON_TEXT = Object.freeze({
    agent_proxy_unavailable: '运行时不可用',
    chat_id_missing: '请先打开一个聊天',
    character_missing: '请先打开角色聊天',
    prompt_trace_missing: '提示词轨迹缺失',
});

// Raw status values stay in state for governance logic and contract
// tests; only the rendered text is localized and stripped of reason
// codes, which belong in the console, not the release UI.
function statusDisplayText(value) {
    const fixed = STATUS_DISPLAY_TEXT[value];
    if (fixed) return fixed;
    const blocked = /^Blocked: (.+)$/.exec(value);
    if (blocked) {
        const reason = BLOCK_REASON_TEXT[blocked[1]];
        if (reason) return `已拦截：${reason}`;
        console.warn('[Mnemosyne] blocked:', blocked[1]);
        return '已拦截：内部检查未通过';
    }
    return value;
}

function updateStatus(value) {
    state.status = value;
    const element = document.querySelector('#tavern_mnemosyne_status');
    if (element) element.textContent = statusDisplayText(value);
}

function claimExclusiveOperation(operation) {
    if (state.exclusiveOperation !== null) {
        updateStatus(
            `Blocked: ${state.exclusiveOperation}_operation_active`,
        );
        return false;
    }
    state.exclusiveOperation = operation;
    return true;
}

function releaseExclusiveOperation(operation) {
    if (state.exclusiveOperation !== operation) return false;
    state.exclusiveOperation = null;
    return true;
}

function blockCurrentGeneration(reasonCode) {
    state.generationAbortReason = reasonCode;
    clearInjections();
    state.runId = null;
    state.blockReason = reasonCode;
    updateStatus(`Blocked: ${reasonCode}`);
}

function restoreHostAssemblyBudgetLease(expectedLease = null) {
    const lease = state.hostAssemblyBudgetLease;
    if (
        !lease
        || (
            expectedLease !== null
            && lease !== expectedLease
        )
    ) {
        return { status: 'stale' };
    }
    const settlement = lease.manager.settleFrame(lease.frame);
    if (state.hostAssemblyBudgetLease === lease) {
        state.hostAssemblyBudgetLease = null;
    }
    return settlement;
}

function clearExtensionPromptSlots() {
    foreignDryFrameCoordinator.reset();
    setExtensionPrompt(RUNTIME_KEY, '', extension_prompt_types.BEFORE_PROMPT, 0);
    setExtensionPrompt(PAYLOAD_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

function extensionPromptSlotValue(key) {
    return String(extension_prompts[key]?.value ?? '');
}

function writeForeignDryPromptSlots(slots) {
    setExtensionPrompt(
        RUNTIME_KEY,
        slots.runtime,
        extension_prompt_types.BEFORE_PROMPT,
        0,
    );
    setExtensionPrompt(
        PAYLOAD_KEY,
        slots.payload,
        extension_prompt_types.IN_PROMPT,
        0,
    );
}

const foreignDryFrameCoordinator =
    createForeignDryFrameCoordinator({
        readPromptSlots: () => ({
            runtime: extensionPromptSlotValue(RUNTIME_KEY),
            payload: extensionPromptSlotValue(PAYLOAD_KEY),
        }),
        writePromptSlots: writeForeignDryPromptSlots,
        createFrameId: () => crypto.randomUUID(),
    });

function beginForeignDryFrame(activeRunMarker) {
    return foreignDryFrameCoordinator.begin(activeRunMarker);
}

function settleForeignDryFrame(frameId, activeRunMarker) {
    return foreignDryFrameCoordinator.settle(
        frameId,
        activeRunMarker,
    );
}

function settleAllForeignDryFrames(activeRunMarker) {
    return foreignDryFrameCoordinator.settleAll(
        activeRunMarker,
    );
}

function foreignDryFrameOwnsPromptSlots() {
    return foreignDryFrameCoordinator.ownsPromptSlots();
}

const realUseFeedbackController =
    createRealUseFeedbackController({
        post: (pathname, payload) =>
            postPrivatePanelRequest(pathname, payload),
        download: bundle =>
            downloadRealUseFeedbackExport(bundle),
        createId: () => crypto.randomUUID(),
        onChange: feedbackState =>
            syncRealUseFeedbackUi(feedbackState),
    });
const runActivityController =
    createRunActivityController({
        post: (pathname, payload) =>
            postPrivatePanelRequest(pathname, payload),
        onChange: activityState =>
            syncRunActivityUi(activityState),
    });
const autoStaticLoreIntakeScheduler =
    createAutoIntakeScheduler({
        isEnabled: () => settings().enabled,
        run: () => autoRunStaticLoreIntake(),
    });

// Floating micro-window state: which verdict/facet is picked before
// submit, and whether the card is collapsed back into the pill.
const feedbackFloatState = {
    collapsed: false,
    caseId: null,
    verdict: null,
    facet: null,
};

function stageSubjectiveFeedbackNote({
    chatId,
    caseId,
    verdict,
    facet,
    text,
}) {
    const context = getContext();
    const metadata = context.chatMetadata;
    const persist =
        context.saveMetadataDebounced ?? context.saveMetadata;
    if (!metadata || typeof persist !== 'function') {
        throw new Error('Chat metadata cannot be saved.');
    }
    const note = appendSubjectiveFeedbackNote(metadata, {
        chatId,
        caseId,
        verdict,
        facet,
        text,
        createId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
    });
    persist();
    return Object.freeze({
        metadata,
        noteId: note.note_id,
        persist,
    });
}

function setFeedbackLocalError(text) {
    const floatStatus = document.querySelector(
        '#tavern_mnemosyne_feedback_float_status',
    );
    if (floatStatus) floatStatus.textContent = text;
    const panelStatus = document.querySelector(
        '#tavern_mnemosyne_feedback_status',
    );
    if (panelStatus) {
        panelStatus.textContent = text;
        panelStatus.dataset.kind = 'error';
    }
}

async function submitRealUseFeedbackFromFloat() {
    const prepared =
        realUseFeedbackController.snapshot().prepared;
    const verdict = feedbackFloatState.verdict;
    if (!prepared || !verdict) return;
    const note = document.querySelector(
        '#tavern_mnemosyne_feedback_note',
    );
    const noteText = note?.value.trim() ?? '';
    const target = {
        chatId: prepared.chatId,
        caseId: prepared.caseId,
        verdict,
        facet: feedbackFloatState.facet,
    };
    let stagedNote = null;
    if (noteText) {
        try {
            stagedNote = stageSubjectiveFeedbackNote({
                ...target,
                text: noteText,
            });
        } catch (error) {
            console.warn(
                '[Mnemosyne] subjective feedback note unavailable:',
                error,
            );
            setFeedbackLocalError(
                '主观备注未能保存，请保留文字并稍后重试。',
            );
            return;
        }
    }
    const result = await realUseFeedbackController.submit({
        quickAnswer: verdict,
        facet: feedbackFloatState.facet,
    });
    if (!result.ok && stagedNote) {
        removeSubjectiveFeedbackNotes(
            stagedNote.metadata,
            { noteId: stagedNote.noteId },
        );
        stagedNote.persist();
    }
    if (result.ok && stagedNote) {
        bindSubjectiveFeedbackNote(
            stagedNote.metadata,
            stagedNote.noteId,
            result.feedback?.feedback_id,
        );
        stagedNote.persist();
    }
    if (result.ok && note) note.value = '';
}

function ensureRealUseFeedbackFloat() {
    let float = document.querySelector(
        '#tavern_mnemosyne_feedback_float',
    );
    if (float) return float;
    float = document.createElement('div');
    float.id = 'tavern_mnemosyne_feedback_float';
    float.className = 'mnemosyne-feedback-float';
    float.hidden = true;
    float.innerHTML = `
        <button
            id="tavern_mnemosyne_feedback_pill"
            class="mnemosyne-feedback-pill"
            type="button"
        >评价这轮回复</button>
        <div
            id="tavern_mnemosyne_feedback_card"
            class="mnemosyne-feedback-card"
            hidden
        >
            <div class="mnemosyne-feedback-card-header">
                <span id="tavern_mnemosyne_feedback_prompt"></span>
                <button
                    id="tavern_mnemosyne_feedback_close"
                    class="mnemosyne-feedback-close"
                    type="button"
                    aria-label="收起"
                >×</button>
            </div>
            <div
                id="tavern_mnemosyne_feedback_answers"
                class="mnemosyne-feedback-answers"
            ></div>
            <div
                id="tavern_mnemosyne_feedback_facets_block"
                class="mnemosyne-feedback-facets-block"
                hidden
            >
                <span
                    id="tavern_mnemosyne_feedback_facet_prompt"
                    class="mnemosyne-feedback-facet-prompt"
                ></span>
                <div
                    id="tavern_mnemosyne_feedback_facets"
                    class="mnemosyne-feedback-facets"
                ></div>
            </div>
            <textarea
                id="tavern_mnemosyne_feedback_note"
                class="mnemosyne-feedback-note"
                rows="2"
                maxlength="${SUBJECTIVE_FEEDBACK_NOTE_LIMIT}"
                placeholder="主观感受（可选，仅保存在本机）"
            ></textarea>
            <div class="mnemosyne-feedback-card-footer">
                <span
                    id="tavern_mnemosyne_feedback_float_status"
                    class="mnemosyne-feedback-float-status"
                ></span>
                <button
                    id="tavern_mnemosyne_feedback_submit"
                    class="menu_button"
                    type="button"
                    disabled
                >提交</button>
            </div>
        </div>`;
    document.body.append(float);
    float.querySelector('#tavern_mnemosyne_feedback_pill')
        ?.addEventListener('click', () => {
            feedbackFloatState.collapsed = false;
            const snapshot = realUseFeedbackController.snapshot();
            if (snapshot.prepared) {
                syncRealUseFeedbackUi();
                return;
            }
            void prepareRecentRealUseFeedback();
        });
    float.querySelector('#tavern_mnemosyne_feedback_close')
        ?.addEventListener('click', () => {
            feedbackFloatState.collapsed = true;
            syncRealUseFeedbackUi();
        });
    float.querySelector('#tavern_mnemosyne_feedback_submit')
        ?.addEventListener('click', () => {
            void submitRealUseFeedbackFromFloat();
        });
    return float;
}

function renderRealUseFeedbackCard(card, prepared) {
    const presentation =
        prepared?.questionnaire?.presentation;
    const prompt = card.querySelector(
        '#tavern_mnemosyne_feedback_prompt',
    );
    const answers = card.querySelector(
        '#tavern_mnemosyne_feedback_answers',
    );
    const facetsBlock = card.querySelector(
        '#tavern_mnemosyne_feedback_facets_block',
    );
    const facetPrompt = card.querySelector(
        '#tavern_mnemosyne_feedback_facet_prompt',
    );
    const facets = card.querySelector(
        '#tavern_mnemosyne_feedback_facets',
    );
    const submit = card.querySelector(
        '#tavern_mnemosyne_feedback_submit',
    );
    if (
        !presentation
        || !prompt
        || !answers
        || !facetsBlock
        || !facetPrompt
        || !facets
        || !submit
    ) {
        return;
    }
    if (feedbackFloatState.caseId !== prepared.caseId) {
        feedbackFloatState.caseId = prepared.caseId;
        feedbackFloatState.verdict = null;
        feedbackFloatState.facet = null;
    }
    card.lang = presentation.language;
    prompt.textContent = presentation.prompt;
    facetPrompt.textContent = presentation.facet_prompt;
    const selectedAnswer = presentation.quick_answers.find(
        quickAnswer =>
            quickAnswer.value === feedbackFloatState.verdict,
    );
    answers.replaceChildren();
    for (const quickAnswer of presentation.quick_answers) {
        const button = document.createElement('button');
        button.className = 'mnemosyne-feedback-choice';
        button.type = 'button';
        button.dataset.feedbackAnswer = quickAnswer.value;
        button.textContent = quickAnswer.label;
        button.classList.toggle(
            'selected',
            quickAnswer.value === feedbackFloatState.verdict,
        );
        button.addEventListener('click', () => {
            feedbackFloatState.verdict = quickAnswer.value;
            if (!quickAnswer.requires_facet) {
                feedbackFloatState.facet = null;
            }
            syncRealUseFeedbackUi();
        });
        answers.append(button);
    }
    const needsFacet = selectedAnswer?.requires_facet === true;
    facetsBlock.hidden = !needsFacet;
    facets.replaceChildren();
    if (needsFacet) {
        for (const facet of presentation.facets) {
            const chip = document.createElement('button');
            chip.className = 'mnemosyne-feedback-choice';
            chip.type = 'button';
            chip.dataset.feedbackFacet = facet.value;
            chip.textContent = facet.label;
            chip.classList.toggle(
                'selected',
                facet.value === feedbackFloatState.facet,
            );
            chip.addEventListener('click', () => {
                feedbackFloatState.facet = facet.value;
                syncRealUseFeedbackUi();
            });
            facets.append(chip);
        }
    }
    submit.disabled = (
        !selectedAnswer
        || (needsFacet && !feedbackFloatState.facet)
    );
}

function syncRealUseFeedbackUi(
    feedbackState =
        realUseFeedbackController.snapshot(),
) {
    try {
        const status = document.querySelector(
            '#tavern_mnemosyne_feedback_status',
        );
        const exportButton = document.querySelector(
            '#tavern_mnemosyne_feedback_export',
        );
        const withdrawButton = document.querySelector(
            '#tavern_mnemosyne_feedback_withdraw',
        );
        if (exportButton) {
            const hasChat = Boolean(getContext().chatId);
            exportButton.hidden = !hasChat;
            exportButton.disabled = !hasChat;
        }
        if (withdrawButton) {
            withdrawButton.hidden =
                feedbackState.lastFeedback === null;
            withdrawButton.disabled =
                feedbackState.lastFeedback === null;
        }
        if (status) {
            status.textContent = feedbackState.status;
            status.dataset.kind = feedbackState.statusKind;
        }
        const float = ensureRealUseFeedbackFloat();
        const pill = float.querySelector(
            '#tavern_mnemosyne_feedback_pill',
        );
        const card = float.querySelector(
            '#tavern_mnemosyne_feedback_card',
        );
        const floatStatus = float.querySelector(
            '#tavern_mnemosyne_feedback_float_status',
        );
        const hasTarget = (
            feedbackState.recentRun !== null
            || feedbackState.prepared !== null
        );
        float.hidden = !feedbackState.enabled || !hasTarget;
        const showCard = (
            !float.hidden
            && feedbackState.prepared !== null
            && !feedbackFloatState.collapsed
        );
        if (pill) pill.hidden = float.hidden || showCard;
        if (card) {
            card.hidden = !showCard;
            if (showCard) {
                renderRealUseFeedbackCard(
                    card,
                    feedbackState.prepared,
                );
            }
        }
        if (floatStatus) {
            floatStatus.textContent =
                feedbackState.statusKind === 'error'
                    ? feedbackState.status
                    : '';
        }
    } catch {
        // Feedback rendering never enters story generation state.
    }
}

function clearRecentGovernedFeedbackRun({
    clearLastFeedback = false,
} = {}) {
    realUseFeedbackController.clearForHistoryMutation({
        clearLastFeedback,
    });
}

function rememberRecentGovernedFeedbackRun({
    chatId,
    runId,
}) {
    realUseFeedbackController.rememberGovernedReply({
        chatId,
        runId,
    });
}

async function postPrivatePanelRequest(pathname, payload) {
    const methodName = {
        '/v1/mnemosyne/activity/inspect':
            'inspectActivity',
        '/v1/mnemosyne/evaluation/prepare':
            'prepareEvaluation',
        '/v1/mnemosyne/evaluation/feedback':
            'submitEvaluationFeedback',
        '/v1/mnemosyne/evaluation/export':
            'exportEvaluation',
    }[pathname];
    if (!methodName) {
        const error = new Error(
            'Private panel operation is not published.',
        );
        error.reasonCode =
            'mnemosyne_private_operation_unpublished';
        throw error;
    }
    return invokeControl(methodName, payload);
}

async function prepareRecentRealUseFeedback() {
    return realUseFeedbackController.prepare();
}

async function withdrawRecentRealUseFeedback() {
    const reference =
        realUseFeedbackController.snapshot().lastFeedback;
    const result = await realUseFeedbackController.withdraw();
    if (!result.ok || !reference) return result;
    try {
        const context = getContext();
        const metadata = context.chatMetadata;
        if (metadata) {
            const removed = removeSubjectiveFeedbackNotes(
                metadata,
                { feedbackId: reference.feedback_id },
            );
            if (removed > 0) {
                const persist =
                    context.saveMetadataDebounced
                    ?? context.saveMetadata;
                if (typeof persist !== 'function') {
                    throw new Error(
                        'Chat metadata cannot be saved.',
                    );
                }
                persist();
            }
        }
    } catch (error) {
        console.warn(
            '[Mnemosyne] subjective feedback withdrawal failed:',
            error,
        );
        setFeedbackLocalError(
            '结构化反馈已撤回，但主观备注删除失败，请稍后重试。',
        );
    }
    return result;
}

function downloadRealUseFeedbackExport(bundle) {
    const blob = new Blob(
        [`${JSON.stringify(bundle, null, 2)}\n`],
        { type: 'application/json' },
    );
    const objectUrl = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = 'mnemosyne-feedback-deidentified.json';
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function exportDeidentifiedRealUseFeedback() {
    return realUseFeedbackController.exportDeidentified({
        chatId: getContext().chatId ?? null,
    });
}

function appendRunActivityLine(container, text) {
    const line = document.createElement('div');
    line.className = 'mnemosyne-activity-line';
    line.textContent = text;
    container.append(line);
}

function renderRunActivityEntries(container, entries) {
    container.replaceChildren();
    for (const entry of entries) {
        const details = document.createElement('details');
        details.className = 'mnemosyne-activity-entry';
        const summary = document.createElement('summary');
        summary.textContent =
            `第 ${entry.coordinate.turn_index + 1} 轮`
            + ` · ${runActivityStatusLabel(entry.status)}`;
        details.append(summary);

        const body = document.createElement('div');
        body.className = 'mnemosyne-activity-entry-body';
        appendRunActivityLine(
            body,
            `检索 ${entry.retrieval.search_calls} 次`
            + ` · 读取 ${entry.retrieval.read_calls} 次`
            + ` · 写回 ${entry.persistence.record_count} 条`
            + ` · 安全检查 ${entry.safeguards.rejected_step_count} 次`,
        );
        details.append(body);
        container.append(details);
    }
}

function syncRunActivityUi(
    activityState = runActivityController.snapshot(),
) {
    try {
        const openButton = document.querySelector(
            '#tavern_mnemosyne_activity_open',
        );
        const refreshButton = document.querySelector(
            '#tavern_mnemosyne_activity_refresh',
        );
        const panel = document.querySelector(
            '#tavern_mnemosyne_activity_panel',
        );
        const status = document.querySelector(
            '#tavern_mnemosyne_activity_status',
        );
        const entries = document.querySelector(
            '#tavern_mnemosyne_activity_entries',
        );
        if (openButton) {
            openButton.textContent = activityState.open
                ? '收起每轮活动'
                : '查看每轮活动';
            openButton.disabled = false;
        }
        if (refreshButton) {
            refreshButton.hidden = !activityState.open;
            refreshButton.disabled = activityState.loading;
        }
        if (panel) panel.hidden = !activityState.open;
        if (status) {
            status.textContent = activityState.status;
            status.dataset.kind = activityState.statusKind;
        }
        if (entries) {
            renderRunActivityEntries(
                entries,
                activityState.entries,
            );
        }
    } catch {
        // Activity rendering never enters story generation state.
    }
}

function clearInjections() {
    restoreHostAssemblyBudgetLease();
    clearExtensionPromptSlots();
    state.contextResponse = null;
    state.promptTrace = null;
    state.promptTraceInputs = null;
    state.providerBudget = null;
    state.providerBudgetPolicy = null;
    state.providerMessages = null;
    state.worldInfoEntries = [];
    state.worldInfoComponentProvenance = [];
    state.hostSourceRoutes = {};
    state.sourceRemovalAuthorizations = [];
    state.sourceIsolationLease = null;
    state.preSquashInternalMessages = null;
    state.generationHistoryOriginCapture = null;
    state.runScope = null;
    state.activeRunMarker = null;
    state.transportLease = null;
    state.forwardingProbeLease = null;
}

function snapshotPromptManagerMessages(messages) {
    return (messages ?? []).map(message => ({
        identifier: message?.identifier ?? null,
        role: message?.role ?? null,
        name: message?.name ?? null,
        content: structuredClone(message?.content ?? null),
    }));
}

function currentHostBinding() {
    const context = getContext();
    const connectionManager = context.extensionSettings?.connectionManager;
    const selectedProfile = connectionManager?.profiles?.find(
        profile => profile.id === connectionManager.selectedProfile,
    );
    return {
        connection_profile_name:
            selectedProfile?.name ?? '<manual>',
        preset_name:
            context.chatCompletionSettings?.preset_settings_openai
            ?? '<unnamed>',
        model: context.getChatCompletionModel?.() ?? '',
    };
}

function currentConnectionManager() {
    return getContext().extensionSettings?.connectionManager ?? null;
}

function protectedConnectionProfileSnapshot() {
    const current = settings();
    if (
        !current.upstreamConnectionProfileId
        || !current.upstreamConnectionProfileUrl
    ) {
        return null;
    }
    return {
        profileId: current.upstreamConnectionProfileId,
        upstreamUrl: current.upstreamConnectionProfileUrl,
    };
}

function captureCurrentUpstreamConnectionProfile(currentUrl) {
    const snapshot = captureUpstreamConnectionProfile({
        connectionManager: currentConnectionManager(),
        currentUrl,
        runtimeUrl: configuredRuntimeProxyUrl(),
    });
    if (!snapshot) return null;
    const current = settings();
    current.upstreamConnectionProfileId = snapshot.profileId;
    current.upstreamConnectionProfileUrl = snapshot.upstreamUrl;
    saveSettingsDebounced();
    return snapshot;
}

function protectUpstreamConnectionProfile() {
    const restored = restoreUpstreamConnectionProfile({
        connectionManager: currentConnectionManager(),
        snapshot: protectedConnectionProfileSnapshot(),
        runtimeUrl: configuredRuntimeProxyUrl(),
    });
    if (restored) saveSettingsDebounced();
    return restored;
}

function installPreSquashCapture() {
    const marker = Symbol.for('tavern-mnemosyne.pre-squash-capture.v1');
    globalThis.TavernMnemosyneCaptureBeforeSquash = messages => {
        if (!settings().enabled || !state.runId) return;
        state.preSquashInternalMessages =
            snapshotPromptManagerMessages(messages);
    };
    if (ChatCompletion.prototype[marker]) return;

    const original = ChatCompletion.prototype.squashSystemMessages;
    Object.defineProperty(ChatCompletion.prototype, marker, {
        value: true,
    });
    ChatCompletion.prototype.squashSystemMessages = async function (...args) {
        globalThis.TavernMnemosyneCaptureBeforeSquash?.(
            this.messages?.flatten?.() ?? [],
        );
        return original.apply(this, args);
    };
}

function inspectCurrentHostProfile() {
    const preset = getChatCompletionPreset();
    const binding = currentHostBinding();
    return inspectHostProfile({
        mainApi: main_api,
        chatCompletionSource: preset.chat_completion_source,
        customUrl: preset.custom_url,
        proxyBaseUrl: settings().proxyBaseUrl,
        squashSystemMessages: preset.squash_system_messages,
        customPromptPostProcessing: preset.custom_prompt_post_processing,
        connectionProfileName: binding.connection_profile_name,
        presetName: binding.preset_name,
        model: binding.model,
        expectedHostBinding: state.mainHostBinding,
    });
}

async function loadProxyHealth() {
    const lease = await resolveControlLease({
        bindToRootRun: Boolean(state.runId),
    });
    const capabilities =
        currentControlClient().capabilitiesForLease(lease);
    const body = {
        status: 'ok',
        main_host_binding:
            capabilities.main_host_binding ?? null,
        provider_budget_policy:
            capabilities.provider_budget_policy ?? null,
    };
    if (body.status !== 'ok') {
        throw new Error('Agent Proxy is unavailable.');
    }
    const providerBudgetPolicy =
        await normalizeProviderBudgetPolicyHealth(
            body.provider_budget_policy,
        );
    state.mainHostBinding = body.main_host_binding ?? null;
    state.providerBudgetPolicy = providerBudgetPolicy;
    return body;
}

function safeProxyBaseUrl() {
    try {
        return normalizeLoopbackProxyBaseUrl(settings().proxyBaseUrl);
    } catch {
        return DEFAULT_SETTINGS.proxyBaseUrl;
    }
}

function blockChatCompletionRequest(generateData, reasonCode) {
    generateData.chat_completion_source = 'custom';
    generateData.custom_url = `${safeProxyBaseUrl()}/v1`;
    generateData.custom_include_body = JSON.stringify({
        mnemosyne_prompt_trace: {
            schema: 'mnemosyne.blocked.v1',
            run_id: state.runId,
            reason_code: reasonCode,
        },
    });
    generateData.custom_exclude_body = '';
    generateData.custom_include_headers = '';
    generateData.custom_prompt_post_processing = '';
    generateData.stream = false;
    updateStatus(`Blocked: ${reasonCode}`);
}

function runtimeBlock(runId, content) {
    return [
        `<mnemosyne-runtime-contract data-run-id="${runId}" schema="mnemosyne.runtime-contract.v1">`,
        content,
        '</mnemosyne-runtime-contract>',
    ].join('\n');
}

function payloadBlock(runId, payload) {
    return [
        `<mnemosyne-continuity-payload data-run-id="${runId}" schema="${payload.schema}">`,
        JSON.stringify(payload, null, 2),
        '</mnemosyne-continuity-payload>',
    ].join('\n');
}

function activeSwipeId(chat) {
    const lastAssistant = [...chat].reverse().find(message => !message?.is_user);
    return Number.isInteger(lastAssistant?.swipe_id) ? lastAssistant.swipe_id : null;
}

function historyLifecycleContext(expectedChatId = null) {
    const context = getContext();
    if (expectedChatId !== null) {
        assertHistoryLifecycleLease(
            createHistoryLifecycleLease(
                expectedChatId,
            ),
            context.chatId,
        );
    }
    return context;
}

function currentHistoryDurableState(expectedChatId = null) {
    const context =
        historyLifecycleContext(expectedChatId);
    if (!context.chatId) {
        return {
            schema:
                'mnemosyne.history-lifecycle-durable-state.v1',
            guard: null,
            checkpoint: null,
        };
    }
    return historyLifecycleDurableStore.reconcile(
        context.chatId,
        {
            guard:
                context.chatMetadata
                    ?.mnemosyne
                    ?.pending_history_edit
                ?? null,
            checkpoint:
                context.chatMetadata
                    ?.mnemosyne
                    ?.governed_history_checkpoint
                ?? null,
        },
    );
}

function currentBranchEpoch(expectedChatId = null) {
    const context =
        historyLifecycleContext(expectedChatId);
    const durable =
        currentHistoryDurableState(context.chatId);
    if (durable.guard) {
        const guard =
            assertHistoryInvalidationGuard(
                durable.guard,
            );
        if (Number.isInteger(guard.branch_epoch)) {
            return guard.branch_epoch;
        }
        if (
            Number.isInteger(
                guard.active_command
                    ?.expected_branch_epoch,
            )
        ) {
            return guard.active_command
                .expected_branch_epoch;
        }
    }
    const branchEpoch = context.chatMetadata?.mnemosyne?.branch_epoch;
    return Number.isInteger(branchEpoch) ? branchEpoch : 0;
}

async function verifiedHistoryBranchEpoch(
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const guard =
        await currentPendingHistoryEdit(
            context.chatId,
        );
    if (guard) {
        return guard.branch_epoch
            ?? guard.active_command.expected_branch_epoch;
    }
    const checkpoint =
        await currentGovernedHistoryCheckpoint(
            context.chatId,
        );
    if (checkpoint) {
        const verified =
            await assertGovernedHistoryCheckpoint(
                checkpoint,
                { chatId: context.chatId },
            );
        historyLifecycleContext(context.chatId);
        context.chatMetadata ??= {};
        context.chatMetadata.mnemosyne ??= {};
        context.chatMetadata.mnemosyne.branch_epoch =
            verified.branch_epoch;
        return verified.branch_epoch;
    }
    return currentBranchEpoch(context.chatId);
}

function refreshChatSnapshot() {
    const context = getContext();
    const chat = context.chat;
    state.chatSnapshot = snapshotHostHistory(chat);
    state.chatSnapshotChatId = context.chatId ?? null;
    return state.chatSnapshot;
}

function persistBranchEpoch(
    branchEpoch,
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    context.chatMetadata ??= {};
    context.chatMetadata.mnemosyne ??= {};
    context.chatMetadata.mnemosyne.branch_epoch = branchEpoch;
    saveMetadataDebounced();
}

async function currentPendingHistoryEdit(
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const pending =
        currentHistoryDurableState(context.chatId).guard;
    if (pending === undefined || pending === null) return null;
    const guard = assertHistoryInvalidationGuard(pending);
    if (
        guard.chat_id_hash
        !== await hashHostChatId(context.chatId)
    ) {
        const error = new Error(
            'The persisted history edit guard belongs to another chat.',
        );
        error.reasonCode = 'history_edit_guard_chat_mismatch';
        throw error;
    }
    historyLifecycleContext(context.chatId);
    return guard;
}

async function persistPendingHistoryEdit(
    pendingEdit,
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const durable =
        currentHistoryDurableState(context.chatId);
    historyLifecycleDurableStore.write(
        context.chatId,
        {
            guard: structuredClone(pendingEdit),
            checkpoint: durable.checkpoint,
        },
    );
    context.chatMetadata ??= {};
    context.chatMetadata.mnemosyne ??= {};
    context.chatMetadata.mnemosyne.pending_history_edit =
        structuredClone(pendingEdit);
    await saveMetadata();
    historyLifecycleContext(context.chatId);
}

async function clearPendingHistoryEdit() {
    const context = historyLifecycleContext();
    const mnemosyne = context.chatMetadata?.mnemosyne;
    const durable =
        currentHistoryDurableState(context.chatId);
    if (!durable.guard && !mnemosyne?.pending_history_edit) {
        return false;
    }
    historyLifecycleDurableStore.write(
        context.chatId,
        {
            guard: null,
            checkpoint: durable.checkpoint,
        },
    );
    delete mnemosyne.pending_history_edit;
    await saveMetadata();
    historyLifecycleContext(context.chatId);
    return true;
}

async function currentGovernedHistoryCheckpoint(
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const checkpoint =
        currentHistoryDurableState(
            context.chatId,
        ).checkpoint;
    if (checkpoint === undefined || checkpoint === null) {
        return null;
    }
    const verified =
        await assertGovernedHistoryCheckpoint(
            checkpoint,
            { chatId: context.chatId },
        );
    historyLifecycleContext(context.chatId);
    return verified;
}

async function persistGovernedHistoryCheckpoint(
    hostHistorySnapshot,
    {
        branchEpoch = null,
        expectedChatId = null,
    } = {},
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const checkpoint =
        await createGovernedHistoryCheckpoint({
            chatId: context.chatId,
            hostHistorySnapshot,
            branchEpoch:
                branchEpoch
                ?? await verifiedHistoryBranchEpoch(
                    context.chatId,
                ),
        });
    historyLifecycleContext(context.chatId);
    const durable =
        currentHistoryDurableState(context.chatId);
    historyLifecycleDurableStore.write(
        context.chatId,
        {
            guard: durable.guard,
            checkpoint,
        },
    );
    context.chatMetadata ??= {};
    context.chatMetadata.mnemosyne ??= {};
    context.chatMetadata.mnemosyne.governed_history_checkpoint =
        checkpoint;
    await saveMetadata();
    historyLifecycleContext(context.chatId);
    return checkpoint;
}

function historyInvalidationCommandId(cutoffTurnIndex) {
    return (
        `history-invalidation-${cutoffTurnIndex}-`
        + crypto.randomUUID()
    );
}

async function ensurePendingHistoryInvalidation({
    cutoffTurnIndex,
    hostReleaseLength,
    hostHistoryLength,
    reasonCode,
    expectedChatId = null,
}) {
    const context =
        historyLifecycleContext(expectedChatId);
    const current =
        await currentPendingHistoryEdit(
            context.chatId,
        );
    if (!current) {
        const chatIdHash =
            await hashHostChatId(context.chatId);
        historyLifecycleContext(context.chatId);
        const created = createHistoryInvalidationGuard({
            chatIdHash,
            cutoffTurnIndex,
            hostReleaseLength,
            hostHistoryLength,
            branchEpoch:
                await verifiedHistoryBranchEpoch(
                    context.chatId,
                ),
            reasonCode,
            commandId:
                historyInvalidationCommandId(
                    cutoffTurnIndex,
                ),
        });
        await persistPendingHistoryEdit(
            created,
            context.chatId,
        );
        return created;
    }
    const merged = mergeHistoryInvalidationGuard(
        current,
        {
            cutoffTurnIndex,
            hostReleaseLength,
            hostHistoryLength,
            reasonCode,
            commandId:
                historyInvalidationCommandId(
                    cutoffTurnIndex,
                ),
        },
    );
    if (merged.changed) {
        await persistPendingHistoryEdit(
            merged.guard,
            context.chatId,
        );
    }
    return merged.guard;
}

function buildCurrentRunScope({
    generationType = state.generationType ?? 'normal',
    pendingUserTurn = false,
    nestedGeneration = false,
} = {}) {
    const context = getContext();
    const chatLength = Array.isArray(context.chat) ? context.chat.length : 0;
    const lastMessage = chatLength > 0
        ? context.chat.at(-1)
        : null;
    return buildGenerationRunScope({
        chatId: context.chatId,
        branchEpoch: currentBranchEpoch(),
        chatLength,
        generationType,
        activeSwipeId: Array.isArray(context.chat)
            ? activeSwipeId(context.chat)
            : null,
        pendingUserTurn,
        nestedGeneration,
        lastMessageRole: lastMessage
            ? (
                lastMessage.is_system
                    ? 'system'
                    : lastMessage.is_user
                        ? 'user'
                        : 'assistant'
            )
            : null,
    });
}

function claimSettingsReadyFinalizerOrder() {
    if (typeof eventSource.makeLast === 'function') {
        eventSource.makeLast(
            event_types.CHAT_COMPLETION_SETTINGS_READY,
            onSettingsReady,
        );
    }
}

function settingsReadyFinalizerIsLast() {
    const listeners =
        eventSource?.events?.[
            event_types.CHAT_COMPLETION_SETTINGS_READY
        ];
    return (
        Array.isArray(listeners)
        && listeners.at(-1) === onSettingsReady
    );
}

function chatRef() {
    return state.runScope
        ? structuredClone(state.runScope)
        : buildCurrentRunScope();
}

async function postHistoryEvent(pathname, payload) {
    const methodName = {
        '/v1/mnemosyne/history/inspect':
            'inspectHistory',
        '/v1/mnemosyne/history/truncate':
            'truncateHistory',
        '/v1/mnemosyne/history/activate-swipe':
            'activateSwipe',
        '/v1/mnemosyne/history/delete-swipe':
            'deleteSwipe',
    }[pathname];
    if (!methodName) {
        const error = new Error(
            'The history operation is not registered.',
        );
        error.reasonCode = 'history_lifecycle_operation_unknown';
        throw error;
    }
    return invokeControl(methodName, payload);
}

async function inspectProxyGovernedHistory(
    expectedChatId,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const result = await postHistoryEvent(
        '/v1/mnemosyne/history/inspect',
        {
            chat_id: context.chatId,
            branch_id: 'main',
        },
    );
    historyLifecycleContext(context.chatId);
    if (
        result?.schema
            !== 'mnemosyne.governed-history-inspection.v1'
        || result.status !== 'ready'
        || result.chat_id !== context.chatId
        || result.branch_id !== 'main'
        || typeof result.has_governed_history !== 'boolean'
        || !Number.isInteger(result.committed_turn_count)
        || result.committed_turn_count < 0
        || !(
            result.active_branch_epoch === null
            || (
                Number.isInteger(
                    result.active_branch_epoch,
                )
                && result.active_branch_epoch >= 0
            )
        )
        || result.has_governed_history
            !== (
                result.committed_turn_count > 0
                || result.active_branch_epoch !== null
            )
        || !(
            result.recovery_anchor === undefined
            || result.recovery_anchor === null
            || (
                typeof result.recovery_anchor === 'object'
                && !Array.isArray(
                    result.recovery_anchor,
                )
            )
        )
    ) {
        const error = new Error(
            'The history service returned an invalid governance inspection.',
        );
        error.reasonCode =
            'history_inspection_invalid';
        throw error;
    }
    return result;
}

async function truncateHostHistory({
    cutoffTurnIndex,
    reasonCode,
    commandId = `history-${crypto.randomUUID()}`,
    expectedBranchEpoch = null,
    expectedChatId = null,
}) {
    const context =
        historyLifecycleContext(expectedChatId);
    const ownerChatId = context.chatId;
    const resolvedBranchEpoch =
        expectedBranchEpoch
        ?? await verifiedHistoryBranchEpoch(ownerChatId);
    if (
        !ownerChatId
        || !Number.isInteger(cutoffTurnIndex)
        || cutoffTurnIndex < 0
        || !Number.isInteger(resolvedBranchEpoch)
        || resolvedBranchEpoch < 0
    ) {
        const error = new Error('The host truncation coordinate is invalid.');
        error.reasonCode = 'history_truncation_coordinate_invalid';
        throw error;
    }
    const result = await postHistoryEvent(
        '/v1/mnemosyne/history/truncate',
        {
            command_id: commandId,
            chat_id: ownerChatId,
            branch_id: 'main',
            expected_branch_epoch: resolvedBranchEpoch,
            cutoff_turn_index: cutoffTurnIndex,
            reason_code: reasonCode,
        },
    );
    if (
        !Number.isInteger(result?.new_branch_epoch)
        || result.new_branch_epoch < 0
    ) {
        const error = new Error('The history service returned no new branch epoch.');
        error.reasonCode = 'history_branch_epoch_missing';
        throw error;
    }
    historyLifecycleContext(ownerChatId);
    persistBranchEpoch(
        result.new_branch_epoch,
        ownerChatId,
    );
    return result;
}

function reportHistoryLifecycleFailure(
    error,
    expectedChatId = null,
) {
    if (
        expectedChatId !== null
        && getContext().chatId !== expectedChatId
    ) {
        return;
    }
    state.blockReason =
        error?.reasonCode
        ?? 'history_lifecycle_failed';
    updateStatus(`Blocked: ${state.blockReason}`);
}

async function reconcilePendingHistoryEdit(
    pendingEdit,
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    return reconcileHistoryInvalidationGuard(
        pendingEdit,
        {
            truncate: command => truncateHostHistory({
                cutoffTurnIndex:
                    command.cutoff_turn_index,
                reasonCode: command.reason_code,
                commandId: command.command_id,
                expectedBranchEpoch:
                    command.expected_branch_epoch,
                expectedChatId: context.chatId,
            }),
            persist: guard => persistPendingHistoryEdit(
                guard,
                context.chatId,
            ),
            createCommandId:
                historyInvalidationCommandId,
        },
    );
}

function hostReleaseLengthForInvalidation(
    cutoffTurnIndex,
    currentSnapshot,
) {
    if (cutoffTurnIndex >= currentSnapshot.length) {
        return cutoffTurnIndex;
    }
    const message = getContext().chat?.[cutoffTurnIndex];
    return message?.is_user || message?.is_system
        ? cutoffTurnIndex + 1
        : cutoffTurnIndex;
}

function currentCardGreetings() {
    const character = characters[this_chid];
    return [
        character?.first_mes ?? '',
        ...(Array.isArray(
            character?.data?.alternate_greetings,
        )
            ? character.data.alternate_greetings
            : []),
    ]
        .map(value => getRegexedString(
            String(value ?? ''),
            regex_placement.AI_OUTPUT,
        ));
}

async function persistRecoveredHistoryCheckpoint(
    context,
    checkpoint,
) {
    historyLifecycleContext(context.chatId);
    const durable =
        currentHistoryDurableState(
            context.chatId,
        );
    historyLifecycleDurableStore.write(
        context.chatId,
        {
            guard: durable.guard,
            checkpoint,
        },
    );
    context.chatMetadata ??= {};
    context.chatMetadata.mnemosyne ??= {};
    context.chatMetadata.mnemosyne
        .governed_history_checkpoint =
            checkpoint;
    await saveMetadata();
    historyLifecycleContext(context.chatId);
}

async function recoverProxyHistoryCheckpoint(
    context,
    serverHistory,
) {
    const checkpoint =
        await recoverGovernedHistoryCheckpoint({
            inspection: serverHistory,
            chatId: context.chatId,
            currentChat: context.chat,
            cardGreetings:
                currentCardGreetings(),
        });
    await persistRecoveredHistoryCheckpoint(
        context,
        checkpoint,
    );
    return checkpoint;
}

async function detectUnobservedHistoryInvalidation(
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    if (!context.chatId) return null;
    const currentSnapshot = snapshotHostHistory(context.chat);
    const cutoffs = [];
    let referenceHistoryLength = currentSnapshot.length;
    let structuralDeletion = false;
    let checkpoint =
        await currentGovernedHistoryCheckpoint(
            context.chatId,
        );
    let serverHistory = checkpoint === null
        ? await inspectProxyGovernedHistory(
            context.chatId,
        )
        : null;
    if (
        checkpoint === null
        && serverHistory.recovery_anchor
    ) {
        checkpoint =
            await recoverProxyHistoryCheckpoint(
                context,
                serverHistory,
            );
    }
    if (checkpoint) {
        let checkpointCutoff =
            await findGovernedHistoryInvalidationCutoff({
                checkpoint,
                chatId: context.chatId,
                currentHostHistorySnapshot:
                    currentSnapshot,
            });
        historyLifecycleContext(context.chatId);
        if (checkpointCutoff !== null) {
            serverHistory ??=
                await inspectProxyGovernedHistory(
                    context.chatId,
                );
            if (serverHistory.recovery_anchor) {
                try {
                    checkpoint =
                        await recoverProxyHistoryCheckpoint(
                            context,
                            serverHistory,
                        );
                    checkpointCutoff =
                        await findGovernedHistoryInvalidationCutoff({
                            checkpoint,
                            chatId:
                                context.chatId,
                            currentHostHistorySnapshot:
                                currentSnapshot,
                        });
                    historyLifecycleContext(
                        context.chatId,
                    );
                } catch (error) {
                    const reasonCode = String(
                        error?.reasonCode ?? '',
                    );
                    if (
                        reasonCode
                            !== 'history_checkpoint_invalid'
                        && !reasonCode.startsWith(
                            'history_recovery_',
                        )
                    ) {
                        throw error;
                    }
                }
            }
        }
        if (checkpointCutoff !== null) {
            cutoffs.push(checkpointCutoff);
        }
        const suffix = classifyGovernedHistorySuffix({
            governedMessageCount:
                checkpoint.message_count,
            currentChat: context.chat,
        });
        if (suffix.status === 'structural_deletion') {
            structuralDeletion = true;
        }
        if (
            suffix.status
            === 'ungoverned_assistant_append'
        ) {
            cutoffs.push(suffix.cutoff_turn_index);
            structuralDeletion = true;
        }
        referenceHistoryLength = Math.max(
            referenceHistoryLength,
            checkpoint.message_count,
        );
        context.chatMetadata ??= {};
        context.chatMetadata.mnemosyne ??= {};
        context.chatMetadata.mnemosyne.branch_epoch =
            checkpoint.branch_epoch;
    } else if (requiresFreshChatForUncheckpointedHistory({
        currentMessageCount: currentSnapshot.length,
        hasCheckpoint: false,
        hasBranchEpochMarker: Object.hasOwn(
            context.chatMetadata?.mnemosyne ?? {},
            'branch_epoch',
        ),
        serverHasGovernedHistory:
            serverHistory.has_governed_history,
    })) {
        const error = new Error(
            'This chat contains governed history but has no durable history checkpoint, so it cannot be resumed safely. Start a fresh chat with the same character card; automatic legacy migration is not available yet.',
        );
        error.reasonCode =
            'legacy_governed_chat_requires_new_chat';
        throw error;
    }
    if (
        state.chatSnapshotChatId === context.chatId
        && Array.isArray(state.chatSnapshot)
    ) {
        const memoryCutoff =
            findHostHistoryInvalidationCutoff(
                state.chatSnapshot,
                currentSnapshot,
            );
        if (memoryCutoff !== null) {
            cutoffs.push(memoryCutoff);
        }
        if (
            currentSnapshot.length
            < state.chatSnapshot.length
        ) {
            structuralDeletion = true;
        }
        referenceHistoryLength = Math.max(
            referenceHistoryLength,
            state.chatSnapshot.length,
        );
    }
    if (cutoffs.length === 0) return null;

    const cutoffTurnIndex = Math.min(...cutoffs);
    const guard = await ensurePendingHistoryInvalidation({
        cutoffTurnIndex,
        hostReleaseLength:
            structuralDeletion
                ? cutoffTurnIndex
                : hostReleaseLengthForInvalidation(
                    cutoffTurnIndex,
                    currentSnapshot,
                ),
        hostHistoryLength: Math.max(
            referenceHistoryLength,
            cutoffTurnIndex + 1,
        ),
        reasonCode: structuralDeletion
            || cutoffTurnIndex >= currentSnapshot.length
            ? 'host_message_deleted'
            : 'host_message_edited',
        expectedChatId: context.chatId,
    });
    state.chatSnapshot = currentSnapshot;
    state.chatSnapshotChatId = context.chatId;
    return guard;
}

async function resolvePendingHistoryEditBeforeGeneration(
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    await detectUnobservedHistoryInvalidation(
        context.chatId,
    );
    let pendingEdit =
        await currentPendingHistoryEdit(
            context.chatId,
        );
    if (!pendingEdit) return null;
    if (!historyLifecycleIsActive()) {
        return 'history_edit_reconciliation_deferred';
    }
    for (let attempt = 0; attempt < 128; attempt += 1) {
        const chatLength = Array.isArray(getContext().chat)
            ? getContext().chat.length
            : 0;
        const resolution =
            planHistoryInvalidationResolution(
                pendingEdit,
                { chatLength },
            );
        if (resolution.action === 'lower_then_reconcile') {
            pendingEdit =
                await ensurePendingHistoryInvalidation({
                    cutoffTurnIndex:
                        resolution.cutoff_turn_index,
                    hostReleaseLength:
                        resolution.host_release_length,
                    hostHistoryLength: Math.max(
                        pendingEdit.host_history_length,
                        resolution.cutoff_turn_index + 1,
                    ),
                    reasonCode:
                        resolution.reason_code,
                    expectedChatId: context.chatId,
                });
            pendingEdit =
                await reconcilePendingHistoryEdit(
                    pendingEdit,
                    context.chatId,
                );
            continue;
        }
        if (resolution.action === 'reconcile_then_recheck') {
            pendingEdit =
                await reconcilePendingHistoryEdit(
                    pendingEdit,
                    context.chatId,
                );
            continue;
        }
        if (resolution.action === 'clear') {
            const governedPrefix =
                snapshotHostHistory(
                    getContext().chat,
                ).slice(
                    0,
                    pendingEdit
                        .desired_host_release_length,
                );
            await settlePendingHistoryInvalidation(
                governedPrefix,
                pendingEdit.branch_epoch,
                context.chatId,
            );
            refreshChatSnapshot();
            return null;
        }
        return resolution.reason_code;
    }
    return 'history_edit_reconciliation_limit_exceeded';
}

async function loadContext(runId) {
    const context = getContext();
    if (!context.chatId) {
        throw new Error('Mnemosyne requires an active SillyTavern chat.');
    }
    const budgetLease = state.hostAssemblyBudgetLease;
    if (!budgetLease || budgetLease.runId !== runId) {
        const error = new Error(
            'The host assembly budget lease is unavailable.',
        );
        error.reasonCode = 'host_prompt_budget_invalid';
        throw error;
    }
    const providerInputTokens = providerInputBudgetFromContext({
        contextTokens: budgetLease.configuredContextTokens,
        outputReserveTokens: budgetLease.outputReserveTokens,
    });

    const body = await invokeControl('readContext', {
        chat_id: context.chatId,
        run_scope: {
            ...chatRef(),
            active_candidate_id: `run:${runId}`,
        },
        available_input_tokens: providerInputTokens,
    }, {
        lease: state.transportLease,
    });
    if (body.status !== 'ready') {
        const error = new Error(`Mnemosyne context unavailable: ${body.reason_code ?? 'unknown'}.`);
        error.reasonCode = body.reason_code ?? 'context_unavailable';
        throw error;
    }

    if (!body.runtime_contract || !body.continuity_payload) {
        throw new Error('Mnemosyne context response is incomplete.');
    }

    state.contextResponse = body;
    setExtensionPrompt(
        RUNTIME_KEY,
        runtimeBlock(runId, body.runtime_contract),
        extension_prompt_types.BEFORE_PROMPT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
    setExtensionPrompt(
        PAYLOAD_KEY,
        payloadBlock(runId, body.continuity_payload),
        extension_prompt_types.IN_PROMPT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function privateProxyHeaders() {
    const token = String(settings().sessionToken || '').trim();
    if (!token) {
        const error = new Error('Mnemosyne session token is required.');
        error.reasonCode = 'context_session_token_missing';
        throw error;
    }
    return {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-mnemosyne-session-token': token,
    };
}

function currentStoryRunLeaseState() {
    const context = getContext();
    return {
        chatId: context.chatId,
        runId: state.runId,
        activeRunMarker: state.activeRunMarker,
        contextResponse: state.contextResponse,
    };
}

function assertCurrentStoryRunLease(runLease) {
    return assertStoryRunLease(
        runLease,
        currentStoryRunLeaseState(),
    );
}

function assertCurrentSourceRemovalRunScope(expectedScope, runLease) {
    assertCurrentStoryRunLease(runLease);
    const currentScope = buildSourceRemovalRunScope({
        chatId: runLease.chatId,
        runId: runLease.runId,
        hostRunScope: state.runScope,
    });
    if (
        currentScope.chat_id !== expectedScope.chat_id
        || currentScope.run_id !== expectedScope.run_id
        || currentScope.branch_id !== expectedScope.branch_id
        || currentScope.branch_epoch !== expectedScope.branch_epoch
        || currentScope.turn_index !== expectedScope.turn_index
    ) {
        const error = new Error(
            'Story run scope changed while source removal was being authorized.',
        );
        error.reasonCode = 'source_removal_run_scope_drift';
        throw error;
    }
    return true;
}

async function collectCurrentAuthorSources({ runLease = null } = {}) {
    if (runLease) assertCurrentStoryRunLease(runLease);
    const context = getContext();
    const activeCharacter = context.characters?.[context.characterId];
    if (!activeCharacter) {
        throw new Error('Mnemosyne requires an active character.');
    }
    const characterFileName = getCharaFilename(context.characterId);
    const extraBooks = world_info.charLore?.find(
        item => item.name === characterFileName,
    )?.extraBooks ?? [];
    const authorContext = Object.freeze({
        activeCharacterAvatar: activeCharacter.avatar,
        requestHeaders: Object.freeze({
            ...context.getRequestHeaders(),
        }),
        selectedWorldNames: Object.freeze([
            ...(selected_world_info ?? []),
        ]),
        extraBooks: Object.freeze([...extraBooks]),
        chatWorld: context.chatMetadata?.world_info ?? null,
        chatScenario: context.chatMetadata?.scenario ?? '',
        personaWorld:
            power_user.persona_description_lorebook
            ?? null,
        personaName: context.name1 ?? '',
        personaDescription:
            power_user.persona_description
            ?? '',
    });
    const characterResponse = await fetch('/api/characters/get', {
        method: 'POST',
        headers: authorContext.requestHeaders,
        cache: 'no-cache',
        body: JSON.stringify({
            avatar_url: authorContext.activeCharacterAvatar,
        }),
    });
    if (runLease) assertCurrentStoryRunLease(runLease);
    if (!characterResponse.ok) {
        const error = new Error('The saved character card could not be loaded.');
        error.reasonCode = 'active_character_card_unavailable';
        throw error;
    }
    const character = await characterResponse.json();
    if (runLease) assertCurrentStoryRunLease(runLease);
    const worldNames = new Set(authorContext.selectedWorldNames);
    const primaryWorld = character.data?.extensions?.world;
    if (primaryWorld) worldNames.add(primaryWorld);
    for (const worldName of authorContext.extraBooks) {
        worldNames.add(worldName);
    }
    if (authorContext.chatWorld) worldNames.add(authorContext.chatWorld);
    if (authorContext.personaWorld) {
        worldNames.add(authorContext.personaWorld);
    }

    const worldbooks = [];
    for (const name of [...worldNames].sort((left, right) => (
        String(left).localeCompare(String(right))
    ))) {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: authorContext.requestHeaders,
            cache: 'no-cache',
            body: JSON.stringify({ name }),
        });
        if (runLease) assertCurrentStoryRunLease(runLease);
        if (!response.ok) {
            const error = new Error(`Active worldbook could not be loaded: ${name}`);
            error.reasonCode = 'active_worldbook_unavailable';
            throw error;
        }
        const data = await response.json();
        if (runLease) assertCurrentStoryRunLease(runLease);
        worldbooks.push({ name, data });
    }
    const activeScenario =
        authorContext.chatScenario
        || character.scenario
        || '';
    return buildStaticLoreSources({
        characterCard: parseSavedCharacterCard(character),
        worldbooks,
        persona: {
            name: authorContext.personaName,
            description: authorContext.personaDescription,
        },
        scenario: { content: activeScenario },
    });
}

async function issueSourceRemovalGrants(
    internalMessages,
    sourceRouteOverrides,
    componentProvenance,
    runLease,
) {
    const runScope = buildSourceRemovalRunScope({
        chatId: runLease.chatId,
        runId: runLease.runId,
        hostRunScope: state.runScope,
    });
    assertCurrentSourceRemovalRunScope(runScope, runLease);
    const absorbedSourceKinds = Object.freeze([
        ...(runLease.contextResponse.absorbed_source_kinds ?? []),
    ]);
    const sources = await collectCurrentAuthorSources({ runLease });
    assertCurrentSourceRemovalRunScope(runScope, runLease);
    const promptFingerprints = await buildSourcePromptFingerprints({
        internalMessages,
        absorbedSourceKinds,
        sourceRouteOverrides,
        componentProvenance,
    });
    assertCurrentSourceRemovalRunScope(runScope, runLease);
    const body = await invokeControl(
        'requestSourceRemovalGrants',
        {
            chat_id: runLease.chatId,
            run_id: runLease.runId,
            run_scope: runScope,
            sources,
            prompt_fingerprints: promptFingerprints,
        },
        { lease: state.transportLease },
    );
    assertCurrentSourceRemovalRunScope(runScope, runLease);
    return resolveSourceRemovalGrantEvidence(
        { ok: true, status: 200 },
        body,
    );
}

async function requireUpstreamReadiness() {
    const body = await invokeControl(
        'inspectUpstreamReadiness',
        {},
    );
    if (body.status !== 'ready') {
        const error = new Error(
            'The configured model deployment is not ready for a paid intake batch.',
        );
        error.reasonCode =
            body?.reason_code
            ?? 'upstream_deployment_unavailable';
        throw error;
    }
    return body;
}

function inspectHostSourceRoutes() {
    const fields = getCharacterCardFields();
    return {
        characterSystemOverride: Boolean(String(fields.system || '').trim()),
        characterJailbreakOverride: Boolean(String(fields.jailbreak || '').trim()),
        characterDepthPrompt: Boolean(String(fields.charDepthPrompt || '').trim()),
        characterDialogueExamples: Boolean(String(fields.mesExamples || '').trim()),
        personaPresent: Boolean(String(power_user.persona_description || '').trim()),
        personaPosition:
            power_user.persona_description_position
            ?? persona_description_positions.NONE,
    };
}

function hostAssemblyMeasurementError(reasonCode, message) {
    const error = new Error(message);
    error.reasonCode = reasonCode;
    return error;
}

function hostAssemblyFrameIsCurrent(
    budgetLease,
    activeRunMarker,
    contextResponse,
) {
    return (
        settings().enabled
        && state.hostAssemblyBudgetLease === budgetLease
        && state.activeRunMarker === activeRunMarker
        && state.contextResponse === contextResponse
        && state.runId === activeRunMarker?.run_id
        && budgetLease?.activeRunMarker === activeRunMarker
        && budgetLease?.runId === activeRunMarker?.run_id
        && contextResponse?.status === 'ready'
        && state.blockReason === null
    );
}

function blockOwnedHostAssemblyFrame(
    budgetLease,
    activeRunMarker,
    reasonCode,
) {
    if (
        state.hostAssemblyBudgetLease !== budgetLease
        || state.activeRunMarker !== activeRunMarker
        || state.runId !== activeRunMarker?.run_id
    ) {
        return false;
    }
    restoreHostAssemblyBudgetLease(budgetLease);
    state.blockReason = reasonCode;
    state.dryCheckPending = false;
    updateStatus(`Blocked: ${reasonCode}`);
    return true;
}

async function captureHostAssemblyBaseSources(contextResponse) {
    const absorbedSourceKinds =
        contextResponse?.absorbed_source_kinds ?? [];
    const fields = getCharacterCardFields();
    const rawPersona = String(
        power_user.persona_description ?? '',
    );
    const rawCharacterFields = {
        description: fields.description ?? '',
        personality: fields.personality ?? '',
        scenario: fields.scenario ?? '',
        persona: rawPersona,
    };
    const personality = (
        rawCharacterFields.personality
        && oai_settings.personality_format
    )
        ? substituteParams(oai_settings.personality_format)
        : (rawCharacterFields.personality || '');
    const scenario = (
        rawCharacterFields.scenario
        && oai_settings.scenario_format
    )
        ? substituteParams(oai_settings.scenario_format)
        : (rawCharacterFields.scenario || '');
    const directPersonaPositions = [
        persona_description_positions.IN_PROMPT,
    ];
    const sourceSeal = await createHostAssemblyBaseSourceSeal({
        absorbedSourceKinds,
        characterFields: rawCharacterFields,
        personaPosition:
            power_user.persona_description_position,
        directPersonaPositions,
        worldInfoFormat: oai_settings.wi_format,
        personalityFormat: oai_settings.personality_format,
        scenarioFormat: oai_settings.scenario_format,
    });
    return {
        absorbedSourceKinds,
        characterFields: {
            description: rawCharacterFields.description,
            personality,
            scenario,
            persona: rawPersona,
        },
        personaPosition:
            power_user.persona_description_position,
        directPersonaPositions,
        sourceSeal,
    };
}

async function measureAndInstallHostAssemblyOverlay({
    budgetLease,
    activeRunMarker,
    contextResponse,
    worldInfoEntries = [],
    worldInfoComponentProvenance = [],
    phase,
    includeWorldInfo =
        activeRunMarker?.skip_wian !== true,
}) {
    if (phase !== 'base' && phase !== 'final') {
        throw hostAssemblyMeasurementError(
            'host_prompt_budget_invalid',
            'Host source measurement phase is invalid.',
        );
    }
    if (!hostAssemblyFrameIsCurrent(
        budgetLease,
        activeRunMarker,
        contextResponse,
    )) {
        return { status: 'stale' };
    }
    if (
        phase === 'final'
        && (
            foreignDryFrameCoordinator.pendingCount() > 0
            || foreignDryFrameOwnsPromptSlots()
        )
    ) {
        throw hostAssemblyMeasurementError(
            'host_prompt_foreign_dry_pending',
            'A foreign dry prompt frame overlaps final source measurement.',
        );
    }
    const initialOwnership =
        budgetLease.manager.inspectFrame(budgetLease.frame);
    if (initialOwnership.status === 'stale') {
        return { status: 'stale' };
    }
    if (initialOwnership.status !== 'owned') {
        throw hostAssemblyMeasurementError(
            initialOwnership.reason_code
                ?? 'host_prompt_budget_service_settings_changed',
            'PromptManager settings changed before source measurement.',
        );
    }

    const captured = await captureHostAssemblyBaseSources(
        contextResponse,
    );
    if (!hostAssemblyFrameIsCurrent(
        budgetLease,
        activeRunMarker,
        contextResponse,
    )) {
        return { status: 'stale' };
    }
    if (
        phase === 'base'
        && budgetLease.baseSourceSeal !== null
    ) {
        throw hostAssemblyMeasurementError(
            'host_prompt_source_baseline_changed',
            'The host source baseline was already installed.',
        );
    }
    if (
        phase === 'final'
        && (
            budgetLease.baseSourceSeal?.source_hash
                !== captured.sourceSeal.source_hash
        )
    ) {
        throw hostAssemblyMeasurementError(
            'host_prompt_source_baseline_changed',
            'Host author sources changed after baseline measurement.',
        );
    }

    const candidates = buildHostAssemblySourceCandidates({
        absorbedSourceKinds: captured.absorbedSourceKinds,
        worldInfoEntries,
        skipWIAN: includeWorldInfo !== true,
        characterFields: captured.characterFields,
        personaPosition: captured.personaPosition,
        directPersonaPositions: captured.directPersonaPositions,
        formatWorldInfoValue: value => formatWorldInfo(value),
        preparePrompt: prompt =>
            promptManager.preparePrompt(prompt),
    });
    const tokenMessages = candidates.map(candidate => ({
        role: candidate.role,
        content: candidate.content,
    }));
    const removableSourceTokens = tokenMessages.length
        ? await countTokensOpenAIAsync(tokenMessages, true)
        : 0;
    if (!hostAssemblyFrameIsCurrent(
        budgetLease,
        activeRunMarker,
        contextResponse,
    )) {
        return { status: 'stale' };
    }
    if (
        phase === 'final'
        && (
            foreignDryFrameCoordinator.pendingCount() > 0
            || foreignDryFrameOwnsPromptSlots()
        )
    ) {
        throw hostAssemblyMeasurementError(
            'host_prompt_foreign_dry_pending',
            'A foreign dry prompt frame appeared during source measurement.',
        );
    }
    if (
        !Number.isSafeInteger(removableSourceTokens)
        || removableSourceTokens < 0
    ) {
        throw hostAssemblyMeasurementError(
            'host_prompt_budget_invalid',
            'Host source measurement returned an invalid token count.',
        );
    }

    const currentSources = await captureHostAssemblyBaseSources(
        contextResponse,
    );
    if (!hostAssemblyFrameIsCurrent(
        budgetLease,
        activeRunMarker,
        contextResponse,
    )) {
        return { status: 'stale' };
    }
    if (
        currentSources.sourceSeal.source_hash
            !== captured.sourceSeal.source_hash
        || (
            phase === 'final'
            && currentSources.sourceSeal.source_hash
                !== budgetLease.baseSourceSeal?.source_hash
        )
    ) {
        throw hostAssemblyMeasurementError(
            'host_prompt_source_baseline_changed',
            'Host author sources changed during source measurement.',
        );
    }

    const measuredOwnership =
        budgetLease.manager.inspectFrame(budgetLease.frame);
    if (measuredOwnership.status === 'stale') {
        return { status: 'stale' };
    }
    if (measuredOwnership.status !== 'owned') {
        throw hostAssemblyMeasurementError(
            measuredOwnership.reason_code
                ?? 'host_prompt_budget_service_settings_changed',
            'PromptManager settings changed during source measurement.',
        );
    }
    const plan = createHostAssemblyBudgetPlan({
        configuredContextTokens:
            budgetLease.configuredContextTokens,
        outputReserveTokens:
            budgetLease.outputReserveTokens,
        removableSourceTokens,
    });
    const installation = budgetLease.manager.installOverlay(
        budgetLease.frame,
        plan.host_context_tokens,
    );
    if (installation.status === 'stale') {
        return { status: 'stale' };
    }
    if (installation.status !== 'installed') {
        throw hostAssemblyMeasurementError(
            installation.reason_code
                ?? 'host_prompt_budget_service_settings_changed',
            'PromptManager settings changed before overlay installation.',
        );
    }
    if (!hostAssemblyFrameIsCurrent(
        budgetLease,
        activeRunMarker,
        contextResponse,
    )) {
        restoreHostAssemblyBudgetLease(budgetLease);
        return { status: 'stale' };
    }
    if (phase === 'base') {
        budgetLease.baseSourceSeal = captured.sourceSeal;
        budgetLease.basePlan = plan;
    } else {
        state.worldInfoEntries = worldInfoEntries;
        state.worldInfoComponentProvenance =
            worldInfoComponentProvenance;
    }
    budgetLease.plan = plan;
    budgetLease.phase = phase;
    return {
        status: 'installed',
        phase,
        plan,
    };
}

function worldInfoProvenanceError(reasonCode, message) {
    const error = new Error(message);
    error.reasonCode = reasonCode;
    return error;
}

function normalizedWorldInfoRoute(entry) {
    const position = Number(entry?.position);
    if (position === world_info_position.before) {
        return {
            identifier: 'worldInfoBefore',
            position,
            depth: null,
            role: null,
        };
    }
    if (position === world_info_position.after) {
        return {
            identifier: 'worldInfoAfter',
            position,
            depth: null,
            role: null,
        };
    }
    if (position !== world_info_position.atDepth) {
        return {
            identifier: null,
            position,
            depth: null,
            role: null,
        };
    }
    const rawDepth = Number(entry?.depth);
    const depth = Number.isSafeInteger(rawDepth) && rawDepth >= 0
        ? rawDepth
        : DEFAULT_DEPTH;
    const rawRole = Number(entry?.role);
    const role = [0, 1, 2].includes(rawRole)
        ? rawRole
        : extension_prompt_roles.SYSTEM;
    return {
        identifier: `customDepthWI_${depth}_${role}`,
        position,
        depth,
        role,
    };
}

function findRawWorldInfoEntry(worldbook, uid) {
    const candidates = Object.entries(worldbook?.entries ?? {})
        .filter(([entryKey, entry]) => (
            String(entry?.uid ?? entryKey) === String(uid)
        ))
        .map(([, entry]) => entry);
    if (candidates.length !== 1) {
        throw worldInfoProvenanceError(
            candidates.length > 1
                ? 'host_component_selector_duplicate'
                : 'host_component_selector_invalid',
            'Activated World Info uid does not identify one raw source entry.',
        );
    }
    return candidates[0];
}

async function onWorldInfoScanDone(eventData) {
    if (
        !settings().enabled
        || eventData?.state?.next !== 0
    ) {
        return;
    }
    const activeRunMarker = state.activeRunMarker;
    const budgetLease = state.hostAssemblyBudgetLease;
    const contextResponse = state.contextResponse;
    if (
        !activeRunMarker
        || !budgetLease
        || budgetLease.activeRunMarker !== activeRunMarker
        || budgetLease.runId !== activeRunMarker.run_id
        || contextResponse?.status !== 'ready'
        || state.blockReason !== null
    ) {
        return;
    }
    if (
        foreignDryFrameCoordinator.pendingCount() > 0
        || foreignDryFrameOwnsPromptSlots()
    ) {
        blockOwnedHostAssemblyFrame(
            budgetLease,
            activeRunMarker,
            'host_prompt_foreign_dry_pending',
        );
        return;
    }
    if (budgetLease.finalScanPending !== null) {
        blockOwnedHostAssemblyFrame(
            budgetLease,
            activeRunMarker,
            'host_prompt_world_info_scan_overlap',
        );
        return;
    }

    const finalScanToken = Object.freeze({});
    budgetLease.finalScanPending = finalScanToken;
    try {
        const entries = eventData?.activated?.entries;
        const activatedValues = entries
            && typeof entries[Symbol.iterator] === 'function'
            ? (
                typeof entries.values === 'function'
                    ? [...entries.values()]
                    : [...entries]
            )
            : [];
        const {
            retainedEntries: values,
            suppressedLegacyEntries,
        } = partitionLegacyTavernDbWorldInfoEntries(
            activatedValues,
        );
        if (suppressedLegacyEntries.length > 0) {
            if (typeof entries?.delete !== 'function') {
                throw worldInfoProvenanceError(
                    'host_legacy_world_info_suppression_failed',
                    'Legacy TavernDB World Info cannot be removed from the working prompt.',
                );
            }
            for (const entry of suppressedLegacyEntries) {
                if (!entries.delete(entry)) {
                    throw worldInfoProvenanceError(
                        'host_legacy_world_info_suppression_failed',
                        'Legacy TavernDB World Info changed before prompt suppression.',
                    );
                }
            }
        }
        const worldNames = new Set();
        for (const entry of values) {
            if (
                typeof entry?.world !== 'string'
                || !entry.world.trim()
                || entry?.uid === undefined
                || entry?.uid === null
                || String(entry.uid) === ''
            ) {
                throw worldInfoProvenanceError(
                    'host_component_selector_invalid',
                    'Activated World Info is missing its world or uid.',
                );
            }
            worldNames.add(entry.world);
        }
        const loadedWorldbooks = new Map(await Promise.all(
            [...worldNames].map(async worldName => {
                const worldbook = await loadWorldInfo(worldName);
                if (
                    !worldbook
                    || typeof worldbook !== 'object'
                    || Array.isArray(worldbook)
                ) {
                    throw worldInfoProvenanceError(
                        'host_component_selector_invalid',
                        'Activated World Info raw source is unavailable.',
                    );
                }
                return [worldName, worldbook];
            }),
        ));
        if (!hostAssemblyFrameIsCurrent(
            budgetLease,
            activeRunMarker,
            contextResponse,
        )) {
            return;
        }
        const normalizedWorldInfoEntries = [];
        for (const entry of values) {
            const rawEntry = findRawWorldInfoEntry(
                loadedWorldbooks.get(entry.world),
                entry.uid,
            );
            const activatedRoute = normalizedWorldInfoRoute(entry);
            const rawRoute = normalizedWorldInfoRoute(rawEntry);
            if (
                rawRoute.position !== activatedRoute.position
                || rawRoute.identifier !== activatedRoute.identifier
                || rawRoute.depth !== activatedRoute.depth
                || rawRoute.role !== activatedRoute.role
            ) {
                throw worldInfoProvenanceError(
                    'host_component_route_mismatch',
                    'Activated World Info route differs from its raw source.',
                );
            }
            const content = getRegexedString(
                String(entry?.content ?? ''),
                regex_placement.WORLD_INFO,
                {
                    depth: activatedRoute.depth,
                    isMarkdown: false,
                    isPrompt: true,
                },
            );
            normalizedWorldInfoEntries.push({
                world: entry.world,
                uid: entry.uid,
                position: activatedRoute.position,
                order: entry?.order,
                depth: activatedRoute.depth,
                role: activatedRoute.role,
                routeIdentifier: activatedRoute.identifier,
                outletName: entry?.outletName ?? null,
                content,
                raw_content_hash:
                    await hashHostProvenanceContent(
                        String(rawEntry?.content ?? ''),
                    ),
                prepared_content_hash:
                    await hashHostProvenanceContent(content),
            });
        }
        const worldInfoComponentProvenance =
            await buildWorldInfoComponentProvenance(
                normalizedWorldInfoEntries.filter(
                    entry => entry.routeIdentifier !== null,
                ),
            );
        const includeWorldInfo =
            activeRunMarker.skip_wian !== true;
        const measurement =
            await measureAndInstallHostAssemblyOverlay({
                budgetLease,
                activeRunMarker,
                contextResponse,
                worldInfoEntries: normalizedWorldInfoEntries,
                worldInfoComponentProvenance,
                phase: 'final',
                includeWorldInfo,
            });
        if (measurement.status === 'stale') return;
    } catch (error) {
        blockOwnedHostAssemblyFrame(
            budgetLease,
            activeRunMarker,
            error.reasonCode
                ?? 'host_prompt_budget_measurement_failed',
        );
    } finally {
        if (
            budgetLease.finalScanPending
                === finalScanToken
        ) {
            budgetLease.finalScanPending = null;
        }
    }
}

async function onGenerationStarted(
    generationType,
    generationOptions = {},
    dryRun,
) {
    const nextGenerationType = generationType ?? 'normal';
    if (dryRun === true && state.activeRunMarker) {
        beginForeignDryFrame(state.activeRunMarker);
        return;
    }
    const ownDryCheck = (
        state.exclusiveOperation === 'dry-check'
        && state.dryCheckPending
        && dryRun === true
    );
    if (dryRun === true && !ownDryCheck) {
        if (!state.activeRunMarker) {
            clearInjections();
            state.runId = null;
            state.generationType = null;
        }
        return;
    }
    if (
        state.exclusiveOperation !== null
        && !ownDryCheck
    ) {
        state.generationType = nextGenerationType;
        const reasonCode =
            `${state.exclusiveOperation}_operation_active`;
        if (dryRun === false) {
            blockCurrentGeneration(reasonCode);
        } else {
            clearInjections();
            state.runId = null;
            state.blockReason = reasonCode;
            updateStatus(`Blocked: ${reasonCode}`);
        }
        return;
    }

    let pendingHistoryEditReason;
    const historyChatId = getContext().chatId ?? null;
    try {
        const observedReason =
            await historyInvalidationCoordinator.run(
                () => resolvePendingHistoryEditBeforeGeneration(
                    historyChatId,
                ),
                { chatId: historyChatId },
            );
        pendingHistoryEditReason = settings().enabled
            ? observedReason
            : null;
    } catch (error) {
        pendingHistoryEditReason = settings().enabled
            ? (
                error.reasonCode
                ?? 'history_edit_reconciliation_failed'
            )
            : null;
    }

    if (!settings().enabled) {
        state.generationType = nextGenerationType;
        state.runId = null;
        clearInjections();
        updateStatus('Disabled');
        return;
    }

    if (pendingHistoryEditReason) {
        state.generationType = nextGenerationType;
        if (dryRun !== true) {
            blockCurrentGeneration(pendingHistoryEditReason);
        } else {
            clearInjections();
            state.runId = null;
            state.blockReason = pendingHistoryEditReason;
            updateStatus(`Blocked: ${pendingHistoryEditReason}`);
        }
        return;
    }
    state.generationAbortReason = null;

    claimSettingsReadyFinalizerOrder();
    const context = getContext();
    const startHostHistorySnapshot = snapshotHostHistory(context.chat);
    const pendingUserTurn = shouldReservePendingUserTurn({
        generationType: nextGenerationType,
        automaticTrigger: generationOptions?.automatic_trigger,
        dryRun,
        textareaText:
            document.querySelector('#send_textarea')?.value
            ?? '',
        hasPendingAttachment: hasPendingFileAttachment(),
        sendIfEmpty: oai_settings.send_if_empty,
        mainApi: main_api,
    });
    let initialRunScope;
    try {
        initialRunScope = buildCurrentRunScope({
            generationType: nextGenerationType,
            pendingUserTurn,
            nestedGeneration: Boolean(state.activeRunMarker),
        });
    } catch (error) {
        clearInjections();
        state.generationType = nextGenerationType;
        state.runId = null;
        state.blockReason =
            error.reasonCode
            ?? 'story_generation_lifecycle_invalid';
        updateStatus(`Blocked: ${state.blockReason}`);
        return;
    }

    clearInjections();
    state.generationType = nextGenerationType;
    state.runId = crypto.randomUUID();
    state.runScope = initialRunScope;
    state.promptTrace = null;
    state.preSquashInternalMessages = null;
    state.worldInfoEntries = [];
    state.worldInfoComponentProvenance = [];
    state.hostSourceRoutes = {};
    state.blockReason = null;
    state.activeRunMarker = {
        schema: 'mnemosyne.story-generation-marker.v1',
        run_id: state.runId,
        generation_type: state.generationType,
        dry_run: Boolean(dryRun),
        pending_user_turn: pendingUserTurn,
        skip_wian: generationOptions?.skipWIAN === true,
        start_host_history_snapshot: structuredClone(
            startHostHistorySnapshot,
        ),
        prompt_host_history_binding: null,
    };

    updateStatus('Preparing');
    try {
        await loadProxyHealth();
    } catch (error) {
        clearInjections();
        state.runId = null;
        state.blockReason =
            error.reasonCode
            ?? 'agent_proxy_unavailable';
        updateStatus(`Blocked: ${state.blockReason}`);
        return;
    }

    try {
        const configuredContextTokens =
            Number(oai_settings.openai_max_context);
        const outputReserveTokens =
            Number(oai_settings.openai_max_tokens);
        const initialBudget = createHostAssemblyBudgetPlan({
            configuredContextTokens,
            outputReserveTokens,
            removableSourceTokens: 0,
        });
        if (
            Number(promptManager?.serviceSettings?.openai_max_context)
                !== configuredContextTokens
            || Number(promptManager?.serviceSettings?.openai_max_tokens)
                !== outputReserveTokens
        ) {
            const error = new Error(
                'PromptManager settings do not match the configured host window.',
            );
            error.reasonCode =
                'host_prompt_budget_service_settings_changed';
            throw error;
        }
        const leaseManager = currentHostAssemblyLeaseManager();
        const frame = leaseManager.beginFrame(state.runId);
        state.hostAssemblyBudgetLease = {
            runId: state.runId,
            activeRunMarker: state.activeRunMarker,
            manager: leaseManager,
            frame,
            configuredContextTokens,
            outputReserveTokens,
            plan: initialBudget,
            basePlan: null,
            baseSourceSeal: null,
            phase: 'initial',
            finalScanPending: null,
        };
        state.providerBudget = await createProviderBudgetBinding({
            runId: state.runId,
            configuredContextTokens:
                state.providerBudgetPolicy.configured_context_tokens,
            outputReserveTokens:
                state.providerBudgetPolicy.output_reserve_tokens,
        });
    } catch (error) {
        clearInjections();
        state.runId = null;
        state.generationType = nextGenerationType;
        state.blockReason =
            error.reasonCode
            ?? 'host_prompt_budget_invalid';
        updateStatus(`Blocked: ${state.blockReason}`);
        return;
    }
    const profile = inspectCurrentHostProfile();
    if (profile.status !== 'ready') {
        clearInjections();
        state.blockReason = profile.reason_code;
        updateStatus(`Blocked: ${profile.reason_code}`);
        return;
    }

    try {
        if (!state.chatSnapshot.length && Array.isArray(context.chat)) {
            refreshChatSnapshot();
        }
        if (
            state.generationType === 'regenerate'
            && !dryRun
        ) {
            const chatLength = context.chat.length;
            const remainingLength = chatLength - 1;
            await historyInvalidationCoordinator.run(async () => {
                historyLifecycleContext(context.chatId);
                const truncation =
                    await truncateHostHistory({
                        cutoffTurnIndex: remainingLength,
                        reasonCode: 'host_regenerate',
                        commandId: `regenerate-${state.runId}`,
                        expectedChatId: context.chatId,
                    });
                await persistGovernedHistoryCheckpoint(
                    snapshotHostHistory(
                        context.chat,
                    ).slice(0, remainingLength),
                    {
                        branchEpoch:
                            truncation.new_branch_epoch,
                        expectedChatId: context.chatId,
                    },
                );
            }, { chatId: context.chatId });
            state.suppressedMessageDeletion = {
                chatId: context.chatId,
                remainingLength,
            };
            state.runScope = buildCurrentRunScope({
                generationType: state.generationType,
                pendingUserTurn: false,
            });
        }
        state.runScope.active_candidate_id = `run:${state.runId}`;
        await loadContext(state.runId);
        state.hostSourceRoutes = inspectHostSourceRoutes();
        const budgetLease = state.hostAssemblyBudgetLease;
        const activeRunMarker = state.activeRunMarker;
        const contextResponse = state.contextResponse;
        const baseline =
            await measureAndInstallHostAssemblyOverlay({
                budgetLease,
                activeRunMarker,
                contextResponse,
                worldInfoEntries: [],
                phase: 'base',
            });
        if (baseline.status === 'stale') return;
        if (typeof eventSource.makeLast === 'function') {
            eventSource.makeLast(
                event_types.WORLDINFO_SCAN_DONE,
                onWorldInfoScanDone,
            );
        }
        updateStatus('Ready');
    } catch (error) {
        clearInjections();
        state.blockReason = error.reasonCode ?? 'context_unavailable';
        updateStatus(`Blocked: ${state.blockReason}`);
    }
}

function historyLifecycleIsActive() {
    return (
        settings().enabled
        && Boolean(getContext().chatId)
    );
}

function historyLifecycleCanObserve() {
    return Boolean(getContext().chatId);
}

async function settlePendingHistoryInvalidation(
    governedPrefix,
    branchEpoch,
    expectedChatId = null,
) {
    const context =
        historyLifecycleContext(expectedChatId);
    const checkpoint =
        await createGovernedHistoryCheckpoint({
            chatId: context.chatId,
            hostHistorySnapshot: governedPrefix,
            branchEpoch,
        });
    historyLifecycleContext(context.chatId);
    historyLifecycleDurableStore.write(
        context.chatId,
        {
            guard: null,
            checkpoint,
        },
    );
    context.chatMetadata ??= {};
    context.chatMetadata.mnemosyne ??= {};
    context.chatMetadata.mnemosyne
        .governed_history_checkpoint = checkpoint;
    delete context.chatMetadata.mnemosyne
        .pending_history_edit;
    await saveMetadata();
    historyLifecycleContext(context.chatId);
}

async function onMessageSwiped(messageId) {
    const expectedChatId = getContext().chatId ?? null;
    clearRecentGovernedFeedbackRun();
    return historyInvalidationCoordinator.run(async () => {
        const context =
            historyLifecycleContext(expectedChatId);
        const normalizedMessageId = Number(messageId);
        const message = context.chat?.[normalizedMessageId];
        try {
            if (!historyLifecycleIsActive()) return;
            const swipeId = message?.swipe_id;
            if (
                !Number.isInteger(normalizedMessageId)
                || normalizedMessageId < 0
                || !Number.isInteger(swipeId)
                || swipeId < 0
                || !Array.isArray(message?.swipes)
            ) {
                return;
            }
            // SillyTavern emits MESSAGE_SWIPED once for the empty overswipe
            // slot before it starts the model call.
            if (swipeId >= message.swipes.length) return;
            const branchEpoch =
                await verifiedHistoryBranchEpoch(
                    context.chatId,
                );

            await postHistoryEvent(
                '/v1/mnemosyne/history/activate-swipe',
                {
                    command_id:
                        `swipe-activate-${crypto.randomUUID()}`,
                    chat_id: context.chatId,
                    branch_id: 'main',
                    branch_epoch: branchEpoch,
                    turn_index: normalizedMessageId,
                    swipe_id: swipeId,
                    through_turn_index: Math.max(
                        0,
                        (context.chat?.length ?? 1) - 1,
                    ),
                },
            );
            historyLifecycleContext(context.chatId);
            const snapshot = snapshotHostHistory(context.chat);
            await persistGovernedHistoryCheckpoint(
                snapshot,
                { expectedChatId: context.chatId },
            );
            refreshChatSnapshot();
        } catch (error) {
            reportHistoryLifecycleFailure(
                error,
                expectedChatId,
            );
        }
    }, { chatId: expectedChatId });
}

async function onMessageSwipeDeleted(eventData) {
    const expectedChatId = getContext().chatId ?? null;
    clearRecentGovernedFeedbackRun();
    return historyInvalidationCoordinator.run(async () => {
        const context =
            historyLifecycleContext(expectedChatId);
        try {
            if (!historyLifecycleIsActive()) return;
            const messageId = Number(eventData?.messageId);
            const deletedSwipeId = Number(eventData?.swipeId);
            const fallbackSwipeId = Number(eventData?.newSwipeId);
            if (
                !Number.isInteger(messageId)
                || messageId < 0
                || !Number.isInteger(deletedSwipeId)
                || deletedSwipeId < 0
                || !Number.isInteger(fallbackSwipeId)
                || fallbackSwipeId < 0
            ) {
                const error = new Error(
                    'SillyTavern emitted an invalid swipe deletion coordinate.',
                );
                error.reasonCode =
                    'history_swipe_delete_coordinate_invalid';
                throw error;
            }
            const branchEpoch =
                await verifiedHistoryBranchEpoch(
                    context.chatId,
                );
            await postHistoryEvent(
                '/v1/mnemosyne/history/delete-swipe',
                {
                    command_id:
                        `swipe-delete-${crypto.randomUUID()}`,
                    chat_id: context.chatId,
                    branch_id: 'main',
                    branch_epoch: branchEpoch,
                    turn_index: messageId,
                    deleted_swipe_id: deletedSwipeId,
                    fallback_swipe_id: fallbackSwipeId,
                    through_turn_index: Math.max(
                        0,
                        (context.chat?.length ?? 1) - 1,
                    ),
                },
            );
            historyLifecycleContext(context.chatId);
            const snapshot = snapshotHostHistory(context.chat);
            await persistGovernedHistoryCheckpoint(
                snapshot,
                { expectedChatId: context.chatId },
            );
            refreshChatSnapshot();
        } catch (error) {
            reportHistoryLifecycleFailure(
                error,
                expectedChatId,
            );
        }
    }, { chatId: expectedChatId });
}

async function onMessageDeleted(remainingLength) {
    const expectedChatId = getContext().chatId ?? null;
    clearRecentGovernedFeedbackRun();
    return historyInvalidationCoordinator.run(async () => {
        const context =
            historyLifecycleContext(expectedChatId);
        const currentSnapshot =
            snapshotHostHistory(context.chat);
        const normalizedRemainingLength =
            Number(remainingLength);
        try {
            if (
                state.suppressedMessageDeletion
                && state.suppressedMessageDeletion.chatId
                    === context.chatId
                && state.suppressedMessageDeletion
                    .remainingLength
                    === normalizedRemainingLength
            ) {
                state.suppressedMessageDeletion = null;
                return;
            }
            if (!historyLifecycleCanObserve()) return;
            if (
                state.chatSnapshotChatId !== context.chatId
                || !state.chatSnapshot.length
            ) {
                await detectUnobservedHistoryInvalidation(
                    context.chatId,
                );
                return;
            }
            if (
                !Number.isInteger(normalizedRemainingLength)
                || normalizedRemainingLength < 0
                || normalizedRemainingLength
                    >= state.chatSnapshot.length
            ) {
                return;
            }
            const cutoffTurnIndex =
                findMessageDeletionCutoff(
                    state.chatSnapshot,
                    currentSnapshot,
                    {
                        expectedRemainingLength:
                            normalizedRemainingLength,
                    },
                );
            if (
                cutoffTurnIndex
                >= state.chatSnapshot.length
            ) {
                return;
            }
            await ensurePendingHistoryInvalidation({
                cutoffTurnIndex,
                hostReleaseLength:
                    hostReleaseLengthForInvalidation(
                        cutoffTurnIndex,
                        currentSnapshot,
                    ),
                hostHistoryLength:
                    state.chatSnapshot.length,
                reasonCode: 'host_message_deleted',
                expectedChatId: context.chatId,
            });
            state.chatSnapshot = currentSnapshot;
            state.chatSnapshotChatId = context.chatId;
            if (historyLifecycleIsActive()) {
                const reason =
                    await resolvePendingHistoryEditBeforeGeneration(
                        context.chatId,
                    );
                if (reason) {
                    state.blockReason = reason;
                } else {
                    state.blockReason = null;
                }
            }
            state.runScope = null;
        } catch (error) {
            reportHistoryLifecycleFailure(
                error,
                expectedChatId,
            );
        }
    }, { chatId: expectedChatId });
}

async function onHostMessageEdited(messageId) {
    const expectedChatId = getContext().chatId ?? null;
    clearRecentGovernedFeedbackRun();
    return historyInvalidationCoordinator.run(async () => {
        const context =
            historyLifecycleContext(expectedChatId);
        const currentSnapshot =
            snapshotHostHistory(context.chat);
        const normalizedMessageId = Number(messageId);
        try {
            if (!historyLifecycleCanObserve()) return;
            if (currentSnapshot.length === 0) {
                const error = new Error(
                    'SillyTavern emitted an edit without a host history coordinate.',
                );
                error.reasonCode =
                    'history_edit_coordinate_invalid';
                throw error;
            }

            let cutoffTurnIndex;
            if (
                state.chatSnapshotChatId
                    !== context.chatId
                || state.chatSnapshot.length
                    !== currentSnapshot.length
                || !Number.isInteger(normalizedMessageId)
                || normalizedMessageId < 0
                || normalizedMessageId
                    >= currentSnapshot.length
            ) {
                cutoffTurnIndex = 0;
            } else {
                cutoffTurnIndex = findMessageEditCutoff(
                    state.chatSnapshot,
                    currentSnapshot,
                    {
                        expectedMessageIndex:
                            normalizedMessageId,
                    },
                );
            }
            if (cutoffTurnIndex === null) return;

            await ensurePendingHistoryInvalidation({
                cutoffTurnIndex,
                hostReleaseLength:
                    hostReleaseLengthForInvalidation(
                        cutoffTurnIndex,
                        currentSnapshot,
                    ),
                hostHistoryLength:
                    currentSnapshot.length,
                reasonCode: 'host_message_edited',
                expectedChatId: context.chatId,
            });
            state.chatSnapshot = currentSnapshot;
            state.chatSnapshotChatId = context.chatId;

            let reason =
                'history_edit_reconciliation_deferred';
            if (historyLifecycleIsActive()) {
                reason =
                    await resolvePendingHistoryEditBeforeGeneration(
                        context.chatId,
                    );
            }
            clearInjections();
            state.runId = null;
            state.runScope = null;
            state.blockReason = reason;
            updateStatus(
                !settings().enabled
                    ? 'Disabled'
                    : reason
                        ? `Blocked: ${reason}`
                        : 'Ready',
            );
        } catch (error) {
            reportHistoryLifecycleFailure(
                error,
                expectedChatId,
            );
        }
    }, { chatId: expectedChatId });
}

async function onChatChanged() {
    const expectedChatId = getContext().chatId ?? null;
    clearRecentGovernedFeedbackRun({
        clearLastFeedback: true,
    });
    runActivityController.clearForChatChange();
    return historyInvalidationCoordinator.run(async () => {
        state.runId = null;
        state.runScope = null;
        state.generationType = null;
        state.generationAbortReason = null;
        state.blockReason = null;
        state.suppressedMessageDeletion = null;
        state.chatSnapshot = [];
        state.chatSnapshotChatId = null;
        clearInjections();
        try {
            await detectUnobservedHistoryInvalidation(
                expectedChatId,
            );
        } catch (error) {
            reportHistoryLifecycleFailure(
                error,
                expectedChatId,
            );
        } finally {
            if (getContext().chatId === expectedChatId) {
                refreshChatSnapshot();
            }
        }
        if (getContext().chatId !== expectedChatId) return;
        updateStatus(
            settings().enabled
                ? (
                    state.blockReason
                        ? `Blocked: ${state.blockReason}`
                        : 'Ready'
                )
                : 'Disabled',
        );
        scheduleAutoStaticLoreIntake(expectedChatId);
    }, { chatId: expectedChatId });
}

function onGenerationFinished() {
    state.runId = null;
    state.generationType = null;
    state.generationAbortReason = null;
    state.suppressedMessageDeletion = null;
    clearInjections();
    refreshChatSnapshot();
    updateStatus(generationTerminalStatus({
        enabled: settings().enabled,
        blockReason: state.blockReason,
    }));
}

function onGenerationEnded() {
    try {
        const activeRunMarker = state.activeRunMarker;
        const chatId = getContext().chatId ?? null;
        if (
            chatId
            && activeRunMarker
            && activeRunMarker.dry_run === false
            && activeRunMarker.run_id === state.runId
            && state.promptTrace?.run_id
                === activeRunMarker.run_id
        ) {
            realUseFeedbackController
                .captureCompletedOwnedRun({
                    chatId,
                    runId: activeRunMarker.run_id,
                });
        }
    } catch {
        // Feedback capture cannot affect generation finalization.
    }
    onGenerationFinished();
}

function onHostMessageSent() {
    refreshChatSnapshot();
}

async function onHostMessageReceived() {
    const expectedChatId = getContext().chatId ?? null;
    return historyInvalidationCoordinator.run(async () => {
        const context =
            historyLifecycleContext(expectedChatId);
        try {
            const snapshot = refreshChatSnapshot();
            const activeRunMarker =
                state.activeRunMarker;
            const assistantReply = (
                context.chat?.at(-1)?.is_user === false
                && context.chat?.at(-1)?.is_system !== true
            );
            const liveRunId = (
                activeRunMarker
                && activeRunMarker.dry_run === false
                && activeRunMarker.run_id === state.runId
                && state.promptTrace?.run_id
                    === activeRunMarker.run_id
            )
                ? activeRunMarker.run_id
                : null;
            const ownedCommittedReply = assistantReply
                ? realUseFeedbackController.resolveOwnedReplyRun({
                    chatId: context.chatId,
                    liveRunId,
                })
                : null;
            if (
                !historyLifecycleIsActive()
                || await currentPendingHistoryEdit(
                    context.chatId,
                )
                || state.blockReason !== null
                || !ownedCommittedReply
            ) {
                return;
            }
            await persistGovernedHistoryCheckpoint(
                snapshot,
                { expectedChatId: context.chatId },
            );
            try {
                rememberRecentGovernedFeedbackRun({
                    chatId: context.chatId,
                    runId: ownedCommittedReply.run_id,
                });
            } catch {
                // Feedback state cannot affect the governed checkpoint.
            }
        } catch (error) {
            reportHistoryLifecycleFailure(
                error,
                expectedChatId,
            );
        }
    }, { chatId: expectedChatId });
}

async function onPromptReady(eventData) {
    const activeRunMarker = state.activeRunMarker;
    if (
        !settings().enabled
        || !activeRunMarker
        || eventData?.dryRun === undefined
    ) {
        return;
    }
    claimSettingsReadyFinalizerOrder();
    const foreignFrame = inspectForeignDryPromptFrame(
        eventData?.chat,
    );
    if (foreignFrame.status === 'pass') {
        const matchingFrame = foreignDryFrameCoordinator.find(
            foreignFrame,
            activeRunMarker,
        );
        if (eventData.dryRun === true && matchingFrame) {
            settleForeignDryFrame(
                matchingFrame.frameId,
                activeRunMarker,
            );
        }
        return;
    }
    const eventMarkerInspection = inspectPromptRunMarkers(
        eventData?.chat,
        activeRunMarker.run_id,
    );
    if (eventMarkerInspection.status === 'pass') {
        settleAllForeignDryFrames(activeRunMarker);
    }
    const ownership = classifyPromptReadyOwnership(
        activeRunMarker,
        eventData,
        {
            foreignDryFrameIds:
                foreignDryFrameCoordinator.frameIds(),
        },
    );
    if (ownership === 'foreign_dry') return;
    const budgetLease = state.hostAssemblyBudgetLease;

    const blockOwnedPrompt = reasonCode => {
        state.blockReason = reasonCode;
        state.dryCheckPending = false;
        updateStatus(`Blocked: ${reasonCode}`);
    };
    const markerInspection = eventMarkerInspection;
    const reasonCode = promptMarkerFailureReason({
        markerInspection,
        runtimeSlotPopulated: Boolean(
            String(extension_prompts[RUNTIME_KEY]?.value ?? '').trim(),
        ),
        continuitySlotPopulated: Boolean(
            String(extension_prompts[PAYLOAD_KEY]?.value ?? '').trim(),
        ),
    });
    let runLease = null;
    try {
        if (ownership !== 'owned') {
            blockOwnedPrompt(`prompt_ready_owner_${ownership}`);
            return;
        }
        if (reasonCode !== null) {
            blockOwnedPrompt(reasonCode);
            if (
                Boolean(eventData.dryRun)
                && completeDryRunLifecycle(state, {
                    expectedRunId: activeRunMarker.run_id,
                    expectedActiveRunMarker: activeRunMarker,
                })
            ) {
                clearExtensionPromptSlots();
            }
            return;
        }
        if (
            !budgetLease
            || budgetLease.activeRunMarker !== activeRunMarker
            || budgetLease.runId !== activeRunMarker.run_id
        ) {
            if (state.blockReason !== null) {
                blockOwnedPrompt(state.blockReason);
                return;
            }
            blockOwnedPrompt('host_prompt_budget_invalid');
            return;
        }
        const settlement =
            restoreHostAssemblyBudgetLease(budgetLease);
        if (settlement.status === 'conflict') {
            blockOwnedPrompt(
                settlement.reason_code
                ?? 'host_prompt_budget_service_settings_changed',
            );
            return;
        }
        if (settlement.status !== 'restored') {
            blockOwnedPrompt('host_prompt_budget_invalid');
            return;
        }
        if (state.blockReason !== null) {
            blockOwnedPrompt(state.blockReason);
            return;
        }
        const preset = getChatCompletionPreset();
        const context = getContext();
        if (
            !state.contextResponse
            || !state.runScope
            || state.runId !== activeRunMarker.run_id
            || Boolean(eventData.dryRun) !== activeRunMarker.dry_run
        ) {
            const error = new Error(
                'PromptReady does not match the active story generation.',
            );
            error.reasonCode = 'story_generation_run_marker_mismatch';
            throw error;
        }
        runLease = captureStoryRunLease({
            chatId: context.chatId,
            runId: state.runId,
            activeRunMarker,
            contextResponse: state.contextResponse,
        });
        const currentHostHistorySnapshot =
            snapshotHostHistory(context.chat);
        const hostHistoryBinding = await createStoryPromptHistoryBinding({
            chatId: runLease.chatId,
            runScope: state.runScope,
            generationType: activeRunMarker.generation_type,
            pendingUserTurn: activeRunMarker.pending_user_turn,
            startHostHistorySnapshot:
                activeRunMarker.start_host_history_snapshot,
            currentHostHistorySnapshot,
        });
        const hostHistoryCoordinateBasis =
            await sealHostHistoryCoordinateBasis({
                originCapture:
                    state.generationHistoryOriginCapture,
                hostHistoryBinding,
                runId: runLease.runId,
                generationType:
                    activeRunMarker.generation_type,
            });
        assertCurrentStoryRunLease(runLease);
        const internalMessages = state.preSquashInternalMessages
            ?? snapshotPromptManagerMessages(
                promptManager?.messages?.flatten?.() ?? [],
            );
        const providerMessages = applyHostMessageTransforms(
            eventData.chat ?? [],
            {
                squashSystemMessages: preset.squash_system_messages,
                squashAlreadyApplied: !eventData.dryRun,
                customPromptPostProcessing:
                    preset.custom_prompt_post_processing,
                promptNames: {
                    charName: context.name2 ?? '',
                    userName: context.name1 ?? '',
                    groupNames: getGroupNames(),
                },
            },
        );
        const depthRouting = await buildWorldInfoDepthRouteOverrides({
            internalMessages,
            extensionPrompts: extension_prompts,
            componentProvenance:
                state.worldInfoComponentProvenance,
        });
        assertCurrentStoryRunLease(runLease);
        const sourceRemovalEvidence = await issueSourceRemovalGrants(
            internalMessages,
            depthRouting.overrides,
            state.worldInfoComponentProvenance,
            runLease,
        );
        assertCurrentStoryRunLease(runLease);
        state.sourceRemovalAuthorizations =
            sourceRemovalEvidence.grants;
        const absorbedSourceKinds =
            runLease.contextResponse.absorbed_source_kinds
            ?? [];
        const unresolvedAbsorbedSources = findUntraceableAbsorbedSources({
            absorbedSourceKinds,
            worldInfoEntries: state.worldInfoEntries,
            hostSourceRoutes: state.hostSourceRoutes,
            traceableWorldInfoDepthRoutes: depthRouting.overrides.map(
                route => route.identifier,
            ),
        });
        if (absorbedSourceKinds.includes('raw_worldbook')) {
            unresolvedAbsorbedSources.push(...depthRouting.unresolved);
        }
        const promptTraceInputs = {
            runId: runLease.runId,
            internalMessages,
            presetPromptIdentifiers: (
                preset.prompts
                ?? []
            ).map(prompt => prompt?.identifier),
            sourceRemovalAuthorizations: state.sourceRemovalAuthorizations,
            sourceCoverage: sourceRemovalEvidence.sourceCoverage,
            sourceRouteOverrides: depthRouting.overrides,
            componentProvenance:
                state.worldInfoComponentProvenance,
            unresolvedAbsorbedSources,
            hostTransforms: {
                squash_system_messages: preset.squash_system_messages,
                custom_prompt_post_processing:
                    preset.custom_prompt_post_processing,
            },
            chatRef: chatRef(),
            hostHistoryBinding,
            hostHistoryCoordinateBasis,
            providerBudget: state.providerBudget,
        };
        const finalized = await finalizePromptTrace({
            promptTraceInputs,
            providerMessages,
        });
        assertCurrentStoryRunLease(runLease);
        state.promptTraceInputs = structuredClone(promptTraceInputs);
        state.promptTrace = finalized.trace;
        state.providerMessages = finalized.providerMessages;
        state.lastDryCheck = finalized.inspection;
        activeRunMarker.prompt_host_history_binding =
            structuredClone(hostHistoryBinding);

        if (state.dryCheckPending && eventData.dryRun) {
            const hostProfile = inspectCurrentHostProfile();
            const forwardingProbeLease =
                await createForwardingProbeLease({
                    trace: state.promptTrace,
                    messages: state.providerMessages,
                    hostProfile,
                    providerBudgetPolicy:
                        state.providerBudgetPolicy,
                    chatId: context.chatId,
                    hostHistorySnapshot:
                        snapshotHostHistory(context.chat),
                });
            assertCurrentStoryRunLease(runLease);
            await assertForwardingProbeLease(
                forwardingProbeLease,
                {
                    trace: state.promptTrace,
                    messages: state.providerMessages,
                    hostProfile:
                        inspectCurrentHostProfile(),
                    providerBudgetPolicy:
                        state.providerBudgetPolicy,
                    chatId: context.chatId,
                    hostHistorySnapshot:
                        snapshotHostHistory(context.chat),
                    activeRunMarker:
                        state.activeRunMarker,
                    runId: state.runId,
                    expectedActiveRunMarker:
                        activeRunMarker,
                },
            );
            assertCurrentStoryRunLease(runLease);
            state.forwardingProbeLease =
                forwardingProbeLease;
            state.dryCheckPending = false;
            updateStatus('Dry check passed');
        }
        if (!eventData.dryRun) {
            if (state.sourceIsolationLease !== null) {
                const error = new Error(
                    'A prior author-source isolation lease is still active.',
                );
                error.reasonCode =
                    'host_source_isolation_lease_overlap';
                throw error;
            }
            const isolated = createAbsorbedSourceIsolationLease({
                workingMessages: eventData.chat,
                internalMessages,
                promptTrace: finalized.trace,
            });
            if (
                state.sourceRemovalAuthorizations.length > 0
                && !isolated.lease
            ) {
                const error = new Error(
                    'Absorbed author sources were not isolated.',
                );
                error.reasonCode =
                    'host_source_isolation_lease_missing';
                throw error;
            }
            eventData.chat.splice(
                0,
                eventData.chat.length,
                ...isolated.messages,
            );
            state.sourceIsolationLease = isolated.lease;
        }
    } catch (error) {
        if (runLease) {
            try {
                assertCurrentStoryRunLease(runLease);
            } catch {
                return;
            }
        } else if (
            state.activeRunMarker !== activeRunMarker
            || state.runId !== activeRunMarker.run_id
        ) {
            return;
        }
        state.promptTrace = null;
        state.promptTraceInputs = null;
        state.providerMessages = null;
        state.forwardingProbeLease = null;
        state.sourceIsolationLease = null;
        if (state.activeRunMarker) {
            state.activeRunMarker.prompt_host_history_binding = null;
        }
        state.blockReason =
            error.reasonCode
            ?? 'source_removal_grant_failed';
        state.dryCheckPending = false;
        updateStatus(`Blocked: ${state.blockReason}`);
    } finally {
        restoreHostAssemblyBudgetLease(budgetLease);
        if (
            Boolean(eventData?.dryRun)
            && completeDryRunLifecycle(state, {
                expectedRunId: activeRunMarker.run_id,
                expectedActiveRunMarker: activeRunMarker,
            })
        ) {
            clearExtensionPromptSlots();
        }
    }
}

async function onSettingsReady(generateData) {
    const activeRunMarker = state.activeRunMarker;
    if (
        !settings().enabled
        || !activeRunMarker
        || !promptMessagesBelongToRun(
            generateData?.messages,
            activeRunMarker.run_id,
        )
    ) {
        return;
    }
    if (!settingsReadyFinalizerIsLast()) {
        blockChatCompletionRequest(
            generateData,
            'host_settings_finalizer_order_drift',
        );
        return;
    }
    const profile = inspectCurrentHostProfile();
    if (profile.status !== 'ready') {
        blockChatCompletionRequest(generateData, profile.reason_code);
        return;
    }
    if (!state.promptTraceInputs || !Array.isArray(generateData?.messages)) {
        blockChatCompletionRequest(
            generateData,
            state.blockReason ?? 'prompt_trace_missing',
        );
        return;
    }
    if (generateData?.chat_completion_source !== 'custom') {
        blockChatCompletionRequest(generateData, 'chat_completion_source_not_custom');
        return;
    }

    try {
        const context = getContext();
        if (
            state.runId !== activeRunMarker.run_id
            || state.promptTraceInputs.runId !== activeRunMarker.run_id
            || !activeRunMarker.prompt_host_history_binding
            || state.promptTraceInputs.hostHistoryBinding?.binding_hash
                !== activeRunMarker.prompt_host_history_binding.binding_hash
        ) {
            const error = new Error(
                'SettingsReady does not match the active story generation.',
            );
            error.reasonCode = 'story_generation_run_marker_mismatch';
            throw error;
        }
        await verifyHostHistoryBinding({
            expectedBinding:
                activeRunMarker.prompt_host_history_binding,
            chatId: context.chatId,
            runScope: state.runScope,
            hostHistorySnapshot: snapshotHostHistory(context.chat),
        });
        if (
            state.sourceRemovalAuthorizations.length > 0
            && !state.sourceIsolationLease
        ) {
            const error = new Error(
                'The active author-source isolation lease is missing.',
            );
            error.reasonCode =
                'host_source_isolation_lease_missing';
            throw error;
        }
        if (state.sourceIsolationLease) {
            const restored =
                restoreAbsorbedSourceIsolationLease({
                    workingMessages: generateData.messages,
                    lease: state.sourceIsolationLease,
                });
            generateData.messages.splice(
                0,
                generateData.messages.length,
                ...restored.messages,
            );
        }
        const finalized = await finalizePromptTrace({
            promptTraceInputs: state.promptTraceInputs,
            providerMessages: generateData.messages,
        });
        state.promptTrace = finalized.trace;
        state.providerMessages = finalized.providerMessages;
        state.lastDryCheck = finalized.inspection;
        generateData.custom_include_body = mergeCustomIncludeBody(
            generateData.custom_include_body,
            finalized.trace,
        );
        generateData.custom_include_body =
            mergeTransportLeaseIntoCustomBody(
                generateData.custom_include_body,
                state.transportLease,
            );
    } catch (error) {
        state.blockReason =
            error.reasonCode
            ?? 'prompt_trace_contract_failed';
        blockChatCompletionRequest(generateData, state.blockReason);
    } finally {
        state.sourceIsolationLease = null;
    }
}

async function runDryCheck() {
    if (!settings().enabled) {
        updateStatus('Blocked: enable Mnemosyne');
        return;
    }
    if (!claimExclusiveOperation('dry-check')) return;

    state.dryCheckPending = true;
    state.lastDryCheck = null;
    try {
        await loadProxyHealth();
        const profile = inspectCurrentHostProfile();
        if (profile.status !== 'ready') {
            const error = new Error(
                'The active host profile is not verified.',
            );
            error.reasonCode = profile.reason_code;
            throw error;
        }
        updateStatus('Running dry check');
        await getContext().generate('normal', {}, true);
        if (state.dryCheckPending) {
            updateStatus(
                `Blocked: ${state.blockReason ?? 'prompt_trace_missing'}`,
            );
        }
    } catch (error) {
        updateStatus(
            `Blocked: ${
                error.reasonCode
                ?? (error.message
                    ? error.message
                    : 'agent_proxy_unavailable')
            }`,
        );
    } finally {
        state.dryCheckPending = false;
        releaseExclusiveOperation('dry-check');
    }
}

globalThis.TavernMnemosyneGenerationInterceptor = async (
    chat,
    _contextSize,
    abort,
    generationType,
) => {
    const forcedAbortReason =
        consumeGenerationAbortReason(state);
    if (forcedAbortReason) {
        const reasonCode = forcedAbortReason;
        clearInjections();
        updateStatus(`Blocked: ${reasonCode}`);
        abort(true);
        return;
    }
    if (!settings().enabled) return;

    const profile = inspectCurrentHostProfile();
    const reasonCode =
        profile.reason_code
        ?? state.blockReason
        ?? (state.contextResponse ? null : 'context_unavailable');
    if (!reasonCode) {
        const context = getContext();
        state.generationHistoryOriginCapture =
            await captureGenerationHistoryOrigin({
                runId: state.runId,
                generationType,
                generationMessages: chat,
                hostHistorySnapshot:
                    snapshotHostHistory(context.chat),
            });
        return;
    }

    clearInjections();
    updateStatus(`Blocked: ${reasonCode}`);
    abort(true);
};

async function runForwardingCheck() {
    if (
        state.lastDryCheck?.status !== 'pass'
        || !state.promptTrace
        || !state.providerMessages
        || !state.forwardingProbeLease
    ) {
        updateStatus('Blocked: run dry check first');
        return;
    }
    if (!claimExclusiveOperation('forwarding-check')) return;

    updateStatus('Running forwarding check');
    try {
        await loadProxyHealth();
        const lease = state.forwardingProbeLease;
        const trace = state.promptTrace;
        const providerMessages = state.providerMessages;
        const currentLeaseInputs = () => {
            const context = getContext();
            return {
                trace: state.promptTrace,
                messages: state.providerMessages,
                hostProfile: inspectCurrentHostProfile(),
                providerBudgetPolicy:
                    state.providerBudgetPolicy,
                chatId: context.chatId,
                hostHistorySnapshot:
                    snapshotHostHistory(context.chat),
                activeRunMarker: state.activeRunMarker,
                runId: state.runId,
            };
        };
        await assertForwardingProbeLease(
            lease,
            currentLeaseInputs(),
        );
        const request = createForwardingProbeRequest({
            proxyBaseUrl: normalizeLoopbackProxyBaseUrl(
                settings().proxyBaseUrl,
            ),
            trace,
            messages: providerMessages,
        });
        await assertForwardingProbeLease(
            lease,
            currentLeaseInputs(),
        );
        const context = getContext();
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify(request),
        });
        const body = await response.json();
        await loadProxyHealth();
        await assertForwardingProbeLease(
            lease,
            currentLeaseInputs(),
        );
        const passed = (
            state.forwardingProbeLease === lease
            && state.promptTrace === trace
            && state.providerMessages === providerMessages
            && forwardingProbeResponsePassed({
                responseOk: response.ok,
                body,
                expectedRunId: trace.run_id,
                expectedVerifiedMessageCount:
                    lease.verified_message_count,
                expectedRetainedMessageCount:
                    lease.retained_message_count,
                expectedProviderBudgetPolicyHash:
                    lease.provider_budget_policy_hash,
                expectedPromptSpineHash:
                    lease.prompt_spine_hash,
            })
        );
        updateStatus(
            passed
                ? 'Forwarding check passed'
                : `Blocked: forwarding ${response.status}`,
        );
    } catch (error) {
        updateStatus(
            `Blocked: ${
                error.reasonCode
                ?? error.message
                ?? 'forwarding_probe_failed'
            }`,
        );
    } finally {
        releaseExclusiveOperation('forwarding-check');
    }
}

function reconcileSummaryText(result) {
    const report = result.reconcile_report ?? {};
    return `保留 ${report.preserved_entity_count ?? 0}、`
        + `新增 ${report.added_entity_count ?? 0}、`
        + `退役 ${report.retired_entity_count ?? 0}`;
}

// The reconcile-approval button only exists while an intake plan is
// actually waiting for the user; every other intake step is automatic.
function syncIntakeApprovalUi() {
    const button = document.querySelector(
        '#tavern_mnemosyne_intake_apply',
    );
    if (!button) return;
    const prepared = state.preparedIntake?.prepared;
    const approval = prepared?.status === 'approval_required';
    button.hidden = !approval;
    if (approval) {
        button.textContent =
            `应用设定合并（${reconcileSummaryText(prepared)}）`;
    }
}

// Drives the click-step intake state machine to a terminal state:
// ready, a reconcile waiting for approval, or a repeated failure.
async function autoRunStaticLoreIntake() {
    if (state.exclusiveOperation !== null) return 'deferred';
    let previousStatus = null;
    let outcome = 'retryable';
    for (let step = 0; step < 24; step += 1) {
        await runStaticLoreIntake();
        const prepared = state.preparedIntake?.prepared;
        if (!prepared) {
            outcome = state.status.startsWith('Blocked:')
                ? 'retryable'
                : 'complete';
            break;
        }
        if (prepared.status === 'approval_required') {
            outcome = 'waiting_for_approval';
            break;
        }
        if (prepared.status === 'reconcile_blocked') break;
        if (
            prepared.status === 'retry_required'
            && previousStatus === 'retry_required'
        ) {
            break;
        }
        previousStatus = prepared.status;
    }
    syncIntakeApprovalUi();
    return outcome;
}

function scheduleAutoStaticLoreIntake(chatId, {
    force = false,
} = {}) {
    void autoStaticLoreIntakeScheduler.schedule(chatId, { force });
}

async function applyPendingIntakeReconcile() {
    const prepared = state.preparedIntake?.prepared;
    if (prepared?.status !== 'approval_required') {
        syncIntakeApprovalUi();
        return;
    }
    // A second step on an approval_required plan applies it, then the
    // driver finishes any remaining batches.
    await runStaticLoreIntake();
    await autoRunStaticLoreIntake();
}

async function runStaticLoreIntake() {
    if (state.intakePending) return;
    if (!claimExclusiveOperation('static-lore-intake')) return;
    state.intakePending = true;
    updateStatus('Preparing intake');
    try {
        await loadProxyHealth();
        const profile = inspectCurrentHostProfile();
        if (profile.status !== 'ready') {
            const error = new Error('The active host profile is not verified.');
            error.reasonCode = profile.reason_code;
            throw error;
        }
        const context = getContext();
        if (!context.chatId) {
            const error = new Error('Open a chat before initializing Static Lore.');
            error.reasonCode = 'chat_id_missing';
            throw error;
        }
        const character = context.characters?.[context.characterId];
        if (!character) {
            const error = new Error('Open a character chat before initializing Static Lore.');
            error.reasonCode = 'character_missing';
            throw error;
        }
        const prepareCurrentSources = async () => {
            const sources = await collectCurrentAuthorSources();
            const hostBinding = currentHostBinding();
            const controlLease = await resolveControlLease();
            const prepared = await currentControlClient().prepareIntake(
                {
                    chat_id: context.chatId,
                    character_id: String(
                        character.avatar
                        ?? context.characterId,
                    ),
                    host_binding: hostBinding,
                    sources,
                },
                { lease: controlLease },
            );
            if (
                ![
                    'prepared',
                    'ready',
                    'retry_required',
                    'approval_required',
                    'reconcile_blocked',
                ].includes(
                    prepared.status,
                )
            ) {
                const error = new Error(
                    prepared?.error?.message
                    ?? 'Static Lore preflight failed.',
                );
                error.reasonCode =
                    prepared?.error?.reason_code
                    ?? 'static_lore_intake_prepare_failed';
                throw error;
            }
            return {
                chatId: context.chatId,
                hostBinding: structuredClone(hostBinding),
                controlLease,
                prepared,
            };
        };
        const showReconcileStatus = result => {
            if (result.status === 'approval_required') {
                updateStatus(
                    `设定合并需要确认：${reconcileSummaryText(result)}`,
                );
                syncIntakeApprovalUi();
                return;
            }
            updateStatus(
                `Blocked: ${result.reason_code ?? 'static_lore_reconcile_blocked'}`,
            );
        };
        if (!state.preparedIntake) {
            const currentIntake = await prepareCurrentSources();
            if (currentIntake.prepared.status === 'ready') {
                updateStatus(
                    `设定导入完成：${currentIntake.prepared.concept_count} 个概念`,
                );
                return;
            }
            if (
                currentIntake.prepared.status === 'approval_required'
                || currentIntake.prepared.status === 'reconcile_blocked'
            ) {
                state.preparedIntake = currentIntake;
                showReconcileStatus(currentIntake.prepared);
                return;
            }
            if (currentIntake.prepared.status === 'retry_required') {
                state.preparedIntake = currentIntake;
                updateStatus(
                    `设定导入批次 ${currentIntake.prepared.batch_index}/`
                    + `${currentIntake.prepared.batch_count} 失败，将重试`,
                );
                return;
            }
            state.preparedIntake = currentIntake;
            const { prepared } = state.preparedIntake;
            updateStatus(
                `设定导入已准备：${prepared.source_unit_count} 个单元、`
                + `${prepared.batch_count} 个批次`,
            );
            return;
        }

        const { prepared } = state.preparedIntake;
        const activeBinding = currentHostBinding();
        if (
            state.preparedIntake.chatId !== context.chatId
            || state.preparedIntake.hostBinding.model
                !== activeBinding.model
        ) {
            state.preparedIntake = null;
            const error = new Error('Static Lore preflight no longer matches the active chat.');
            error.reasonCode = 'static_lore_intake_preflight_stale';
            throw error;
        }
        const refreshedIntake = await prepareCurrentSources();
        if (refreshedIntake.prepared.status === 'ready') {
            state.preparedIntake = null;
            updateStatus(
                `设定导入完成：${refreshedIntake.prepared.concept_count} 个概念`,
            );
            return;
        }
        if (
            prepared.status === 'approval_required'
            || prepared.status === 'reconcile_blocked'
        ) {
            const samePlan = (
                refreshedIntake.prepared.status === prepared.status
                && refreshedIntake.prepared.snapshot_id === prepared.snapshot_id
                && refreshedIntake.prepared.reconcile_plan_id
                    === prepared.reconcile_plan_id
            );
            if (!samePlan) {
                state.preparedIntake = refreshedIntake;
                if (
                    refreshedIntake.prepared.status === 'approval_required'
                    || refreshedIntake.prepared.status === 'reconcile_blocked'
                ) {
                    showReconcileStatus(refreshedIntake.prepared);
                } else {
                    updateStatus('Static Lore sources or intake state changed');
                }
                return;
            }
            if (prepared.status === 'reconcile_blocked') {
                state.preparedIntake = refreshedIntake;
                showReconcileStatus(refreshedIntake.prepared);
                return;
            }
            updateStatus(
                `正在应用设定合并（${reconcileSummaryText(prepared)}）`,
            );
            const confirmed = await currentControlClient()
                .confirmIntakeReconciliation(
                    {
                        chat_id: context.chatId,
                        snapshot_id: prepared.snapshot_id,
                        session_id: prepared.session_id,
                        plan_id: prepared.reconcile_plan_id,
                    },
                    { lease: refreshedIntake.controlLease },
            );
            if (
                confirmed.status === 'reconcile_blocked'
            ) {
                state.preparedIntake = {
                    chatId: context.chatId,
                    hostBinding: structuredClone(activeBinding),
                    controlLease: refreshedIntake.controlLease,
                    prepared: confirmed,
                };
                showReconcileStatus(confirmed);
                return;
            }
            if (confirmed.status !== 'ready') {
                const error = new Error(
                    confirmed?.error?.message
                    ?? 'Static Lore reconcile failed.',
                );
                error.reasonCode =
                    confirmed?.error?.reason_code
                    ?? confirmed?.reason_code
                    ?? 'static_lore_reconcile_confirm_failed';
                throw error;
            }
            state.preparedIntake = null;
            updateStatus(
                `设定合并完成：${confirmed.concept_count} 个概念`,
            );
            return;
        }
        if (prepared.status === 'retry_required') {
            if (
                refreshedIntake.prepared.status !== 'retry_required'
                || refreshedIntake.prepared.snapshot_hash
                    !== prepared.snapshot_hash
            ) {
                state.preparedIntake = refreshedIntake;
                updateStatus('Static Lore sources or intake state changed');
                return;
            }
            updateStatus(
                `正在检查批次 ${prepared.batch_index}/`
                + `${prepared.batch_count} 已保存的结果`,
            );
            const recovered = await currentControlClient().recoverIntake(
                {
                    chat_id: context.chatId,
                    snapshot_id: prepared.snapshot_id,
                    session_id: prepared.session_id,
                },
                { lease: refreshedIntake.controlLease },
            );
            if (
                ![
                    'batch_ready',
                    'ready',
                    'retry_required',
                    'approval_required',
                    'reconcile_blocked',
                ].includes(recovered.status)
            ) {
                const error = new Error(
                    recovered?.error?.message
                    ?? 'Static Lore artifact recovery failed.',
                );
                error.reasonCode =
                    recovered?.error?.reason_code
                    ?? 'static_lore_intake_recovery_failed';
                throw error;
            }
            if (recovered.status === 'batch_ready') {
                state.preparedIntake = {
                    chatId: context.chatId,
                    hostBinding: structuredClone(activeBinding),
                    controlLease: refreshedIntake.controlLease,
                    prepared: recovered.next_batch,
                };
                updateStatus(
                    `已恢复批次 ${recovered.completed_batch_index}/`
                    + `${recovered.batch_count}，累计 `
                    + `${recovered.concept_count_so_far} 个概念`,
                );
                return;
            }
            if (recovered.status === 'ready') {
                state.preparedIntake = null;
                updateStatus(
                    `设定导入完成（使用已保存结果）：`
                    + `${recovered.concept_count} 个概念`,
                );
                return;
            }
            if (
                recovered.status === 'approval_required'
                || recovered.status === 'reconcile_blocked'
            ) {
                state.preparedIntake = {
                    chatId: context.chatId,
                    hostBinding: structuredClone(activeBinding),
                    controlLease: refreshedIntake.controlLease,
                    prepared: recovered,
                };
                showReconcileStatus(recovered);
                return;
            }
            const retryPrepared = await currentControlClient().retryIntake(
                {
                    chat_id: context.chatId,
                    snapshot_id: prepared.snapshot_id,
                    session_id: prepared.session_id,
                },
                { lease: refreshedIntake.controlLease },
            );
            if (retryPrepared.status !== 'prepared') {
                const error = new Error(
                    retryPrepared?.error?.message
                    ?? 'Static Lore retry preparation failed.',
                );
                error.reasonCode =
                    retryPrepared?.error?.reason_code
                    ?? 'static_lore_intake_retry_prepare_failed';
                throw error;
            }
            state.preparedIntake = {
                chatId: context.chatId,
                hostBinding: structuredClone(activeBinding),
                controlLease: refreshedIntake.controlLease,
                prepared: retryPrepared,
            };
            updateStatus(
                `重试已准备：批次 ${retryPrepared.batch_index}/`
                + `${retryPrepared.batch_count}，第 `
                + `${retryPrepared.batch_attempt} 次尝试`,
            );
            return;
        }
        if (refreshedIntake.prepared.status === 'retry_required') {
            state.preparedIntake = refreshedIntake;
            updateStatus(
                `设定导入批次 ${refreshedIntake.prepared.batch_index}/`
                + `${refreshedIntake.prepared.batch_count} 失败，将重试`,
            );
            return;
        }
        if (
            refreshedIntake.prepared.status === 'approval_required'
            || refreshedIntake.prepared.status === 'reconcile_blocked'
        ) {
            state.preparedIntake = refreshedIntake;
            showReconcileStatus(refreshedIntake.prepared);
            return;
        }
        if (refreshedIntake.prepared.snapshot_hash !== prepared.snapshot_hash) {
            state.preparedIntake = refreshedIntake;
            updateStatus(
                `设定来源已变化：${refreshedIntake.prepared.source_unit_count}`
                + ` 个单元、${refreshedIntake.prepared.batch_count} 个批次`,
            );
            return;
        }
        if (refreshedIntake.prepared.request_id !== prepared.request_id) {
            state.preparedIntake = refreshedIntake;
            updateStatus(
                `设定导入继续：批次 `
                + `${refreshedIntake.prepared.batch_index}/`
                + `${refreshedIntake.prepared.batch_count}`,
            );
            return;
        }
        state.preparedIntake = refreshedIntake;
        const stablePrepared = refreshedIntake.prepared;
        const intakeControlLease = refreshedIntake.controlLease;
        updateStatus('Checking model deployment');
        await currentControlClient().inspectUpstreamReadiness(
            {},
            { lease: intakeControlLease },
        );
        updateStatus(
            `设定导入模型调用：批次 ${stablePrepared.batch_index}/`
            + `${stablePrepared.batch_count}（`
            + `${stablePrepared.batch_source_unit_count} 个单元）`,
        );
        state.preparedIntake = null;
        const modelRequest = stablePrepared.model_request;
        const completionResponse = await fetch(
            '/api/backends/chat-completions/generate',
            {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: `${safeProxyBaseUrl()}/v1/mnemosyne/intake`,
                    custom_include_body: JSON.stringify({
                        mnemosyne_intake_request_id: stablePrepared.request_id,
                        mnemosyne_intake_execution_lease:
                            stablePrepared.intake_execution_lease,
                    }),
                    custom_exclude_body: '',
                    custom_include_headers: JSON.stringify({
                        'x-mnemosyne-intake-capability':
                            stablePrepared.intake_capability,
                    }),
                    custom_prompt_post_processing: '',
                    ...modelRequest,
                }),
            },
        );
        const completion = await completionResponse.json();
        if (
            !completionResponse.ok
            || ![
                'batch_ready',
                'ready',
                'approval_required',
                'reconcile_blocked',
            ].includes(
                completion.mnemosyne_intake_result?.status,
            )
        ) {
            const error = new Error(
                completion?.error?.message
                ?? `Static Lore model call failed with status ${completionResponse.status}.`,
            );
            error.reasonCode =
                completion?.error?.reason_code
                ?? 'static_lore_intake_model_failed';
            throw error;
        }
        const result = completion.mnemosyne_intake_result;
        if (
            result.status === 'approval_required'
            || result.status === 'reconcile_blocked'
        ) {
            state.preparedIntake = {
                chatId: context.chatId,
                hostBinding: structuredClone(currentHostBinding()),
                controlLease: intakeControlLease,
                prepared: result,
            };
            showReconcileStatus(result);
            return;
        }
        if (result.status === 'batch_ready') {
            state.preparedIntake = {
                chatId: context.chatId,
                hostBinding: structuredClone(currentHostBinding()),
                controlLease: intakeControlLease,
                prepared: result.next_batch,
            };
            updateStatus(
                `设定导入：批次 ${result.completed_batch_index}/`
                + `${result.batch_count} 完成，累计 `
                + `${result.concept_count_so_far} 个概念`,
            );
            return;
        }
        updateStatus(
            `设定导入完成：${result.concept_count} 个概念`,
        );
    } catch (error) {
        updateStatus(
            `Blocked: ${error.reasonCode ?? error.message}`,
        );
    } finally {
        state.intakePending = false;
        releaseExclusiveOperation('static-lore-intake');
    }
}

async function requireSuccessfulText(response, description) {
    if (!response.ok) {
        const error = new Error(
            `${description} could not be loaded (${response.status}).`,
        );
        error.reasonCode = 'browser_folder_artifact_unavailable';
        throw error;
    }
    return response.text();
}

async function resolveCurrentProvisioningUpstreamUrl(
    presetCustomUrl,
    rootHandle,
) {
    captureCurrentUpstreamConnectionProfile(presetCustomUrl);
    let resolution;
    try {
        resolution = resolveProvisioningUpstreamUrl({
            currentUrl: presetCustomUrl,
            persistedUrl: settings().upstreamCustomUrl,
            runtimeUrl: configuredRuntimeProxyUrl(),
        });
    } catch (error) {
        if (
            error?.reasonCode
                !== 'browser_folder_upstream_url_invalid'
            || !rootHandle
        ) {
            throw error;
        }
        const installed =
            await readInstalledBrowserFolderRuntimeConfig(rootHandle);
        resolution = resolveProvisioningUpstreamUrl({
            currentUrl: presetCustomUrl,
            persistedUrl: settings().upstreamCustomUrl,
            installedRuntimeUrl: installed?.upstreamBaseUrl,
            runtimeUrl: configuredRuntimeProxyUrl(),
        });
    }
    if (resolution.snapshotUrl !== null) {
        settings().upstreamCustomUrl = resolution.snapshotUrl;
        saveSettingsDebounced();
    }
    return resolution.upstreamUrl;
}

async function browserFolderProvisioningInput({
    rootHandle,
} = {}) {
    const preset = getChatCompletionPreset();
    if (
        main_api !== 'openai'
        || preset.chat_completion_source !== 'custom'
    ) {
        const error = new Error(
            '启用前请先选择 Custom (OpenAI-compatible) 连接。',
        );
        error.reasonCode = 'browser_folder_custom_openai_required';
        throw error;
    }
    const [versionResponse, manifestResponse, bootstrapResponse] =
        await Promise.all([
            fetch('/version', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
            }),
            fetch(new URL('./manifest.json', import.meta.url), {
                credentials: 'same-origin',
                cache: 'no-store',
            }),
            fetch(new URL(
                '../../distribution/browser-folder-bootstrap/index.mjs',
                import.meta.url,
            ), {
                credentials: 'same-origin',
                cache: 'no-store',
            }),
        ]);
    if (!versionResponse.ok || !manifestResponse.ok) {
        const error = new Error(
            '无法确认当前 SillyTavern 与扩展版本。',
        );
        error.reasonCode = 'browser_folder_version_attestation_failed';
        throw error;
    }
    const [hostVersion, extensionManifest, bootstrapSource] =
        await Promise.all([
            versionResponse.json(),
            manifestResponse.json(),
            requireSuccessfulText(
                bootstrapResponse,
                'Mnemosyne bootstrap',
            ),
        ]);
    return Object.freeze({
        hostVersion: hostVersion.pkgVersion,
        expectedExtensionVersion: extensionManifest.version,
        runtimeConfig: createBrowserFolderRuntimeConfig({
            upstreamBaseUrl:
                await resolveCurrentProvisioningUpstreamUrl(
                    preset.custom_url,
                    rootHandle,
                ),
            upstreamModel: currentHostBinding().model,
            providerContextTokens:
                Number(oai_settings.openai_max_context),
            providerOutputReserveTokens:
                Number(oai_settings.openai_max_tokens),
        }),
        bootstrapSource,
    });
}

function currentProvisioningOrchestrator() {
    return createProvisioningOrchestrator({
        pageUrl: globalThis.location?.href,
        secureContext: globalThis.isSecureContext,
        showDirectoryPicker:
            typeof globalThis.showDirectoryPicker === 'function'
                ? options => globalThis.showDirectoryPicker(options)
                : undefined,
        loadSavedDirectoryHandle: () => browserFolderHandleStore.load(),
        saveDirectoryHandle: handle =>
            browserFolderHandleStore.save(handle),
        clearSavedDirectoryHandle: () =>
            browserFolderHandleStore.clear(),
        controlClient: currentControlClient(),
        loadBrowserFolderInput: browserFolderProvisioningInput,
    });
}

function bindProvisionedGenerationEndpoint(lease) {
    const capabilities =
        currentControlClient().capabilitiesForLease(lease);
    const mainHostBinding = capabilities.main_host_binding;
    if (
        !mainHostBinding
        || typeof mainHostBinding.model !== 'string'
        || !mainHostBinding.model
    ) {
        const error = new Error(
            '运行时没有提供可验证的模型绑定。',
        );
        error.reasonCode = 'main_host_binding_unavailable';
        throw error;
    }
    const runtimeUrl = capabilities.generation_base_url;
    protectUpstreamConnectionProfile();
    settings().proxyBaseUrl = runtimeUrl.replace(/\/v1$/, '');
    oai_settings.chat_completion_source = 'custom';
    oai_settings.custom_url = runtimeUrl;
    oai_settings.custom_model = mainHostBinding.model;
    const mainApiSelect = document.querySelector('#main_api');
    const sourceSelect = document.querySelector(
        '#chat_completion_source',
    );
    const customUrlInput = document.querySelector(
        '#custom_api_url_text',
    );
    const customModelInput = document.querySelector('#custom_model_id');
    if (mainApiSelect) mainApiSelect.value = 'openai';
    if (sourceSelect) sourceSelect.value = 'custom';
    if (customUrlInput) customUrlInput.value = runtimeUrl;
    if (customModelInput) customModelInput.value = mainHostBinding.model;
    changeMainAPI('openai');
    document.querySelector('#api_button_openai')?.click();
    state.mainHostBinding = mainHostBinding;
}

function settleProvisioningReady({
    statusElement,
    lease,
}) {
    bindProvisionedGenerationEndpoint(lease);
    const current = settings();
    current.enabled = true;
    current.provisioningPending = false;
    current.sessionToken = '';
    saveSettingsDebounced();
    const enabled = document.querySelector('#tavern_mnemosyne_enabled');
    if (enabled) enabled.checked = true;
    statusElement.textContent = 'Mnemosyne 已就绪。';
    statusElement.dataset.kind = 'ok';
    updateStatus('Ready');
    scheduleAutoStaticLoreIntake(
        getContext().chatId ?? null,
        { force: true },
    );
}

async function resumeProvisioningVerification({
    statusElement,
}) {
    const current = settings();
    const pendingRestart = current.provisioningPending;
    const enableRequested = pendingRestart || current.enabled;
    statusElement.textContent = pendingRestart
        ? '等待 SillyTavern 重启；重启后会自动完成健康验证。'
        : '正在自动检查运行状态…';
    statusElement.dataset.kind = 'pending';
    try {
        const inspected =
            await currentProvisioningOrchestrator().inspect();
        if (inspected.status === 'ready') {
            if (enableRequested) {
                settleProvisioningReady({
                    statusElement,
                    lease: inspected.lease,
                });
            } else {
                statusElement.textContent =
                    '运行组件已部署；运行开关当前关闭。';
                statusElement.dataset.kind = 'ok';
            }
            return;
        }
        if (!pendingRestart) {
            if (current.enabled) {
                current.enabled = false;
                const enabled =
                    document.querySelector('#tavern_mnemosyne_enabled');
                if (enabled) enabled.checked = false;
                saveSettingsDebounced();
            }
            statusElement.textContent =
                '尚未部署；打开运行开关会自动完成部署。';
            statusElement.dataset.kind = 'idle';
            updateStatus('Disabled');
            return;
        }
        void currentProvisioningOrchestrator().verify({
            timeoutMs: 10 * 60 * 1_000,
            intervalMs: 2_000,
        }).then(verified => {
            if (!settings().provisioningPending) return;
            settleProvisioningReady({
                statusElement,
                lease: verified.lease,
            });
        }).catch(() => {
            if (!settings().provisioningPending) return;
            statusElement.textContent =
                '等待 SillyTavern 重启；重启后会继续自动检查。';
            statusElement.dataset.kind = 'pending';
        });
    } catch (error) {
        statusElement.textContent = pendingRestart
            ? '等待 SillyTavern 重启；重启后会继续自动检查。'
            : `自动检查失败：${provisioningFailureText(error)}`;
        statusElement.dataset.kind = 'error';
        updateStatus('Unavailable');
    }
}

const PROVISIONING_ERROR_MESSAGES = Object.freeze({
    browser_folder_custom_openai_required:
        '请先在 API 连接页选择 Custom (OpenAI-compatible) 并填入上游服务地址。',
    browser_folder_upstream_url_invalid:
        '未找到真实的上游服务地址。请在 API 连接页填入你的 Custom OpenAI 端点后重试。',
    browser_folder_upstream_model_missing:
        '请先在 API 连接页选择模型。',
    browser_folder_provider_budget_invalid:
        '请检查上下文长度与回复长度设置后重试。',
    browser_folder_permission_not_granted:
        '未获得文件夹读写授权。请重试，并在浏览器弹窗中允许访问。',
    browser_folder_version_attestation_failed:
        '无法确认 SillyTavern 版本，请刷新页面后重试。',
    browser_folder_artifact_unavailable:
        '扩展安装包不完整，请重新安装扩展后重试。',
    browser_folder_extension_install_not_found:
        '所选文件夹中没有当前扩展。请确认选择的是正在运行的 SillyTavern 根文件夹。',
    browser_folder_runtime_config_invalid:
        '现有运行时配置已损坏。请在 API 连接页重新填写上游地址后重试。',
    mnemosyne_provisioning_unsupported:
        '当前部署方式暂不支持一键启用。',
    main_host_binding_unavailable:
        '运行时尚未就绪，请稍后重试。',
    mnemosyne_provisioning_verification_failed:
        '安装后未检测到健康运行时。请完成一次 SillyTavern 重启后再试。',
});

function provisioningFailureText(error) {
    if (error?.name === 'AbortError') return '已取消。';
    if (error?.name === 'NotFoundError') {
        return '安装目录内容不完整或已移动。请重新打开运行开关并选择当前 SillyTavern 文件夹。';
    }
    if (
        error?.name === 'NotAllowedError'
        || error?.name === 'SecurityError'
    ) {
        return '浏览器没有获得文件夹读写权限。请重新打开运行开关并允许访问。';
    }
    const message = PROVISIONING_ERROR_MESSAGES[error?.reasonCode];
    if (message) return message;
    console.error('[Mnemosyne] provisioning failed', error);
    return '启用未完成，请重试。';
}

async function enableMnemosyneFromProvisioningCard({
    statusElement,
}) {
    statusElement.dataset.kind = 'pending';
    statusElement.textContent = '正在自动检查并准备运行组件…';
    try {
        const result = await currentProvisioningOrchestrator().enable({
            onPlan: async () => {
                statusElement.textContent =
                    '已验证目录，正在写入自包含运行时…';
                await new Promise(resolve => {
                    globalThis.requestAnimationFrame?.(
                        () => resolve(),
                    ) ?? resolve();
                });
            },
        });
        if (result.status === 'ready') {
            settleProvisioningReady({
                statusElement,
                lease: result.lease,
            });
            return;
        }
        if (result.status !== 'restart_required') {
            throw new Error(
                `Unexpected provisioning status: ${result.status}`,
            );
        }
        settings().sessionToken = '';
        settings().enabled = false;
        settings().provisioningPending = true;
        saveSettingsDebounced();
        statusElement.textContent =
            '安装完成。请重启一次 SillyTavern；本页会自动检测。';
        statusElement.dataset.kind = 'pending';
        void currentProvisioningOrchestrator().verify({
            timeoutMs: 10 * 60 * 1_000,
            intervalMs: 2_000,
        }).then(verified => {
            settleProvisioningReady({
                statusElement,
                lease: verified.lease,
            });
        }).catch(() => {
            statusElement.textContent =
                '等待 SillyTavern 重启；重启后会继续自动检查。';
            statusElement.dataset.kind = 'pending';
        });
    } catch (error) {
        statusElement.textContent =
            `启用失败：${provisioningFailureText(error)}`;
        statusElement.dataset.kind = 'error';
        const current = settings();
        current.enabled = false;
        current.provisioningPending = false;
        const enabled =
            document.querySelector('#tavern_mnemosyne_enabled');
        if (enabled) enabled.checked = false;
        saveSettingsDebounced();
    }
}

function addSettingsUi() {
    if (document.querySelector('#tavern_mnemosyne_settings')) return;

    const container = document.createElement('div');
    container.id = 'tavern_mnemosyne_settings';
    container.className = 'extension_container';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Tavern Mnemosyne</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="mnemosyne-provisioning-panel">
                    <b>运行与部署</b>
                    <small>
                        首次部署时请打开运行开关，并在弹窗中选择
                        SillyTavern 安装目录。插件会自动完成部署和后续检查。
                    </small>
                    <span
                        id="tavern_mnemosyne_provisioning_status"
                        class="mnemosyne-provisioning-status"
                    >正在自动检查运行状态…</span>
                </div>
                <label class="checkbox_label">
                    <input id="tavern_mnemosyne_enabled" type="checkbox">
                    <span>Mnemosyne 运行开关</span>
                </label>
                <details class="mnemosyne-advanced-loopback">
                    <summary>高级：现有 loopback / Termux 兼容设置</summary>
                    <div class="mnemosyne-setting-row">
                        <label for="tavern_mnemosyne_proxy_url">Agent Proxy</label>
                        <input id="tavern_mnemosyne_proxy_url" type="url" spellcheck="false">
                    </div>
                    <div class="mnemosyne-setting-row">
                        <label for="tavern_mnemosyne_session_token">Session token</label>
                        <input
                            id="tavern_mnemosyne_session_token"
                            type="password"
                            autocomplete="off"
                            spellcheck="false"
                        >
                    </div>
                </details>
                <div class="mnemosyne-status-row">
                    <span id="tavern_mnemosyne_status" class="mnemosyne-status">已关闭</span>
                    <button
                        id="tavern_mnemosyne_intake_apply"
                        class="menu_button"
                        type="button"
                        hidden
                    >应用设定合并</button>
                </div>
                <details class="mnemosyne-feedback-panel">
                    <summary>真实使用反馈</summary>
                    <label class="checkbox_label">
                        <input
                            id="tavern_mnemosyne_feedback_enabled"
                            type="checkbox"
                        >
                        <span>记录真实使用反馈（仅保存在本机）</span>
                    </label>
                    <div class="mnemosyne-feedback-actions">
                        <button
                            id="tavern_mnemosyne_feedback_export"
                            class="menu_button"
                            type="button"
                        >导出反馈数据</button>
                        <button
                            id="tavern_mnemosyne_feedback_withdraw"
                            class="menu_button"
                            type="button"
                        >撤回最近一条</button>
                    </div>
                    <span
                        id="tavern_mnemosyne_feedback_status"
                        class="mnemosyne-feedback-status"
                    >反馈未开启</span>
                </details>
                <div class="mnemosyne-activity-panel">
                    <b>每轮活动</b>
                    <div class="mnemosyne-activity-actions">
                        <button
                            id="tavern_mnemosyne_activity_open"
                            class="menu_button"
                            type="button"
                        >查看每轮活动</button>
                        <button
                            id="tavern_mnemosyne_activity_refresh"
                            class="menu_button"
                            type="button"
                            hidden
                        >刷新</button>
                    </div>
                    <div
                        id="tavern_mnemosyne_activity_panel"
                        class="mnemosyne-activity-results"
                        hidden
                    >
                        <span
                            id="tavern_mnemosyne_activity_status"
                            class="mnemosyne-activity-status"
                        >尚未查看。</span>
                        <div
                            id="tavern_mnemosyne_activity_entries"
                            class="mnemosyne-activity-entries"
                        ></div>
                    </div>
                </div>
            </div>
        </div>`;

    document.querySelector('#extensions_settings')?.append(container);

    const current = settings();
    const enabled = container.querySelector('#tavern_mnemosyne_enabled');
    const proxyBaseUrl = container.querySelector('#tavern_mnemosyne_proxy_url');
    const sessionToken = container.querySelector('#tavern_mnemosyne_session_token');
    const feedbackEnabled = container.querySelector(
        '#tavern_mnemosyne_feedback_enabled',
    );
    const provisioningStatus = container.querySelector(
        '#tavern_mnemosyne_provisioning_status',
    );
    enabled.checked =
        current.enabled || current.provisioningPending;
    proxyBaseUrl.value = current.proxyBaseUrl;
    sessionToken.value = current.sessionToken;
    feedbackEnabled.checked =
        current.realUseFeedbackEnabled === true;
    updateStatus(current.enabled ? 'Checking' : 'Disabled');
    realUseFeedbackController.setEnabled(
        current.realUseFeedbackEnabled === true,
    );

    enabled.addEventListener('change', () => {
        if (!enabled.checked) {
            current.enabled = false;
            current.provisioningPending = false;
            clearInjections();
            updateStatus('Disabled');
            provisioningStatus.textContent =
                '运行开关已关闭；自动检查不会修改部署。';
            provisioningStatus.dataset.kind = 'idle';
            saveSettingsDebounced();
        } else {
            current.enabled = false;
            saveSettingsDebounced();
            void enableMnemosyneFromProvisioningCard({
                statusElement: provisioningStatus,
            });
        }
    });
    proxyBaseUrl.addEventListener('input', () => {
        current.proxyBaseUrl = proxyBaseUrl.value.trim();
        saveSettingsDebounced();
    });
    sessionToken.addEventListener('input', () => {
        current.sessionToken = sessionToken.value.trim();
        saveSettingsDebounced();
    });
    feedbackEnabled.addEventListener('change', () => {
        current.realUseFeedbackEnabled =
            feedbackEnabled.checked;
        realUseFeedbackController.setEnabled(
            current.realUseFeedbackEnabled,
        );
        saveSettingsDebounced();
    });
    void resumeProvisioningVerification({
        statusElement: provisioningStatus,
    });
    container.querySelector('#tavern_mnemosyne_intake_apply')
        ?.addEventListener('click', () => {
            void applyPendingIntakeReconcile();
        });
    container.querySelector('#tavern_mnemosyne_feedback_export')
        ?.addEventListener(
            'click',
            () => exportDeidentifiedRealUseFeedback(),
        );
    container.querySelector('#tavern_mnemosyne_feedback_withdraw')
        ?.addEventListener(
            'click',
            () => withdrawRecentRealUseFeedback(),
        );
    container.querySelector('#tavern_mnemosyne_activity_open')
        ?.addEventListener('click', () => {
            if (runActivityController.snapshot().open) {
                runActivityController.close();
                return;
            }
            void runActivityController.open({
                chatId: getContext().chatId ?? null,
            });
        });
    container.querySelector('#tavern_mnemosyne_activity_refresh')
        ?.addEventListener('click', () => {
            void runActivityController.refresh({
                chatId: getContext().chatId ?? null,
            });
        });
    container.querySelector('.inline-drawer-toggle')?.addEventListener('click', () => {
        container.querySelector('.inline-drawer-content')?.classList.toggle('open');
    });
    syncRealUseFeedbackUi();
    syncRunActivityUi();
}

eventSource.on(
    event_types.GENERATION_AFTER_COMMANDS,
    onGenerationStarted,
);
eventSource.on(event_types.WORLDINFO_SCAN_DONE, onWorldInfoScanDone);
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
if (typeof eventSource.makeLast === 'function') {
    eventSource.makeLast(
        event_types.CHAT_COMPLETION_SETTINGS_READY,
        onSettingsReady,
    );
} else {
    eventSource.on(
        event_types.CHAT_COMPLETION_SETTINGS_READY,
        onSettingsReady,
    );
}
eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
eventSource.on(event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
eventSource.on(event_types.CHAT_LOADED, onChatChanged);
eventSource.on(event_types.MESSAGE_SENT, onHostMessageSent);
eventSource.on(event_types.MESSAGE_RECEIVED, onHostMessageReceived);
eventSource.on(event_types.MESSAGE_EDITED, onHostMessageEdited);
eventSource.on(event_types.MESSAGE_UPDATED, onHostMessageEdited);
eventSource.on(
    event_types.CONNECTION_PROFILE_UPDATED,
    protectUpstreamConnectionProfile,
);

settings();
protectUpstreamConnectionProfile();
installPreSquashCapture();
clearInjections();
refreshChatSnapshot();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addSettingsUi, { once: true });
} else {
    addSettingsUi();
}
