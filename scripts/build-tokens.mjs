import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const errors = [];
const checkOnly = process.argv.includes('--check');

function readJson(path) {
  try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')); }
  catch (error) { errors.push('Unable to read ' + path + ': ' + String(error)); return null; }
}

function isToken(value) { return value && typeof value === 'object' && '$value' in value; }
function walk(value, path, entries) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (isToken(value)) { entries.push({ path, token: value }); return; }
  for (const [key, child] of Object.entries(value)) if (!key.startsWith('$')) walk(child, path.concat(key.split(/[/.]/).filter(Boolean)), entries);
}
function aliases(path) {
  const clean = String(path || '').replace(/^\{+|\}+$/g, '').replace(/[.]/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  return [clean, clean.split('/').slice(1).join('/')].filter(Boolean);
}
function toHex(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.components)) return value;
  const hex = value.components.slice(0, 3).map(component => Math.round(Math.max(0, Math.min(1, Number(component))) * 255).toString(16).padStart(2, '0')).join('');
  const alpha = value.alpha === undefined ? 1 : Number(value.alpha);
  return alpha < 1 ? '#' + hex + Math.round(alpha * 255).toString(16).padStart(2, '0') : '#' + hex;
}
function resolveContext(data) {
  const entries = [];
  walk(data || {}, [], entries);
  const lookup = new Map();
  for (const entry of entries) for (const alias of aliases(entry.path.join('/'))) lookup.set(alias, entry);
  const cache = new Map();
  const active = new Set();
  function resolveEntry(entry) {
    if (cache.has(entry.path.join('/'))) return cache.get(entry.path.join('/'));
    if (active.has(entry.path.join('/'))) { errors.push('Circular reference at ' + entry.path.join('/')); return undefined; }
    active.add(entry.path.join('/'));
    const result = resolveValue(entry.token.$value);
    active.delete(entry.path.join('/'));
    if (result === undefined) errors.push('Unresolved value at ' + entry.path.join('/'));
    cache.set(entry.path.join('/'), result);
    return result;
  }
  function resolveValue(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.ref === 'string') {
        const target = aliases(value.ref).map(alias => lookup.get(alias)).find(Boolean);
        if (target) return resolveEntry(target);
        errors.push('Unresolved reference: ' + value.ref);
        return undefined;
      }
      if (Array.isArray(value.components) && value.colorSpace) return toHex(value);
      const next = {};
      for (const [key, child] of Object.entries(value)) next[key] = resolveValue(child);
      return next;
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (typeof value === 'string' && /^\{.+\}$/.test(value)) {
      const target = aliases(value).map(alias => lookup.get(alias)).find(Boolean);
      if (target) return resolveEntry(target);
      errors.push('Unresolved reference: ' + value);
      return undefined;
    }
    if (typeof value === 'string' && /(?:multiply|divide|add|subtract|lighten|darken|mix|alpha)\s*\(/i.test(value)) {
      errors.push('Computed expression must be resolved by DHM Tokens before publishing: ' + value);
      return undefined;
    }
    return value;
  }
  const resolved = {};
  for (const entry of entries) setPath(resolved, entry.path, resolveEntry(entry));
  return { resolved, entries };
}
function setPath(target, path, value) {
  let current = target;
  path.forEach((part, index) => { if (index === path.length - 1) current[part] = value; else current = current[part] ||= {}; });
}
function getPath(value, path) { return path.reduce((current, part) => current && current[part], value); }
function normalizeFontWeight(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const weightNames = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
  const normalized = value.toLowerCase().replace(/[\\s_-]+/g, '');
  return weightNames[normalized] || value;
}
function unitValue(value, fallbackUnit) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.value === 'number' && typeof value.unit === 'string') return String(value.value) + value.unit;
  return typeof value === 'number' ? String(value) + fallbackUnit : null;
}
function cssValue(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'dimension') return unitValue(value, 'px');
  if (type === 'duration') return unitValue(value, 'ms');
  if (typeof value === 'object') return null;
  if (type === 'fontWeight') return String(normalizeFontWeight(value));
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}
function publicPath(path) { return path.length > 1 ? path.slice(1) : path; }
function cssVariable(path) { return '--' + publicPath(path).map(part => part.toLowerCase().replace(/[^a-z0-9]+/g, '-')).join('-'); }
function typographyClass(path) { return '.dhm-type-' + publicPath(path).map(part => part.toLowerCase().replace(/[^a-z0-9]+/g, '-')).join('-'); }
function typographyDeclarations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const declarations = [];
  const fontFamily = Array.isArray(value.fontFamily) ? value.fontFamily.join(', ') : value.fontFamily;
  if (typeof fontFamily === 'string' && fontFamily.trim()) {
    declarations.push('font-family: ' + fontFamily.split(',').map(item => {
      const family = item.trim();
      return /\s/.test(family) && !/^['"].*['"]$/.test(family) ? "'" + family + "'" : family;
    }).join(', ') + ';');
  }
  if (typeof value.fontStyle === 'string') declarations.push('font-style: ' + value.fontStyle.toLowerCase() + ';');
  const weightNames = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
  const rawWeight = typeof value.fontWeight === 'string' ? value.fontWeight.toLowerCase().replace(/[\s-]+/g, '') : value.fontWeight;
  if (typeof rawWeight === 'number' || (typeof rawWeight === 'string' && /^\d{3}$/.test(rawWeight))) declarations.push('font-weight: ' + rawWeight + ';');
  else if (typeof rawWeight === 'string' && weightNames[rawWeight]) declarations.push('font-weight: ' + weightNames[rawWeight] + ';');
  const fontSize = unitValue(value.fontSize, 'px');
  if (fontSize) declarations.push('font-size: ' + fontSize + ';');
  else if (typeof value.fontSize === 'string' && value.fontSize.trim()) declarations.push('font-size: ' + value.fontSize.trim() + ';');
  const lineHeight = unitValue(value.lineHeight, 'px');
  if (lineHeight) declarations.push('line-height: ' + lineHeight + ';');
  else if (typeof value.lineHeight === 'string' && value.lineHeight.trim()) declarations.push('line-height: ' + value.lineHeight.trim() + ';');
  const letterSpacing = unitValue(value.letterSpacing, 'px');
  if (letterSpacing) declarations.push('letter-spacing: ' + letterSpacing + ';');
  else if (typeof value.letterSpacing === 'string' && value.letterSpacing.trim()) declarations.push('letter-spacing: ' + value.letterSpacing.trim() + ';');
  if (typeof value.textCase === 'string') {
    const textCase = value.textCase.toLowerCase().replace(/[\s_-]+/g, '');
    if (textCase === 'uppercase' || textCase === 'lowercase') declarations.push('text-transform: ' + textCase + ';');
    else if (textCase === 'title' || textCase === 'titlecase') declarations.push('text-transform: capitalize;');
  }
  if (typeof value.textDecoration === 'string') {
    const decoration = value.textDecoration.toLowerCase().replace(/[\s_-]+/g, '');
    if (decoration === 'underline') declarations.push('text-decoration: underline;');
    else if (decoration === 'strikethrough' || decoration === 'linethrough') declarations.push('text-decoration: line-through;');
  }
  return declarations;
}
function createTypographyCss(entries) {
  const css = ['/* Generated typography utility classes. */'];
  for (const entry of entries) {
    const declarations = typographyDeclarations(entry.value);
    if (!declarations.length) continue;
    css.push(typographyClass(entry.path) + ' {');
    for (const declaration of declarations) css.push('  ' + declaration);
    css.push('}', '');
  }
  return css.join('\n');
}
function sourceContexts(config) {
  const source = config.source;
  if (source.format === 'dtcg-single') return [{ name: 'default', data: readJson(source.path) }];
  const manifestPath = source.manifestPath || source.path.replace(/\/+$/, '') + '/manifest.json';
  const manifest = readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.files)) return [];
  const files = manifest.files.filter(file => file.kind === 'core' || file.kind === 'mode' || file.kind === 'text-styles');
  const root = source.path.replace(/\/+$/, '');
  const coreFile = files.find(file => file.kind === 'core');
  const core = coreFile ? readJson(root + '/' + coreFile.path) : null;
  return files.map(file => {
    const data = readJson(root + '/' + file.path);
    const isCore = file.kind === 'core';
    return {
      name: file.mode || (isCore ? 'default' : 'text-styles'),
      // Mode and Text Style files contain overrides only. Resolve them against
      // core so aliases can still target primitive tokens in the core file.
      data: isCore ? data : mergeTokenTrees(core, data),
      emitPaths: isCore ? null : tokenPaths(data),
    };
  });
}
function mergeTokenTrees(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? base : override;
  if (isToken(base) || isToken(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = mergeTokenTrees(base[key], value);
  return result;
}
function tokenPaths(data) {
  const entries = [];
  walk(data || {}, [], entries);
  return new Set(entries.map(entry => entry.path.join('/')));
}

function copyComponents(sourcePath, distPath) {
  try {
    mkdirSync(resolve(root, distPath), { recursive: true });
    for (const entry of readdirSync(resolve(root, sourcePath), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        writeFileSync(resolve(root, distPath, entry.name), readFileSync(resolve(root, sourcePath, entry.name)));
      }
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') errors.push('Unable to copy component specs: ' + String(error));
  }
}

const config = readJson('dhm.tokens.config.json');
const contexts = config ? sourceContexts(config) : [];
const resolvedContexts = {};
const manifestEntries = [];
const typographyEntries = [];
const css = [':root {'];
for (const context of contexts) {
  const result = resolveContext(context.data);
  resolvedContexts[context.name] = result.resolved;
  for (const entry of result.entries) {
    if (context.emitPaths && !context.emitPaths.has(entry.path.join('/'))) continue;
    const path = entry.path;
    const variable = cssVariable(path);
    manifestEntries.push({ tokenPath: publicPath(path).join('/'), cssVariable: variable, type: entry.token.$type || 'unknown', context: context.name, description: entry.token.$description });
    const value = getPath(result.resolved, path);
    if (entry.token.$type === 'typography') typographyEntries.push({ path, value });
    const output = cssValue(value, entry.token.$type);
    if (output !== null) {
      if (context.name === 'default') css.push('  ' + variable + ': ' + output + ';');
    }
  }
  if (context.name !== 'default') {
    css.push('}', '', '[data-theme="' + context.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '"] {');
    for (const entry of result.entries) {
      if (context.emitPaths && !context.emitPaths.has(entry.path.join('/'))) continue;
      const output = cssValue(getPath(result.resolved, entry.path), entry.token.$type);
      if (output !== null) css.push('  ' + cssVariable(entry.path) + ': ' + output + ';');
    }
  }
}
css.push('}', '');
if (errors.length) { console.error(errors.map(error => '✖ ' + error).join('\n')); process.exitCode = 1; }
if (!checkOnly && errors.length === 0 && config) {
  const resolvedJson = JSON.stringify(Object.keys(resolvedContexts).length === 1 && resolvedContexts.default ? resolvedContexts.default : resolvedContexts, null, 2) + '\n';
  const dist = config.dist || {};
  mkdirSync(resolve(root, 'dist'), { recursive: true });
  writeFileSync(resolve(root, dist.resolvedJson || 'dist/tokens.resolved.json'), resolvedJson);
  writeFileSync(resolve(root, dist.css || 'dist/tokens.css'), css.join('\n'));
  writeFileSync(resolve(root, dist.typographyCss || 'dist/typography.css'), createTypographyCss(typographyEntries));
  writeFileSync(resolve(root, dist.javascript || 'dist/index.js'), 'export const tokens = ' + resolvedJson + ';\nexport default tokens;\n');
  writeFileSync(resolve(root, dist.types || 'dist/index.d.ts'), 'export declare const tokens: Record<string, unknown>;\ndeclare const _default: typeof tokens;\nexport default _default;\n');
  if (config.components) copyComponents(config.components.sourcePath || 'components', config.components.distPath || 'dist/components');
  writeFileSync(resolve(root, 'dist/manifest.json'), JSON.stringify({ format: 'dhm-token-repository', version: 1, package: config.package, entries: manifestEntries, components: config.components && config.components.manifest }, null, 2) + '\n');
}
