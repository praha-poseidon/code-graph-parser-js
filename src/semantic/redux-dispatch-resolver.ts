import {
  Node,
  SyntaxKind,
  type CallExpression,
  type Node as TsNode,
  type ObjectLiteralExpression,
  type Project
} from "ts-morph";
import { resolveCallableExpressionIds, resolveFunctionDeclarationId, type SymbolResolveContext } from "./symbol-resolver.js";

export interface DispatchBindingIndex {
  direct: Map<string, string[]>;
  injected: Map<string, string[]>;
}

export function buildDispatchBindingIndex(project: Project | undefined, context: SymbolResolveContext): DispatchBindingIndex {
  const index: DispatchBindingIndex = { direct: new Map(), injected: new Map() };
  if (!project) return index;

  const modelEffects = indexModelEffects(project, context);
  for (const [key, targets] of modelEffects) index.direct.set(key, targets);

  for (const sourceFile of project.getSourceFiles()) {
    for (const outer of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const inner = unwrapExpression(outer.getExpression());
      if (!inner || !Node.isCallExpression(inner)) continue;
      const connectExpression = unwrapExpression(inner.getExpression());
      if (!connectExpression || !isConnectExpression(connectExpression)) continue;

      const componentExpression = outer.getArguments()[0];
      const mapDispatchExpression = inner.getArguments()[1];
      if (!componentExpression || !mapDispatchExpression) continue;

      const componentIds = resolveCallableExpressionIds(context, componentExpression);
      if (componentIds.length === 0) continue;
      const mapObjects = resolveMapDispatchObjects(mapDispatchExpression);
      for (const mapObject of mapObjects) {
        for (const property of mapObject.getProperties()) {
          const propName = propertyName(property);
          if (!propName) continue;
          const targets = dispatchTargetsIn(property, modelEffects);
          if (targets.length === 0) continue;
          for (const componentId of componentIds) {
            for (const callName of componentCallNames(componentExpression, propName)) {
              add(index.injected, `${componentId}|${callName}`, targets);
            }
          }
        }
      }
    }
  }
  return index;
}

export function dispatchTargetsForCall(index: DispatchBindingIndex, call: CallExpression): string[] {
  const key = staticDispatchKey(call.getExpression());
  return key ? index.direct.get(key) ?? [] : [];
}

export function injectedTargetsForCall(
  index: DispatchBindingIndex,
  currentFunctionId: string,
  callNames: string[]
): string[] {
  const targets: string[] = [];
  for (const callName of callNames) {
    targets.push(...(index.injected.get(`${currentFunctionId}|${callName}`) ?? []));
  }
  return unique(targets);
}

function indexModelEffects(project: Project, context: SymbolResolveContext): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const object of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const effects = object.getProperty("effects");
      if (!effects || !Node.isPropertyAssignment(effects)) continue;
      const effectsObject = unwrapExpression(effects.getInitializer());
      if (!effectsObject || !Node.isObjectLiteralExpression(effectsObject)) continue;

      const modelNames = modelNamesFor(object);
      if (modelNames.length === 0) continue;
      for (const effect of effectsObject.getProperties()) {
        const effectName = propertyName(effect);
        if (!effectName) continue;
        const target = resolveFunctionDeclarationId(context, effect);
        if (!target) continue;
        for (const modelName of modelNames) add(result, `${modelName}.${effectName}`, [target]);
      }
    }
  }
  return result;
}

function modelNamesFor(object: ObjectLiteralExpression): string[] {
  const names: string[] = [];
  const variable = object.getParentIfKind(SyntaxKind.VariableDeclaration);
  if (variable) names.push(variable.getName());
  for (const field of ["namespace", "name"]) {
    const property = object.getProperty(field);
    if (!property || !Node.isPropertyAssignment(property)) continue;
    const value = unwrapExpression(property.getInitializer());
    if (value && (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value))) {
      names.push(value.getLiteralText());
    }
  }
  return unique(names);
}

function resolveMapDispatchObjects(expression: TsNode): ObjectLiteralExpression[] {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) return [];
  if (Node.isObjectLiteralExpression(unwrapped)) return [unwrapped];
  if (!Node.isIdentifier(unwrapped)) return [];

  const objects: ObjectLiteralExpression[] = [];
  for (const declaration of unwrapped.getSymbol()?.getDeclarations() ?? []) {
    const callable = callableNode(declaration);
    if (!callable) continue;
    const body = callable.getBody();
    if (!body) continue;
    const direct = unwrapExpression(body);
    if (direct && Node.isObjectLiteralExpression(direct)) objects.push(direct);
    for (const statement of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      const returned = unwrapExpression(statement.getExpression());
      if (returned && Node.isObjectLiteralExpression(returned)) objects.push(returned);
    }
  }
  return objects;
}

function componentCallNames(expression: TsNode, propName: string): string[] {
  const names: string[] = [];
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped || !Node.isIdentifier(unwrapped)) return names;
  for (const declaration of unwrapped.getSymbol()?.getDeclarations() ?? []) {
    const callable = callableNode(declaration);
    if (!callable) continue;
    for (const parameter of callable.getParameters()) {
      const nameNode = parameter.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
          const sourceName = element.getPropertyNameNode()?.getText().replace(/^['"]|['"]$/g, "") ?? element.getName();
          if (sourceName === propName) names.push(element.getName());
        }
      } else if (Node.isIdentifier(nameNode)) {
        names.push(`${nameNode.getText()}.${propName}`);
      }
    }
    const body = callable.getBody();
    if (!body) continue;
    for (const variable of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const binding = variable.getNameNode();
      if (!Node.isObjectBindingPattern(binding)) continue;
      for (const element of binding.getElements()) {
        const sourceName = element.getPropertyNameNode()?.getText().replace(/^['"]|['"]$/g, "") ?? element.getName();
        if (sourceName === propName) names.push(element.getName());
      }
    }
  }
  return unique(names);
}

function dispatchTargetsIn(node: TsNode, models: Map<string, string[]>): string[] {
  const calls: CallExpression[] = [];
  if (Node.isCallExpression(node)) calls.push(node);
  calls.push(...node.getDescendantsOfKind(SyntaxKind.CallExpression));
  const targets: string[] = [];
  for (const call of calls) {
    const key = staticDispatchKey(call.getExpression());
    if (key) targets.push(...(models.get(key) ?? []));
  }
  return unique(targets);
}

function staticDispatchKey(expression: TsNode): string | undefined {
  const parts = propertyPath(unwrapExpression(expression));
  if (!parts || parts.length !== 3 || parts[0] !== "dispatch") return undefined;
  return `${parts[1]}.${parts[2]}`;
}

function propertyPath(node: TsNode | undefined): string[] | undefined {
  if (!node) return undefined;
  if (Node.isIdentifier(node)) return [node.getText()];
  if (!Node.isPropertyAccessExpression(node)) return undefined;
  const left = propertyPath(unwrapExpression(node.getExpression()));
  return left ? [...left, node.getName()] : undefined;
}

function callableNode(node: TsNode): import("ts-morph").FunctionDeclaration | import("ts-morph").ArrowFunction | import("ts-morph").FunctionExpression | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (!Node.isVariableDeclaration(node)) return undefined;
  const initializer = unwrapExpression(node.getInitializer());
  return initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) ? initializer : undefined;
}

function propertyName(node: TsNode): string | undefined {
  if (Node.isPropertyAssignment(node) || Node.isMethodDeclaration(node) || Node.isShorthandPropertyAssignment(node)) {
    return node.getName().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

function isConnectExpression(node: TsNode): boolean {
  if (Node.isIdentifier(node)) return node.getText() === "connect";
  return Node.isPropertyAccessExpression(node) && node.getName() === "connect";
}

function unwrapExpression(node: TsNode | undefined): TsNode | undefined {
  let current = node;
  while (current && (Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isNonNullExpression(current))) {
    current = current.getExpression();
  }
  return current;
}

function add(map: Map<string, string[]>, key: string, values: string[]): void {
  map.set(key, unique([...(map.get(key) ?? []), ...values]));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
