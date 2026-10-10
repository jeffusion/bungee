import { createHash } from 'node:crypto';
import postcss, { type ChildNode, type Root } from 'postcss';
import { parse } from 'svelte/compiler';
import { uiImports } from './ui-source';

// Ignore formatting/comments, but retain selectors, declarations and enclosing
// media/layer conditions. Editing a global rule's scope or body changes its hash.
function canonical(node: ChildNode | Root): unknown {
  if (node.type === 'comment') return null;
  const children = 'nodes' in node ? node.nodes?.filter(child => child.type !== 'comment').map(canonical) : undefined;
  switch (node.type) {
    case 'decl': return [node.type, node.prop, node.value, !!node.important];
    case 'rule': return [node.type, node.selector.trim(), children];
    case 'atrule': return [node.type, node.name, node.params.trim(), children];
    default: return [node.type, children];
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function globalStyleFingerprints(source: string, svelte: boolean): string[] {
  const css = svelte ? parse(source).css?.content.styles ?? '' : source;
  const root = postcss.parse(css);
  if (!svelte) return [digest(canonical(root))];
  const fingerprints: string[] = [];
  root.walk(rule => {
    const globalRule = rule.type === 'rule' && rule.selector.includes(':global');
    // These at-rules escape selector scoping even inside a component style.
    const globalAtRule = rule.type === 'atrule' && (['import', 'font-face', 'property', 'counter-style', 'page', 'namespace'].includes(rule.name)
      || (rule.name.endsWith('keyframes') && rule.params.startsWith('-global-')));
    if (!globalRule && !globalAtRule) return;
    const ancestors: unknown[] = [];
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
      ancestors.push(parent.type === 'atrule' ? [parent.name, parent.params] : ['rule', parent.selector]);
    }
    fingerprints.push(digest([ancestors, canonical(rule)]));
  });
  return fingerprints;
}

export function isOrderedStyleSubset(actual: string[], allowed: readonly string[]): boolean {
  let next = 0;
  for (const fingerprint of actual) {
    const index = allowed.indexOf(fingerprint, next);
    if (index < 0) return false;
    next = index + 1;
  }
  return true;
}

// A template/head <style> is a real global DOM element, unlike the component's
// top-level CSS block. Walk every branch/snippet instead of matching source text.
export function templateStylesheetElements(source: string): string[] {
  const found: string[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { type?: string; name?: string; attributes?: Array<{ name?: string; value?: unknown }> };
    if (node.type === 'Element' && node.name === 'style') found.push('style');
    if (node.type === 'Element' && node.name === 'link') {
      const rel = node.attributes?.find(attribute => attribute.name === 'rel');
      const parts = rel?.value;
      const staticRel = Array.isArray(parts) && parts.every(part => part.type === 'Text')
        ? parts.map(part => part.data).join('').toLowerCase().split(/\s+/) : null;
      if (rel && (!staticRel || staticRel.includes('stylesheet'))
        || node.attributes?.some(attribute => (attribute as { type?: string }).type === 'Spread')) found.push('stylesheet link');
    }
    Object.values(value).forEach(visit);
  }
  visit(parse(source).html);
  return found;
}

export function stylesheetImports(source: string, file = 'input.ts'): string[] {
  return uiImports(source, file).filter(specifier => /\.(css|scss|sass|less|styl)(?:\?[^'"]*)?$/.test(specifier)).sort();
}

export function componentStyleAttributes(source: string): string[] {
  return parse(source).css?.attributes.map(attribute => attribute.name).filter(name => name === 'global' || name === 'src') ?? [];
}
