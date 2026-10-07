import { parse } from 'acorn';
import type { Node } from 'acorn';
import { isAllowedExpression } from '../config-storage/expression-ast';

export type ExpressionDirection = 'request' | 'response';
export interface ExpressionDependencies {
  requestBody: boolean;
  responseBody: boolean;
}

export function parseDynamicExpression(source: string) {
  const program = parse(`(${source})`, { ecmaVersion: 'latest', sourceType: 'script' });
  const statement = program.body[0];
  if (program.body.length !== 1 || statement?.type !== 'ExpressionStatement'
    || !isAllowedExpression(statement.expression)) throw new Error('Invalid or unsafe expression');
  return statement.expression;
}

function memberName(node: any): string | undefined {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'Literal') return String(node.property.value);
  if (node.property.type === 'TemplateLiteral' && !node.property.expressions.length) return node.property.quasis[0]?.value.cooked;
  return undefined;
}

/** 分析动态模板中的真实 AST 引用；普通文本和字符串字面量不产生依赖。 */
export function analyzeExpressionDependencies(value: unknown, direction: ExpressionDirection = 'request'): ExpressionDependencies {
  const result: ExpressionDependencies = { requestBody: false, responseBody: false };
  const mark = (root: string, member?: string) => {
    if (root === 'response' && direction === 'request') throw new Error('response is unavailable during the request phase');
    if (root === 'body') result[direction === 'request' ? 'requestBody' : 'responseBody'] = true;
    if ((root === 'request' || root === 'response') && (member === undefined || member === 'body')) {
      result[root === 'request' ? 'requestBody' : 'responseBody'] = true;
    }
  };
  const visit = (node: any) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier') { mark(node.name); return; }
    if (node.type === 'MemberExpression') {
      let base = node, first: string | undefined;
      while (base.type === 'MemberExpression') {
        first = memberName(base);
        if (base.computed) visit(base.property);
        base = base.object;
        if (base.type === 'ChainExpression') base = base.expression;
      }
      if (base.type === 'Identifier') mark(base.name, first);
      else visit(base);
      return;
    }
    if (node.type === 'Property') {
      if (node.computed) visit(node.key);
      visit(node.value);
      return;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  const inspect = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(/\{\{([\s\S]+?)\}\}/g)) visit(parseDynamicExpression(match[1]!));
    } else if (Array.isArray(item)) item.forEach(inspect);
    else if (item && typeof item === 'object') Object.values(item).forEach(inspect);
  };
  inspect(value);
  return result;
}

/** 空 add/replace/default/remove 不需要读取 body。 */
export function hasBodyModification(rules: unknown): boolean {
  if (!rules || typeof rules !== 'object') return false;
  return ['add', 'replace', 'default', 'remove'].some(key => {
    const value = (rules as Record<string, unknown>)[key];
    return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  });
}

/** 仅改写标识符节点，绝不改写字符串内容或 headers 同名属性。 */
export function rewriteLegacyResponseHeaders(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\{\{([\s\S]+?)\}\}/g, (_whole, source: string) => {
    const expression = parseDynamicExpression(source);
    const edits: number[] = [];
    const walk = (node: any): void => {
      if (node.type === 'Identifier') {
        if (node.name === 'headers') edits.push(node.start - 1);
        return;
      }
      if (node.type === 'MemberExpression') {
        walk(node.object);
        if (node.computed) walk(node.property);
        return;
      }
      if (node.type === 'Property') {
        if (node.computed) walk(node.key);
        if (node.shorthand && node.value.type === 'Identifier' && node.value.name === 'headers') {
          edits.push(-(node.value.start));
        } else walk(node.value);
        return;
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach((item) => item && typeof item.type === 'string' && walk(item));
        else if (child && typeof child === 'object' && 'type' in child) walk(child);
      }
    };
    walk(expression as Node);
    let rewritten = source;
    for (const edit of edits.sort((a, b) => Math.abs(b) - Math.abs(a))) {
      const offset = edit < 0 ? -edit - 1 : edit;
      const replacement = edit < 0 ? 'headers: request.headers' : 'request.headers';
      rewritten = rewritten.slice(0, offset) + replacement + rewritten.slice(offset + 7);
    }
    return `{{${rewritten}}}`;
  });
  if (Array.isArray(value)) return value.map(rewriteLegacyResponseHeaders);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteLegacyResponseHeaders(item)]));
  return value;
}
