import {
  answersForRealUseQuickAnswer,
  buildRealUseFeedbackCommand,
  buildRealUseFeedbackExportRequest,
  buildRealUseFeedbackPrepareRequest,
  buildRealUseFeedbackWithdrawCommand,
  validateRealUseFeedbackQuestionnaire,
} from './real-use-feedback.js';
import { censusMark } from './gate-census.js';

const LOCAL_FEEDBACK_CONSENT = Object.freeze({
  storage: 'local_only',
  acknowledged_not_story_memory: true,
  acknowledged_no_automatic_upload: true,
});
const EXPORT_CONSENT = Object.freeze({
  schema: 'mnemosyne.feedback-export-consent.v1',
  acknowledged_explicit_export: true,
  acknowledged_no_automatic_upload: true,
  acknowledged_deidentified_not_anonymous: true,
});

function controllerError(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

function normalizeRunReference(input) {
  if (
    input
    && Object.keys(input).length === 2
    && Object.hasOwn(input, 'chat_id')
    && Object.hasOwn(input, 'run_id')
  ) {
    return buildRealUseFeedbackPrepareRequest({
      chatId: input.chat_id,
      runId: input.run_id,
    });
  }
  return buildRealUseFeedbackPrepareRequest(input);
}

function sameRun(left, right) {
  return Boolean(
    left
    && right
    && left.chat_id === right.chat_id
    && left.run_id === right.run_id,
  );
}

function initialState() {
  return {
    enabled: false,
    pendingCompletedRun: null,
    resolvedRun: null,
    recentRun: null,
    prepared: null,
    lastFeedback: null,
    panelOpen: false,
    status: '反馈未开启',
    statusKind: 'idle',
  };
}

export function createRealUseFeedbackController({
  post,
  download,
  createId,
  onChange = () => {},
}) {
  if (
    typeof post !== 'function'
    || typeof download !== 'function'
    || typeof createId !== 'function'
    || typeof onChange !== 'function'
  ) {
    throw new TypeError(
      'Real-use feedback controller dependencies are invalid.',
    );
  }

  const state = initialState();

  function snapshot() {
    return structuredClone(state);
  }

  function notify() {
    try {
      onChange(snapshot());
    } catch {
      // Rendering failures cannot affect story or feedback state.
    }
  }

  function setStatus(value, kind = 'idle') {
    state.status = value;
    state.statusKind = kind;
    notify();
  }

  const FAILURE_TEXT = Object.freeze({
    real_use_feedback_disabled: '请先开启反馈记录。',
    real_use_feedback_target_unavailable: '暂无可评价的回复。',
    real_use_feedback_target_changed: '回复已变化，请重新打开评价。',
    feedback_case_unavailable: '这条回复已不能再评价。',
    real_use_feedback_case_unavailable: '请先打开评价窗口。',
    real_use_feedback_withdraw_unavailable: '没有可撤回的反馈。',
    real_use_feedback_chat_unavailable: '请先打开一个聊天。',
    feedback_export_empty: '还没有可导出的反馈。',
  });

  function fail(error) {
    const reasonCode =
      error?.reasonCode
      ?? 'real_use_feedback_failed';
    censusMark('REAL_USE_FEEDBACK_CONTROLLER', 'blocked', { reasonCode });
    const text = FAILURE_TEXT[reasonCode];
    if (!text) {
      console.warn('[Mnemosyne] feedback failed:', reasonCode, error);
    }
    setStatus(text ?? '反馈暂时不可用。', 'error');
    return {
      ok: false,
      reason_code: reasonCode,
    };
  }

  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw controllerError(
        'real_use_feedback_setting_invalid',
        'Real-use feedback enabled must be boolean.',
      );
    }
    state.enabled = enabled;
    state.panelOpen = false;
    if (!enabled) state.prepared = null;
    state.status = enabled
      ? (
          state.recentRun
            ? '最近一条回复可以评价。'
            : '暂无可评价的回复。'
        )
      : '反馈未开启';
    state.statusKind = 'idle';
    notify();
  }

  function captureCompletedOwnedRun(input) {
    const run = normalizeRunReference(input);
    if (
      sameRun(state.recentRun, run)
      || sameRun(state.resolvedRun, run)
    ) {
      state.pendingCompletedRun = null;
      notify();
      return structuredClone(run);
    }
    state.pendingCompletedRun = Object.freeze(run);
    notify();
    return structuredClone(run);
  }

  function resolveOwnedReplyRun({
    chatId,
    liveRunId = null,
  }) {
    let resolved = null;
    if (liveRunId !== null) {
      resolved = buildRealUseFeedbackPrepareRequest({
        chatId,
        runId: liveRunId,
      });
    } else if (
      state.pendingCompletedRun?.chat_id === chatId
    ) {
      resolved =
        structuredClone(state.pendingCompletedRun);
      state.pendingCompletedRun = null;
    }
    if (!resolved) return null;
    state.resolvedRun = Object.freeze(
      structuredClone(resolved),
    );
    notify();
    return resolved;
  }

  function rememberGovernedReply(input) {
    const run = normalizeRunReference(input);
    state.pendingCompletedRun = null;
    state.resolvedRun = Object.freeze(
      structuredClone(run),
    );
    state.recentRun = Object.freeze(run);
    state.prepared = null;
    state.panelOpen = false;
    state.status = state.enabled
      ? '最近一条回复可以评价。'
      : '反馈未开启';
    state.statusKind = 'idle';
    notify();
  }

  function clearForHistoryMutation({
    clearLastFeedback = false,
  } = {}) {
    state.pendingCompletedRun = null;
    state.resolvedRun = null;
    state.recentRun = null;
    state.prepared = null;
    state.panelOpen = false;
    if (clearLastFeedback) state.lastFeedback = null;
    state.status = state.enabled
      ? '暂无可评价的回复。'
      : '反馈未开启';
    state.statusKind = 'idle';
    notify();
  }

  async function prepare() {
    try {
      if (!state.enabled) {
        throw controllerError(
          'real_use_feedback_disabled',
          'Real-use feedback is disabled.',
        );
      }
      const recentRun = state.recentRun;
      if (!recentRun) {
        throw controllerError(
          'real_use_feedback_target_unavailable',
          '暂无可评价的回复。',
        );
      }
      setStatus('正在准备评价…');
      const result = await post(
        '/v1/mnemosyne/evaluation/prepare',
        structuredClone(recentRun),
      );
      if (
        !state.enabled
        || state.recentRun !== recentRun
      ) {
        throw controllerError(
          'real_use_feedback_target_changed',
          'The governed reply changed while preparing feedback.',
        );
      }
      if (
        result?.case_status === 'answered'
        && result?.active_feedback
      ) {
        const lastFeedback = Object.freeze({
          feedback_id: result.active_feedback.feedback_id,
          feedback_hash: result.active_feedback.feedback_hash,
          chat_id: recentRun.chat_id,
        });
        buildRealUseFeedbackWithdrawCommand({
          commandId: 'feedback-reference-validation',
          chatId: lastFeedback.chat_id,
          feedbackId: lastFeedback.feedback_id,
          feedbackHash: lastFeedback.feedback_hash,
        });
        state.lastFeedback = lastFeedback;
        state.recentRun = null;
        state.prepared = null;
        state.panelOpen = false;
        setStatus(
          '这条回复已评价过，可以撤回。',
          'success',
        );
        return { ok: true, status: 'answered' };
      }
      if (result?.case_status !== 'prepared') {
        throw controllerError(
          'feedback_case_unavailable',
          'The evaluation case is no longer open for feedback.',
        );
      }
      const questionnaire =
        validateRealUseFeedbackQuestionnaire(
          result.questionnaire,
        );
      const prepared = Object.freeze({
        chatId: recentRun.chat_id,
        caseId: result.case_id,
        receiptHash: result?.receipt?.receipt_hash,
        questionnaire,
      });
      const allClear =
        questionnaire.presentation.quick_answers.find(
          quickAnswer => quickAnswer.strategy === 'all_clear',
        );
      buildRealUseFeedbackCommand({
        commandId: 'feedback-receipt-validation',
        chatId: prepared.chatId,
        caseId: prepared.caseId,
        receiptHash: prepared.receiptHash,
        questionnaire: prepared.questionnaire,
        consent: LOCAL_FEEDBACK_CONSENT,
        answers: answersForRealUseQuickAnswer(
          questionnaire,
          allClear.value,
        ),
      });
      state.prepared = prepared;
      state.panelOpen = true;
      setStatus('请选择你的评价。');
      return { ok: true, status: 'prepared' };
    } catch (error) {
      return fail(error);
    }
  }

  async function submit({
    quickAnswer,
    facet = null,
  }) {
    try {
      if (!state.enabled) {
        throw controllerError(
          'real_use_feedback_disabled',
          'Real-use feedback is disabled.',
        );
      }
      const prepared = state.prepared;
      if (!prepared) {
        throw controllerError(
          'real_use_feedback_case_unavailable',
          'Prepare the latest governed reply before answering.',
        );
      }
      const definition =
        prepared.questionnaire.presentation.quick_answers.find(
          candidate => candidate.value === quickAnswer,
        );
      const answers = answersForRealUseQuickAnswer(
        prepared.questionnaire,
        quickAnswer,
        definition?.requires_facet
          ? { facet }
          : undefined,
      );
      const command = buildRealUseFeedbackCommand({
        commandId: createId(),
        chatId: prepared.chatId,
        caseId: prepared.caseId,
        receiptHash: prepared.receiptHash,
        questionnaire: prepared.questionnaire,
        consent: LOCAL_FEEDBACK_CONSENT,
        answers,
      });
      const result = await post(
        '/v1/mnemosyne/evaluation/feedback',
        command,
      );
      if (state.prepared !== prepared) {
        setStatus(
          '已记录到此前的聊天。',
          'success',
        );
        return {
          ok: true,
          status: 'recorded_for_previous_target',
          feedback: {
            feedback_id: result?.feedback_id,
            feedback_hash: result?.feedback_hash,
            chat_id: prepared.chatId,
          },
        };
      }
      const lastFeedback = Object.freeze({
        feedback_id: result?.feedback_id,
        feedback_hash: result?.feedback_hash,
        chat_id: prepared.chatId,
      });
      buildRealUseFeedbackWithdrawCommand({
        commandId: 'feedback-reference-validation',
        chatId: lastFeedback.chat_id,
        feedbackId: lastFeedback.feedback_id,
        feedbackHash: lastFeedback.feedback_hash,
      });
      state.lastFeedback = lastFeedback;
      state.pendingCompletedRun = null;
      state.recentRun = null;
      state.prepared = null;
      state.panelOpen = false;
      setStatus(
        '已记录（仅保存在本机）。',
        'success',
      );
      return {
        ok: true,
        status: 'recorded',
        feedback: structuredClone(lastFeedback),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function withdraw() {
    try {
      const lastFeedback = state.lastFeedback;
      if (!lastFeedback) {
        throw controllerError(
          'real_use_feedback_withdraw_unavailable',
          'No recent feedback is available to withdraw.',
        );
      }
      const command = buildRealUseFeedbackWithdrawCommand({
        commandId: createId(),
        chatId: lastFeedback.chat_id,
        feedbackId: lastFeedback.feedback_id,
        feedbackHash: lastFeedback.feedback_hash,
      });
      await post(
        '/v1/mnemosyne/evaluation/feedback',
        command,
      );
      if (state.lastFeedback === lastFeedback) {
        state.lastFeedback = null;
      }
      setStatus(
        '最近一条反馈已撤回。',
        'success',
      );
      return { ok: true, status: 'withdrawn' };
    } catch (error) {
      return fail(error);
    }
  }

  async function exportDeidentified({ chatId }) {
    try {
      if (!chatId) {
        throw controllerError(
          'real_use_feedback_chat_unavailable',
          'Open a chat before exporting feedback.',
        );
      }
      const request = buildRealUseFeedbackExportRequest({
        exportId: createId(),
        chatId,
        consent: EXPORT_CONSENT,
      });
      const bundle = await post(
        '/v1/mnemosyne/evaluation/export',
        request,
      );
      download(bundle);
      setStatus(
        `已导出 ${
          Array.isArray(bundle?.records)
            ? bundle.records.length
            : 0
        } 条去识别记录。`,
        'success',
      );
      return { ok: true, status: 'exported' };
    } catch (error) {
      return fail(error);
    }
  }

  return Object.freeze({
    snapshot,
    setEnabled,
    captureCompletedOwnedRun,
    resolveOwnedReplyRun,
    rememberGovernedReply,
    clearForHistoryMutation,
    prepare,
    submit,
    withdraw,
    exportDeidentified,
  });
}
