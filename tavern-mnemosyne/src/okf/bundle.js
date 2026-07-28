import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';

import { MnemosyneRequestError } from '../contracts/errors.js';
import {
  CORE_RELATION_DEFINITIONS,
  OKF_ENTITY_PREFIXES,
  OKF_TYPE_DIRECTORIES,
} from './schema.js';

const REQUIRED_FIELDS = [
  'type',
  'title',
  'timestamp',
  'entity_id',
  'slug',
  'aliases',
  'status',
  'source_refs',
  'links',
];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_REF_PATTERN = /^(?:chat|edit|worldinfo|character-card|persona|scenario|static-lore|external):\/\/\S+$/;

function fail(reasonCode, message, details) {
  throw new MnemosyneRequestError(reasonCode, message, details);
}

export function serializeOkfConcept({ frontmatter, body }) {
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    fail('okf_frontmatter_invalid', 'OKF frontmatter must be an object.');
  }
  if (typeof body !== 'string' || !body.trim()) {
    fail('okf_body_invalid', 'OKF concept body must be a non-empty string.');
  }

  return [
    '---',
    stringify(frontmatter).trimEnd(),
    '---',
    body.trimEnd(),
    '',
  ].join('\n');
}

export function parseOkfConcept(source, { conceptPath = null } = {}) {
  if (typeof source !== 'string') {
    fail('okf_document_invalid', 'OKF concept must be UTF-8 text.', { path: conceptPath });
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    fail('okf_frontmatter_missing', 'OKF concept requires YAML frontmatter.', {
      path: conceptPath,
    });
  }

  let frontmatter;
  try {
    frontmatter = parse(match[1]);
  } catch (error) {
    fail('okf_frontmatter_invalid', 'OKF frontmatter is invalid YAML.', {
      path: conceptPath,
      cause: error.message,
    });
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    fail('okf_frontmatter_invalid', 'OKF frontmatter must be an object.', {
      path: conceptPath,
    });
  }

  return {
    frontmatter,
    body: match[2],
  };
}

async function listMarkdownFiles(rootPath) {
  const files = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
}

function validateRelationRegistry(registry) {
  if (
    registry?.schema !== 'mnemosyne.relation-registry.v1'
    || !Array.isArray(registry.relations)
  ) {
    fail('okf_relation_registry_invalid', 'Relation Registry schema is invalid.');
  }
  const relations = new Map();
  for (const relation of registry.relations) {
    if (!String(relation?.id || '').trim() || relations.has(relation.id)) {
      fail('okf_relation_registry_invalid', 'Relation ids must be unique and non-empty.');
    }
    if (!['core', 'project'].includes(relation.status)) {
      fail('okf_relation_registry_invalid', `Invalid relation status: ${relation.id}`);
    }
    relations.set(relation.id, relation);
  }
  for (const core of CORE_RELATION_DEFINITIONS) {
    if (relations.get(core.id)?.status !== 'core') {
      fail('okf_core_relation_missing', `Missing core relation: ${core.id}`);
    }
  }
  for (const relation of relations.values()) {
    if (
      relation.status === 'project'
      && relations.get(relation.parent)?.status !== 'core'
    ) {
      fail(
        'okf_project_relation_parent_invalid',
        `Project relation ${relation.id} requires a core parent.`,
      );
    }
  }
  return relations;
}

function validateConceptShape(concept) {
  const { frontmatter, path: conceptPath, relativePath } = concept;
  for (const field of REQUIRED_FIELDS) {
    if (frontmatter[field] === undefined || frontmatter[field] === null) {
      fail('okf_required_field_missing', `Missing OKF field: ${field}`, {
        path: conceptPath,
        field,
      });
    }
  }

  const expectedDirectory = OKF_TYPE_DIRECTORIES[frontmatter.type];
  if (!expectedDirectory) {
    fail('okf_type_invalid', `Unsupported OKF type: ${frontmatter.type}`, {
      path: conceptPath,
    });
  }
  if (relativePath.split('/')[0] !== expectedDirectory) {
    fail('okf_type_directory_mismatch', 'OKF type does not match its directory.', {
      path: conceptPath,
      type: frontmatter.type,
      expected_directory: expectedDirectory,
    });
  }
  if (!SLUG_PATTERN.test(frontmatter.slug ?? '')) {
    fail('okf_slug_invalid', 'OKF slug must be ASCII lowercase kebab-case.', {
      path: conceptPath,
    });
  }
  if (path.posix.basename(conceptPath) !== `${frontmatter.slug}.md`) {
    fail('okf_slug_path_mismatch', 'OKF slug must match the readable path.', {
      path: conceptPath,
    });
  }
  const expectedPrefix = OKF_ENTITY_PREFIXES[frontmatter.type];
  if (!new RegExp(`^${expectedPrefix}_[A-Za-z0-9][A-Za-z0-9_-]{7,}$`).test(
    frontmatter.entity_id ?? '',
  )) {
    fail('okf_entity_id_invalid', 'OKF entity_id has an invalid type prefix or shape.', {
      path: conceptPath,
      entity_id: frontmatter.entity_id ?? null,
    });
  }
  if (!String(frontmatter.title || '').trim()) {
    fail('okf_title_invalid', 'OKF title must be non-empty.', { path: conceptPath });
  }
  if (!Array.isArray(frontmatter.aliases)) {
    fail('okf_aliases_invalid', 'OKF aliases must be an array.', { path: conceptPath });
  }
  if (
    !Array.isArray(frontmatter.source_refs)
    || frontmatter.source_refs.length === 0
    || frontmatter.source_refs.some(ref => !SOURCE_REF_PATTERN.test(ref))
  ) {
    fail('okf_source_refs_invalid', 'OKF source_refs must contain supported refs.', {
      path: conceptPath,
    });
  }
  if (!Array.isArray(frontmatter.links)) {
    fail('okf_links_invalid', 'OKF links must be an array.', { path: conceptPath });
  }
  if (frontmatter.links.length === 0 && !frontmatter.no_links_reason) {
    fail('okf_links_required', 'Unlinked OKF concepts require no_links_reason.', {
      path: conceptPath,
    });
  }
}

export async function validateOkfBundle({ chatSavePath }) {
  const storyMemoryPath = path.join(chatSavePath, 'story-memory');
  const registry = parse(await readFile(
    path.join(storyMemoryPath, 'relation-registry.yaml'),
    'utf8',
  ));
  const relations = validateRelationRegistry(registry);
  const conceptDirectories = new Set(Object.values(OKF_TYPE_DIRECTORIES));
  const markdownFiles = await listMarkdownFiles(storyMemoryPath);
  const conceptFiles = markdownFiles.filter(filePath => (
    conceptDirectories.has(
      path.relative(storyMemoryPath, filePath).split(path.sep)[0],
    )
  ));

  const concepts = [];
  const byEntityId = new Map();
  const byPath = new Map();
  const bySearchTerm = new Map();
  for (const filePath of conceptFiles) {
    const relativePath = path.relative(storyMemoryPath, filePath)
      .split(path.sep)
      .join('/');
    const conceptPath = `/${relativePath}`;
    const parsed = parseOkfConcept(await readFile(filePath, 'utf8'), {
      conceptPath,
    });
    const concept = {
      path: conceptPath,
      relativePath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
    validateConceptShape(concept);
    if (byEntityId.has(concept.frontmatter.entity_id)) {
      fail('okf_entity_id_duplicate', 'Duplicate OKF entity_id.', {
        entity_id: concept.frontmatter.entity_id,
      });
    }
    if (byPath.has(conceptPath)) {
      fail('okf_path_duplicate', 'Duplicate OKF readable path.', {
        path: conceptPath,
      });
    }
    byEntityId.set(concept.frontmatter.entity_id, concept);
    byPath.set(conceptPath, concept);
    for (const term of [
      concept.frontmatter.title,
      ...concept.frontmatter.aliases,
    ]) {
      const key = String(term).trim().toLocaleLowerCase();
      if (!key) continue;
      const matches = bySearchTerm.get(key) ?? [];
      matches.push(concept);
      bySearchTerm.set(key, matches);
    }
    concepts.push(concept);
  }

  for (const concept of concepts) {
    for (const link of concept.frontmatter.links) {
      if (
        !link
        || typeof link !== 'object'
        || typeof link.target !== 'string'
        || !link.target.startsWith('/')
      ) {
        fail('okf_link_target_invalid', 'Typed link target must be a bundle-root path.', {
          path: concept.path,
        });
      }
      if (!relations.has(link.relation)) {
        fail('okf_link_relation_unregistered', 'Typed link relation is not registered.', {
          path: concept.path,
          relation: link.relation ?? null,
        });
      }
      if (!byPath.has(link.target)) {
        fail('okf_link_target_missing', 'Typed link target does not exist.', {
          path: concept.path,
          target: link.target,
        });
      }
    }
  }

  return {
    schema: 'mnemosyne.okf-bundle-validation.v1',
    status: 'valid',
    concept_count: concepts.length,
    relation_count: relations.size,
    concepts,
    indexes: {
      byEntityId,
      byPath,
      bySearchTerm,
    },
  };
}

function resolvedConcept(concept) {
  return {
    ref: `okf://entity/${concept.frontmatter.entity_id}`,
    entity_id: concept.frontmatter.entity_id,
    path: concept.path,
    title: concept.frontmatter.title,
    type: concept.frontmatter.type,
  };
}

export function resolveOkfReference(bundle, value) {
  const input = String(value || '').trim();
  let concept = null;
  if (input.startsWith('okf://entity/')) {
    concept = bundle.indexes.byEntityId.get(input.slice('okf://entity/'.length));
  } else if (input.startsWith('/')) {
    concept = bundle.indexes.byPath.get(input);
  } else {
    const matches = bundle.indexes.bySearchTerm.get(input.toLocaleLowerCase()) ?? [];
    if (matches.length > 1) {
      fail('okf_reference_ambiguous', 'OKF title or alias is ambiguous.', {
        input,
        candidates: matches.map(item => item.frontmatter.entity_id),
      });
    }
    [concept] = matches;
  }

  if (!concept) {
    fail('okf_reference_unresolved', 'OKF reference could not be resolved.', {
      input,
    });
  }
  return resolvedConcept(concept);
}
