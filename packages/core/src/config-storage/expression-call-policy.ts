import type { Expression, MemberExpression } from 'acorn';

const MATH_METHODS = new Set([
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'ceil', 'clz32',
  'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'hypot', 'imul', 'log', 'log10', 'log1p',
  'log2', 'max', 'min', 'pow', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh',
  'trunc',
]);
const JSON_METHODS = new Set(['parse', 'stringify']);
const DATE_METHODS = new Set(['now', 'parse', 'UTC']);
const DATA_METHODS = new Set([
  'at', 'includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'slice', 'substring',
  'charAt', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'join', 'split',
]);

function staticMemberName(member: MemberExpression): string | undefined {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : undefined;
  if (member.property.type === 'Literal' && typeof member.property.value === 'string') {
    return member.property.value;
  }
  if (member.property.type === 'TemplateLiteral' && member.property.expressions.length === 0) {
    return member.property.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function isRegexLiteral(expression: Expression): boolean {
  return expression.type === 'Literal' && expression.regex !== undefined;
}

function isDataDerived(expression: Expression): boolean {
  switch (expression.type) {
    case 'Identifier': return ['headers', 'body', 'url', 'method', 'env', 'stream'].includes(expression.name);
    case 'Literal': return typeof expression.value === 'string';
    case 'ArrayExpression':
    case 'ObjectExpression': return true;
    case 'MemberExpression': return isDataDerived(expression.object as Expression);
    case 'CallExpression': return true;
    case 'ChainExpression': return isDataDerived(expression.expression);
    case 'ConditionalExpression': return isDataDerived(expression.consequent) && isDataDerived(expression.alternate);
    default: return false;
  }
}

export function memberCallAllowed(member: MemberExpression): boolean {
  const name = staticMemberName(member);
  if (!name || member.object.type === 'Super') return false;
  const object = member.object;
  if (object.type === 'Identifier') {
    if (object.name === 'Math') return MATH_METHODS.has(name);
    if (object.name === 'JSON') return JSON_METHODS.has(name);
    if (object.name === 'Date') return DATE_METHODS.has(name);
  }
  if (isRegexLiteral(object)) return name === 'test';
  return isDataDerived(object) && DATA_METHODS.has(name);
}
