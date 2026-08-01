import {
  Node,
  SyntaxKind,
  type BindingElement,
  type CallExpression,
  type Node as TsNode,
  type ObjectLiteralExpression,
  type SourceFile
} from "ts-morph";
import { functionId, unitId } from "../parser/node-id.js";
import { isProjectSourceFile, relativeProjectPath } from "../util/path-utils.js";

export interface SymbolResolveContext {
  projectName: string;
  projectRoot: string;
}

export function resolveCallTargetId(context: SymbolResolveContext, call: CallExpression): string | undefined {
  const expression = call.getExpression();
  const symbol = Node.isPropertyAccessExpression(expression)
    ? expression.getNameNode().getSymbol()
    : expression.getSymbol();
  if (!symbol) return undefined;
  for (const declaration of symbol.getDeclarations()) {
    if (Node.isBindingElement(declaration)) {
      const resolved = resolveBindingElementTarget(context, declaration);
      if (resolved) return resolved;
    }
    const id = resolveFunctionDeclarationId(context, declaration);
    if (id) return id;
  }
  return undefined;
}

/**
 * Resolve a destructured binding such as `const { savePage } = useService()` to
 * the real function returned by the hook: follow the initializer call → hook
 * function body → first returned object literal → matching property → its
 * definition. Plain declaration lookup cannot do this on its own.
 */
function resolveBindingElementTarget(context: SymbolResolveContext, bindingElement: BindingElement): string | undefined {
  const variableDeclaration = bindingElement.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const initializer = variableDeclaration?.getInitializer();
  if (!initializer || !Node.isCallExpression(initializer)) return undefined;

  for (const declaration of resolveCalleeDeclarations(initializer.getExpression())) {
    const body = getFunctionBody(declaration);
    if (!body) continue;
    const propertyName = bindingElement.getPropertyNameNode()?.getText().replace(/^['"]|['"]$/g, "") ?? bindingElement.getName();
    for (const returnObject of findReturnedObjectLiterals(body)) {
      const property = returnObject.getProperty(propertyName);
      if (!property) continue;

      if (Node.isShorthandPropertyAssignment(property)) {
        const propName = property.getNameNode().getText();
        const varDecl = body.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((v) => v.getName() === propName);
        if (varDecl) {
          const id = resolveFunctionDeclarationId(context, varDecl);
          if (id) return id;
        }
        const propertySymbol = property.getNameNode().getSymbol();
        for (const target of propertySymbol?.getAliasedSymbol()?.getDeclarations() ?? propertySymbol?.getDeclarations() ?? []) {
          const id = resolveFunctionDeclarationId(context, target);
          if (id) return id;
        }
      } else if (Node.isPropertyAssignment(property)) {
        const valueInitializer = property.getInitializer();
        if (valueInitializer) {
          const id = resolveInitializerFunctionId(context, valueInitializer);
          if (id) return id;
        }
      }
    }
  }
  return undefined;
}

function resolveCalleeDeclarations(callee: TsNode): TsNode[] {
  if (!Node.isIdentifier(callee)) return [];
  const symbol = callee.getSymbol();
  if (!symbol) return [];
  const aliased = symbol.getAliasedSymbol();
  return (aliased ? aliased.getDeclarations() : symbol.getDeclarations()) ?? [];
}

function getFunctionBody(declaration: TsNode): TsNode | undefined {
  if (Node.isFunctionDeclaration(declaration) || Node.isFunctionExpression(declaration) || Node.isArrowFunction(declaration)) {
    return declaration.getBody();
  }
  if (Node.isVariableDeclaration(declaration)) {
    const fn = getFunctionInitializer(declaration.getInitializer());
    return fn?.getBody();
  }
  return undefined;
}

function findReturnedObjectLiterals(body: TsNode): ObjectLiteralExpression[] {
  const results: ObjectLiteralExpression[] = [];
  for (const returnStatement of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expression = returnStatement.getExpression();
    if (expression && Node.isObjectLiteralExpression(expression)) results.push(expression);
  }
  return results;
}

function resolveInitializerFunctionId(context: SymbolResolveContext, initializer: TsNode): string | undefined {
  if (Node.isCallExpression(initializer)) {
    const firstArg = initializer.getArguments()[0];
    if (firstArg && Node.isExpression(firstArg)) return resolveInitializerFunctionId(context, firstArg);
    return undefined;
  }
  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    const sourceFile = initializer.getSourceFile();
    if (!isProjectSourceFile(sourceFile.getFilePath(), context.projectRoot)) return undefined;
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    return functionId(context.projectName, projectFilePath, buildSignature("anonymous", initializer.getParameters().map((param) => param.getText())));
  }
  if (Node.isIdentifier(initializer)) {
    const symbol = initializer.getSymbol();
    for (const declaration of symbol?.getDeclarations() ?? []) {
      const id = resolveFunctionDeclarationId(context, declaration);
      if (id) return id;
    }
  }
  return undefined;
}

export function resolveFunctionDeclarationId(context: SymbolResolveContext, declaration: TsNode): string | undefined {
  const sourceFile = declaration.getSourceFile();
  if (!isProjectSourceFile(sourceFile.getFilePath(), context.projectRoot)) return undefined;
  const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());

  if (Node.isFunctionDeclaration(declaration)) {
    const name = declaration.getName();
    if (!name) return undefined;
    return functionId(context.projectName, projectFilePath, buildSignature(name, declaration.getParameters().map((param) => param.getText())));
  }

  if (Node.isVariableDeclaration(declaration)) {
    const initializer = getFunctionInitializer(declaration.getInitializer());
    if (!initializer) return undefined;
    return functionId(context.projectName, projectFilePath, buildSignature(declaration.getName(), initializer.getParameters().map((param) => param.getText())));
  }

  if (Node.isPropertyDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) return undefined;
    const className = declaration.getParentIfKind(SyntaxKind.ClassDeclaration)?.getName();
    const name = className ? `${className}.${declaration.getName()}` : declaration.getName();
    return functionId(context.projectName, projectFilePath, buildSignature(name, initializer.getParameters().map((param) => param.getText())));
  }

  if (Node.isMethodDeclaration(declaration) || Node.isMethodSignature(declaration)) {
    const className = declaration.getParentIfKind(SyntaxKind.ClassDeclaration)?.getName()
      ?? declaration.getParentIfKind(SyntaxKind.InterfaceDeclaration)?.getName();
    const methodName = declaration.getName();
    const objectName = className || !Node.isMethodDeclaration(declaration) ? undefined : objectLiteralMethodOwnerName(declaration);
    const name = className ? `${className}.${methodName}` : objectName ? `${objectName}.${methodName}` : methodName;
    return functionId(context.projectName, projectFilePath, buildSignature(name, declaration.getParameters().map((param) => param.getText())));
  }

  if (Node.isConstructorDeclaration(declaration)) {
    const className = declaration.getParentIfKind(SyntaxKind.ClassDeclaration)?.getName();
    if (!className) return undefined;
    return functionId(context.projectName, projectFilePath, buildSignature(`${className}.constructor`, declaration.getParameters().map((param) => param.getText())));
  }

  if (Node.isPropertyAssignment(declaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) return undefined;
    const name = objectMethodName(declaration);
    return functionId(context.projectName, projectFilePath, buildSignature(name, initializer.getParameters().map((param) => param.getText())));
  }

  return undefined;
}

export function resolveUnitDeclarationId(context: SymbolResolveContext, declaration: TsNode): string | undefined {
  const sourceFile = declaration.getSourceFile();
  if (!isProjectSourceFile(sourceFile.getFilePath(), context.projectRoot)) return undefined;
  const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());

  if (Node.isClassDeclaration(declaration) || Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration) || Node.isEnumDeclaration(declaration)) {
    const name = declaration.getName();
    if (!name) return undefined;
    return unitId(context.projectName, projectFilePath, name);
  }

  return undefined;
}

export function resolveTypeReferenceUnitId(context: SymbolResolveContext, node: TsNode): string | undefined {
  const symbol = node.getSymbol();
  if (!symbol) return undefined;
  for (const declaration of symbol.getDeclarations()) {
    const id = resolveUnitDeclarationId(context, declaration);
    if (id) return id;
  }
  return undefined;
}

export function buildSignature(name: string, params: string[]): string {
  return `${name}(${params.join(",")})`;
}

function objectMethodName(property: import("ts-morph").PropertyAssignment): string {
  const propertyName = property.getName().replace(/^['"]|['"]$/g, "");
  const ownerName = objectLiteralOwnerName(property.getParentIfKind(SyntaxKind.ObjectLiteralExpression));
  return ownerName ? `${ownerName}.${propertyName}` : propertyName;
}

function objectLiteralMethodOwnerName(method: import("ts-morph").MethodDeclaration): string | undefined {
  return objectLiteralOwnerName(method.getParentIfKind(SyntaxKind.ObjectLiteralExpression));
}

function objectLiteralOwnerName(objectLiteral: import("ts-morph").ObjectLiteralExpression | undefined): string | undefined {
  if (!objectLiteral) return undefined;
  const variableDeclaration = objectLiteral.getParentIfKind(SyntaxKind.VariableDeclaration);
  if (variableDeclaration) return variableDeclaration.getName();
  const property = objectLiteral.getParentIfKind(SyntaxKind.PropertyAssignment);
  if (!property) return undefined;
  const parentOwner = objectLiteralOwnerName(property.getParentIfKind(SyntaxKind.ObjectLiteralExpression));
  const propertyName = property.getName().replace(/^['"]|['"]$/g, "");
  return parentOwner ? `${parentOwner}.${propertyName}` : propertyName;
}

function getFunctionInitializer(node: TsNode | undefined): import("ts-morph").ArrowFunction | import("ts-morph").FunctionExpression | undefined {
  if (!node) return undefined;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (!Node.isCallExpression(node)) return undefined;
  const firstArgument = node.getArguments()[0];
  if (Node.isArrowFunction(firstArgument) || Node.isFunctionExpression(firstArgument)) return firstArgument;
  return undefined;
}
