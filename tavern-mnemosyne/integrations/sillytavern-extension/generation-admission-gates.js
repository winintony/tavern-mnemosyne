export async function runGenerationAdmissionGates({
  isEnabled,
  dryRun,
  resolveHistoryInvalidation,
  ensureStaticLoreReady,
} = {}) {
  if (
    typeof isEnabled !== 'function'
    || typeof dryRun !== 'boolean'
    || typeof resolveHistoryInvalidation !== 'function'
    || typeof ensureStaticLoreReady !== 'function'
  ) {
    throw new TypeError(
      'Generation admission gate dependencies are invalid.',
    );
  }

  let historyReason = null;
  try {
    historyReason =
      await resolveHistoryInvalidation();
  } catch (error) {
    historyReason =
      error?.reasonCode
      ?? 'history_edit_reconciliation_failed';
  }

  if (!isEnabled()) {
    return Object.freeze({
      status: 'disabled',
      gate: null,
      reasonCode: null,
    });
  }
  if (historyReason) {
    return Object.freeze({
      status: 'blocked',
      gate: 'history',
      reasonCode: historyReason,
    });
  }
  if (dryRun === false) {
    const intakeReason =
      await ensureStaticLoreReady();
    if (intakeReason) {
      return Object.freeze({
        status: 'blocked',
        gate: 'intake',
        reasonCode: intakeReason,
      });
    }
  }
  return Object.freeze({
    status: 'ready',
    gate: null,
    reasonCode: null,
  });
}
