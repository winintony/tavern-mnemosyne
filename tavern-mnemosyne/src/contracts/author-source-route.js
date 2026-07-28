const SOURCE_LABELS_BY_IDENTIFIER = new Map([
  ['worldInfoBefore', 'raw_worldbook'],
  ['worldInfoAfter', 'raw_worldbook'],
  ['charDescription', 'raw_character_card'],
  ['charPersonality', 'raw_character_card'],
  ['scenario', 'raw_scenario'],
  ['personaDescription', 'raw_persona'],
]);

const WORLD_INFO_DEPTH_IDENTIFIER = /^customDepthWI_\d+_[012]$/;

export function sourceLabelForPromptIdentifier(identifier) {
  const normalized = String(identifier ?? '');
  if (WORLD_INFO_DEPTH_IDENTIFIER.test(normalized)) {
    return 'raw_worldbook';
  }
  return SOURCE_LABELS_BY_IDENTIFIER.get(normalized) ?? null;
}

export function isWorldInfoDepthIdentifier(identifier) {
  return WORLD_INFO_DEPTH_IDENTIFIER.test(String(identifier ?? ''));
}
