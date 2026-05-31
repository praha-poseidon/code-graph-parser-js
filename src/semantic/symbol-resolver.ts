import {
  Node,
  SyntaxKind,
  type CallExpression,
  type Node as TsNode,
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
    const id = resolveFunctionDeclarationId(context, declaration);
    if (id) return id;
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
