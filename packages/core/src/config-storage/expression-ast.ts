import type {
  CallExpression,
  Expression,
  MemberExpression,
  Property,
} from 'acorn';
import { memberCallAllowed } from './expression-call-policy';

const DATA_ROOTS = new Set(['headers', 'body', 'url', 'method', 'env', 'stream']);
const CALLABLE_ROOTS = new Set([
  'uuid', 'now', 'randomInt', 'base64encode', 'base64decode', 'md5', 'sha256',
  'parseJWT', 'jsonParse', 'jsonStringify', 'encrypt', 'first', 'last', 'length',
  'keys', 'values', 'trim', 'toLowerCase', 'toUpperCase', 'split', 'replace',
  'isString', 'isNumber', 'isObject', 'isArray', 'deepClean', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'Date',
]);
const OBJECT_ROOTS = new Set(['Math', 'Date', 'JSON']);
const ALLOWED_IDENTIFIERS = new Set([...DATA_ROOTS, ...CALLABLE_ROOTS, ...OBJECT_ROOTS]);
const DANGEROUS_MEMBERS = new Set(['constructor', '__proto__', 'prototype']);

function literalMemberName(expression: Expression): string | undefined {
  if (expression.type === 'Literal') {
    return typeof expression.value === 'string' || typeof expression.value === 'number'
      ? String(expression.value) : undefined;
  }
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function isDataLookup(expression: Expression): boolean {
  if (expression.type === 'Identifier') return DATA_ROOTS.has(expression.name);
  if (expression.type === 'ChainExpression') return isDataLookup(expression.expression);
  if (expression.type !== 'MemberExpression') return false;
  if (!isDataLookup(expression.object as Expression)) return false;
  if (!expression.computed) {
    return expression.property.type === 'Identifier'
      && !DANGEROUS_MEMBERS.has(expression.property.name);
  }
  const name = literalMemberName(expression.property as Expression);
  return name !== undefined && !DANGEROUS_MEMBERS.has(name);
}

function memberAllowed(member: MemberExpression): boolean {
  if (member.object.type === 'Super' || !isAllowedExpression(member.object)) return false;
  if (!member.computed) {
    return member.property.type === 'Identifier' && !DANGEROUS_MEMBERS.has(member.property.name);
  }
  if (member.property.type === 'PrivateIdentifier') return false;
  const name = literalMemberName(member.property);
  if (name !== undefined) return !DANGEROUS_MEMBERS.has(name);
  return isDataLookup(member.property);
}

function callAllowed(call: CallExpression): boolean {
  if (call.callee.type === 'Super' || call.arguments.some((argument) => argument.type === 'SpreadElement')) return false;
  const callee = call.callee;
  const allowedCallee = callee.type === 'Identifier'
    ? CALLABLE_ROOTS.has(callee.name)
    : callee.type === 'MemberExpression'
      && memberAllowed(callee) && memberCallAllowed(callee);
  return allowedCallee && call.arguments.every((argument) => isAllowedExpression(argument as Expression));
}

function propertyAllowed(property: Property): boolean {
  if (property.kind !== 'init' || property.method) return false;
  if (property.computed && !isAllowedExpression(property.key)) return false;
  if (property.shorthand && property.value.type === 'Identifier') {
    return ALLOWED_IDENTIFIERS.has(property.value.name);
  }
  return isAllowedExpression(property.value);
}

export function isAllowedExpression(expression: Expression): boolean {
  switch (expression.type) {
    case 'Identifier': return ALLOWED_IDENTIFIERS.has(expression.name);
    case 'Literal': return typeof expression.value !== 'bigint';
    case 'ArrayExpression':
      return expression.elements.every((element) => element !== null && element.type !== 'SpreadElement'
        && isAllowedExpression(element));
    case 'ObjectExpression':
      return expression.properties.every((property) => property.type === 'Property' && propertyAllowed(property));
    case 'UnaryExpression':
      return expression.operator !== 'delete' && isAllowedExpression(expression.argument);
    case 'BinaryExpression':
      return expression.left.type !== 'PrivateIdentifier'
        && isAllowedExpression(expression.left) && isAllowedExpression(expression.right);
    case 'LogicalExpression':
      return isAllowedExpression(expression.left) && isAllowedExpression(expression.right);
    case 'MemberExpression': return memberAllowed(expression);
    case 'ConditionalExpression':
      return isAllowedExpression(expression.test) && isAllowedExpression(expression.consequent)
        && isAllowedExpression(expression.alternate);
    case 'CallExpression': return callAllowed(expression);
    case 'TemplateLiteral': return expression.expressions.every(isAllowedExpression);
    case 'ChainExpression': return isAllowedExpression(expression.expression);
    case 'ParenthesizedExpression': return isAllowedExpression(expression.expression);
    case 'ThisExpression':
    case 'FunctionExpression':
    case 'UpdateExpression':
    case 'AssignmentExpression':
    case 'NewExpression':
    case 'SequenceExpression':
    case 'ArrowFunctionExpression':
    case 'YieldExpression':
    case 'TaggedTemplateExpression':
    case 'ClassExpression':
    case 'MetaProperty':
    case 'AwaitExpression':
    case 'ImportExpression': return false;
  }
}
