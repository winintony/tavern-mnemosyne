export const SUBJECTIVE_FEEDBACK_NOTE_LIMIT = 2_000;
export const SUBJECTIVE_FEEDBACK_NOTES_KEY =
  'tavern_mnemosyne_subjective_notes';

function notesFor(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new TypeError('Chat metadata is unavailable.');
  }
  const value = metadata[SUBJECTIVE_FEEDBACK_NOTES_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('Subjective feedback notes are invalid.');
  }
  return value;
}

export function appendSubjectiveFeedbackNote(metadata, {
  chatId,
  caseId,
  verdict,
  facet,
  text,
  createId,
  now,
}) {
  const normalizedText = String(text ?? '').trim();
  if (
    !normalizedText
    || normalizedText.length > SUBJECTIVE_FEEDBACK_NOTE_LIMIT
    || typeof createId !== 'function'
    || typeof now !== 'function'
  ) {
    throw new TypeError('Subjective feedback note is invalid.');
  }
  const notes = notesFor(metadata);
  const note = {
    note_id: createId(),
    recorded_at: now(),
    chat_id: chatId,
    case_id: caseId ?? null,
    feedback_id: null,
    verdict: verdict ?? null,
    facet: facet ?? null,
    text: normalizedText,
  };
  metadata[SUBJECTIVE_FEEDBACK_NOTES_KEY] = [...notes, note];
  return note;
}

export function bindSubjectiveFeedbackNote(
  metadata,
  noteId,
  feedbackId,
) {
  const note = notesFor(metadata).find(
    candidate => candidate?.note_id === noteId,
  );
  if (!note || !feedbackId) return false;
  note.feedback_id = feedbackId;
  return true;
}

export function removeSubjectiveFeedbackNotes(
  metadata,
  {
    noteId = null,
    feedbackId = null,
  },
) {
  const notes = notesFor(metadata);
  const retained = notes.filter(note => (
    (noteId === null || note?.note_id !== noteId)
    && (
      feedbackId === null
      || note?.feedback_id !== feedbackId
    )
  ));
  metadata[SUBJECTIVE_FEEDBACK_NOTES_KEY] = retained;
  return notes.length - retained.length;
}
