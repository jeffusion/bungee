import ts from 'typescript';
import { parse } from 'svelte/compiler';

/** Parse actual script syntax; comments and template text are not dependencies. */
export function uiScripts(source: string, file: string): ts.SourceFile[] {
  if (/\.(css|scss|sass|less|styl)$/.test(file)) return [];
  const component = file.endsWith('.svelte') ? parse(source, { modern: true }) : null;
  const scripts = component
    ? [component.instance, component.module]
      .filter(script => script != null).map(script => script!.content.body.map(node => source.slice((node as unknown as {start:number}).start, (node as unknown as {end:number}).end)).join('\n'))
    : [source];
  return scripts.map(script => ts.createSourceFile(file + '.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

export function uiImports(source: string, file = 'input.ts'): string[] {
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  uiScripts(source, file).forEach(visit);
  return imports;
}
