import { parse } from 'acorn';
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
