export const OKF_TYPE_DIRECTORIES = Object.freeze({
  character: 'characters',
  character_cognition: 'character-cognition',
  relationship: 'relationships',
  scene_event: 'events',
  continuity_state: 'state-changes',
  world_lore: 'world-lore',
  plot_thread: 'plot-threads',
  scene_state: 'scenes',
  source_note: 'sources',
});

export const CORE_RELATION_DEFINITIONS = Object.freeze([
  { id: 'involves', status: 'core', description: 'Involves an entity or concept.' },
  { id: 'about', status: 'core', description: 'Concerns an entity, event, or state.' },
  { id: 'caused_by', status: 'core', description: 'Was caused by another concept.' },
  { id: 'affects', status: 'core', description: 'Affects another concept.' },
  { id: 'supports', status: 'core', description: 'Supports another claim or concept.' },
  { id: 'contradicts', status: 'core', description: 'Contradicts another claim or concept.' },
  { id: 'resolves', status: 'core', description: 'Resolves an obligation or question.' },
  { id: 'blocks', status: 'core', description: 'Blocks an action, goal, or thread.' },
  { id: 'foreshadows', status: 'core', description: 'Foreshadows a later concept.' },
  { id: 'pays_off', status: 'core', description: 'Pays off an earlier setup.' },
  { id: 'located_at', status: 'core', description: 'Is located at another concept.' },
  { id: 'depends_on', status: 'core', description: 'Depends on another rule or fact.' },
]);

export const OKF_ENTITY_PREFIXES = Object.freeze({
  character: 'char',
  character_cognition: 'cmem',
  relationship: 'rel',
  scene_event: 'event',
  continuity_state: 'state',
  world_lore: 'lore',
  plot_thread: 'thread',
  scene_state: 'scene',
  source_note: 'source',
});
