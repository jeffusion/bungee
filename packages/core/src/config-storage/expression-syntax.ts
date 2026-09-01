import { parse } from 'acorn';
import type { Expression, ExpressionStatement } from 'acorn';
import { isAllowedExpression } from './expression-ast';
import type { ValidationContext } from './validation';

function parseExpression(source: string): Expression | undefined {
  try {
    const program = parse(`(${source})`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    });
    if (program.body.length !== 1 || program.body[0]?.type !== 'ExpressionStatement') return undefined;
    return (program.body[0] as ExpressionStatement).expression;
  } catch {
    return undefined;
  }
}

export function validateExpressionSyntax(
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    context.add('invalid_type', path, 'Expected an expression string');
    return;
  }
  const match = /^\s*\{\{([\s\S]+)\}\}\s*$/.exec(value);
  const expression = match ? parseExpression(match[1]) : undefined;
  if (!expression || !isAllowedExpression(expression)) {
    context.add('invalid_expression', path, 'Expression has invalid syntax or unsafe access');
  }
}
