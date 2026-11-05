import { resolveSavedScene } from '../savedScene.js';
import { readSceneAsArray } from '../sceneJson.js';
import { isNodeLikeEntry, buildPathResolver } from '../sceneTree.js';
import { ToolError } from '../errors.js';

const DEFAULT_PROPERTIES = ['name', 'active', 'position', 'rotation', 'scale', 'layer'];
const PROPERTY_FIELDS = { name: '_name', active: '_active', position: '_lpos', rotation: '_lrot', scale: '_lscale', layer: '_layer' };
const BLOCKED_PROPERTIES = ['constructor', 'prototype', '_parent', '_children', '_components', '_prefab', 'parent', 'children', 'components', 'prefab'];
const VALUE_SHAPES = {
  'x,y': ['cc.Vec2'],
  'x,y,z': ['cc.Vec3'],
  'w,x,y,z': ['cc.Vec4', 'cc.Quat'],
  'a,b,g,r': ['cc.Color']
};
const MAX_STRING_LENGTH = 1024;
const MAX_SELECTOR_LENGTH = 4096;
const MAX_PROPERTIES = 50;

export const declaration = {
  name: 'scene_batch_node_properties',
  description: 'Read a bounded batch of nodes from a saved Cocos scene/prefab. Exact path/uuid selectors preserve input order and individual errors. Returns only own primitive or small numeric vector/color properties, never internal references or deep objects. Does not access or modify the Editor.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Optional project directory inside the server root; scenePath is relative to this directory when supplied.' },
      scenePath: { type: 'string' },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { nodePath: { type: 'string' }, nodeUuid: { type: 'string' } },
          description: 'Exactly one nodePath or nodeUuid; invalid selectors return individual errors.'
        }
      },
      properties: { type: 'array', items: { type: 'string' }, description: 'First 50 names; defaults to name, active, position, rotation (quaternion), scale, layer. Serialized field names are also accepted. Strings are limited to 1024 characters.' },
      maxNodes: { type: 'integer', description: 'Default 100; clamped to 1..500.' }
    },
    required: ['scenePath', 'nodes']
  }
};

export function validate(args) {
  if (!args || typeof args.scenePath !== 'string' || !args.scenePath.trim()) {
    throw new Error('scenePath must be a non-empty string');
  }
  if (args.projectPath !== undefined && (typeof args.projectPath !== 'string' || !args.projectPath.trim())) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (!Array.isArray(args.nodes)) throw new Error('nodes must be an array');
  if (args.properties !== undefined && !Array.isArray(args.properties)) throw new Error('properties must be an array');
  let maxNodes = 100;
  if (args.maxNodes !== undefined) {
    if (typeof args.maxNodes !== 'number' || !isFinite(args.maxNodes) || Math.floor(args.maxNodes) !== args.maxNodes) {
      throw new Error('maxNodes must be a finite integer');
    }
    maxNodes = Math.max(1, Math.min(500, args.maxNodes));
  }
  return { projectPath: args.projectPath, scenePath: args.scenePath, nodes: args.nodes, properties: args.properties, maxNodes };
}

function selectorError(selector) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return 'Selector must be an object';
  const hasPath = Object.prototype.hasOwnProperty.call(selector, 'nodePath');
  const hasUuid = Object.prototype.hasOwnProperty.call(selector, 'nodeUuid');
  if (hasPath === hasUuid) return 'Provide exactly one nodePath or nodeUuid';
  const value = hasPath ? selector.nodePath : selector.nodeUuid;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR_LENGTH) {
    return 'Selector must be a non-empty string of at most 4096 characters';
  }
  return null;
}

function indexValue(index, value, entryIndex) {
  if (typeof value !== 'string' || !value || value.length > MAX_SELECTOR_LENGTH) return;
  if (Object.prototype.hasOwnProperty.call(index, value)) index[value] = -1;
  else index[value] = entryIndex;
}

function indexNodes(entries) {
  const byPath = Object.create(null);
  const byUuid = Object.create(null);
  const resolvePath = buildPathResolver(entries);
  entries.forEach((entry, index) => {
    if (!isNodeLikeEntry(entry)) return;
    indexValue(byPath, resolvePath(index, 0), index);
    indexValue(byUuid, entry._id, index);
  });
  return { entries, byPath, byUuid, resolvePath };
}

function safeVector(value) {
  const keys = Object.keys(value).sort();
  const fields = keys.filter((key) => key !== '__type__');
  const shape = fields.join(',');
  if (!Object.prototype.hasOwnProperty.call(VALUE_SHAPES, shape)) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, '__type__') && VALUE_SHAPES[shape].indexOf(value.__type__) === -1) return undefined;
  const result = {};
  for (const field of fields) {
    if (typeof value[field] !== 'number' || !isFinite(value[field])) return undefined;
    result[field] = value[field];
  }
  return result;
}

function safeValue(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length <= MAX_STRING_LENGTH ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return safeVector(value);
}

function readProperty(entry, property) {
  if (typeof property !== 'string' || !property || property.length > 128) {
    return { error: 'Property must be a non-empty string of at most 128 characters' };
  }
  if (property.indexOf('__') === 0 || BLOCKED_PROPERTIES.indexOf(property) !== -1) {
    return { error: 'Internal references and prototype properties are not exposed' };
  }
  const field = Object.prototype.hasOwnProperty.call(PROPERTY_FIELDS, property) ? PROPERTY_FIELDS[property] : property;
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return { error: 'Property not found' };
  const value = safeValue(entry[field]);
  return value === undefined ? { error: 'Property is not a bounded primitive, vector, quaternion, or color' } : { value };
}

function readProperties(entry, properties) {
  const values = Object.create(null);
  const errors = [];
  properties.forEach((property, index) => {
    const result = readProperty(entry, property);
    if (result.error) {
      errors.push({ index, property: typeof property === 'string' ? property.slice(0, 128) : null, error: result.error });
    } else {
      values[property] = result.value;
    }
  });
  return { properties: values, propertyErrors: errors };
}

function resolveSelector(context, selector, properties, index) {
  const error = selectorError(selector);
  if (error) return { index, ok: false, code: 'invalid_selector', error };
  const byPath = Object.prototype.hasOwnProperty.call(selector, 'nodePath');
  const lookup = byPath ? context.byPath : context.byUuid;
  const key = byPath ? selector.nodePath : selector.nodeUuid;
  if (!Object.prototype.hasOwnProperty.call(lookup, key)) {
    return { index, ok: false, code: 'not_found', error: 'No matching node' };
  }
  const entryIndex = lookup[key];
  if (entryIndex === -1) return { index, ok: false, code: 'ambiguous_selector', error: 'Selector matches multiple nodes' };
  const entry = context.entries[entryIndex];
  const result = readProperties(entry, properties);
  const nodePath = context.resolvePath(entryIndex, 0);
  return {
    index,
    ok: true,
    nodePath: typeof nodePath === 'string' ? nodePath.slice(0, MAX_SELECTOR_LENGTH) : null,
    nodeUuid: typeof entry._id === 'string' ? entry._id.slice(0, MAX_SELECTOR_LENGTH) : null,
    properties: result.properties,
    propertyErrors: result.propertyErrors
  };
}

export async function handler(args, root) {
  const input = validate(args);
  const { scene } = resolveSavedScene(root, input);
  const parsed = readSceneAsArray(scene);
  if (!parsed.ok) throw new ToolError(parsed.error);
  const context = indexNodes(parsed.entries);
  const requestedProperties = input.properties === undefined ? DEFAULT_PROPERTIES : input.properties;
  const properties = requestedProperties.slice(0, MAX_PROPERTIES);
  const selectors = input.nodes.slice(0, input.maxNodes);
  return {
    scenePath: input.scenePath,
    requested: input.nodes.length,
    processed: selectors.length,
    truncated: selectors.length < input.nodes.length,
    propertiesTruncated: requestedProperties.length > MAX_PROPERTIES,
    results: selectors.map((selector, index) => resolveSelector(context, selector, properties, index))
  };
}
