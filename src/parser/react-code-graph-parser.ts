import fs from "node:fs";
import path from "node:path";
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type Node as TsNode,
  type SourceFile
} from "ts-morph";
import { GraphBuilder } from "../graph/graph-builder.js";
import type { CodeFunction, CodeUnit, NodeLanguage } from "../model/code-graph.js";
import type { ParserOptions, ParseResult } from "../model/parser-options.js";
import { loadTypeScriptProject, resolveProjectName } from "../project/project-loader.js";
import { StaticExtractEndpointProvider } from "../static-extract/static-extract-endpoint-provider.js";
import { isProjectSourceFile, lineOf, relativeProjectPath } from "../util/path-utils.js";
import { isHookName, isPascalCase } from "../util/string-utils.js";
import { ImportIndex } from "./import-index.js";
import { directoryPackageId, functionId, moduleId, unitId } from "./node-id.js";
import {
  buildSignature,
  resolveCallTargetId,
  resolveFunctionDeclarationId,
  resolveUnitDeclarationId
} from "../semantic/symbol-resolver.js";

interface ParseContext {
  projectName: string;
  projectRoot: string;
  graph: GraphBuilder;
  importIndex: ImportIndex;
  options: ParserOptions;
}

interface FunctionCandidate {
  name: string;
  signature: string;
  node: TsNode;
  bodyNode: TsNode | undefined;
  isAsync: boolean;
  isStatic?: boolean;
  isConstructor?: boolean;
  isComponent: boolean;
  subKind?: string;
  ownerUnitName?: string;
}

export class ReactCodeGraphParser {
  async parse(options: ParserOptions): Promise<ParseResult> {
    const projectRoot = path.resolve(options.projectRoot);
    const projectName = resolveProjectName(projectRoot, options.projectName);
    const project = await loadTypeScriptProject({ ...options, projectRoot });
    const sourceFiles = project
      .getSourceFiles()
      .filter((file) => isProjectSourceFile(file.getFilePath(), projectRoot))
      .filter((file) => isSupportedSourceFile(file.getFilePath()));

    const importIndex = new ImportIndex(projectRoot);
    importIndex.index(sourceFiles);

    const context: ParseContext = {
      projectName,
      projectRoot,
      graph: new GraphBuilder(),
      importIndex,
      options: { ...options, projectRoot }
    };

    // Directory packages are created on demand per file path (no project-root package).
    for (const sourceFile of sourceFiles) {
      this.parseSourceFile(sourceFile, context);
    }
    await new StaticExtractEndpointProvider().addEndpoints(context.graph, {
      projectName,
      projectRoot,
      sourceFiles,
      options: context.options
    });

    const graph = context.graph.graph;
    return {
      graph,
      stats: {
        files: sourceFiles.length,
        packages: graph.packages.length,
        units: graph.units.length,
        functions: graph.functions.length,
        endpoints: graph.endpoints.length,
        relationships: graph.relationships.length
      }
    };
  }

  /**
   * Build package nodes for each directory segment of a file path.
   * Project root (".") is intentionally NOT a package.
   * Returns the immediate parent directory package id for the file, or undefined
   * when the file lives at the project root.
   */
  private ensureDirectoryPackages(context: ParseContext, projectFilePath: string): string | undefined {
    const normalized = projectFilePath.split(path.sep).join("/");
    const dir = path.posix.dirname(normalized);
    if (!dir || dir === "." || dir === "/") {
      return undefined;
    }

    const segments = dir.split("/").filter(Boolean);
    let currentPath = "";
    let parentPackageId: string | undefined;
    let leafPackageId: string | undefined;

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const packageId = directoryPackageId(context.projectName, currentPath);
      context.graph.addPackage({
        id: packageId,
        name: segment,
        qualifiedName: currentPath,
        language: "unknown",
        projectFilePath: currentPath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        nodeKind: "package",
        subKind: "directory",
        packagePath: currentPath,
        attributes: {
          parentPackageId: parentPackageId ?? null
        }
      });

      if (parentPackageId) {
        context.graph.addRelationship({
          fromNodeId: parentPackageId,
          toNodeId: packageId,
          relationshipType: "PACKAGE_TO_PACKAGE",
          language: "unknown",
          confidence: "exact"
        });
      }

      parentPackageId = packageId;
      leafPackageId = packageId;
    }

    return leafPackageId;
  }

  private parseSourceFile(sourceFile: SourceFile, context: ParseContext): void {
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    const language = languageOf(sourceFile.getFilePath());
    const moduleNodeId = moduleId(context.projectName, projectFilePath);
    const parentPackageId = this.ensureDirectoryPackages(context, projectFilePath);

    context.graph.addUnit({
      id: moduleNodeId,
      name: path.basename(projectFilePath),
      qualifiedName: moduleNodeId,
      language,
      projectFilePath,
      gitRepoUrl: context.options.gitRepoUrl,
      gitBranch: context.options.gitBranch,
      startLine: 1,
      endLine: sourceFile.getEndLineNumber(),
      nodeKind: "module",
      subKind: "source_file",
      unitType: "module",
      modifiers: [],
      packageId: parentPackageId,
      attributes: {
        extension: path.extname(projectFilePath)
      }
    });

    if (parentPackageId) {
      context.graph.addRelationship({
        fromNodeId: parentPackageId,
        toNodeId: moduleNodeId,
        relationshipType: "PACKAGE_TO_UNIT",
        language,
        confidence: "exact"
      });
    }

    const candidates = this.collectFunctionCandidates(sourceFile);
    for (const candidate of candidates) {
      const fn = this.addFunctionCandidate(sourceFile, context, moduleNodeId, language, candidate);
      this.parseFunctionBody(sourceFile, context, fn, candidate);
    }
  }

  private collectFunctionCandidates(sourceFile: SourceFile): FunctionCandidate[] {
    const candidates: FunctionCandidate[] = [];

    for (const declaration of sourceFile.getFunctions()) {
      const name = declaration.getName() ?? (declaration.isDefaultExport() ? "default" : undefined);
      if (!name) continue;
      candidates.push({
        name,
        signature: buildSignature(name, declaration.getParameters().map((param) => param.getText())),
        node: declaration,
        bodyNode: declaration.getBody(),
        isAsync: declaration.isAsync(),
        isComponent: isPascalCase(name) && containsJsx(declaration),
        subKind: isHookName(name) ? "react_hook" : undefined
      });
    }

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
      if (declaration.getParent() === sourceFile) continue;
      const name = declaration.getName();
      if (!name) continue;
      candidates.push({
        name,
        signature: buildSignature(name, declaration.getParameters().map((param) => param.getText())),
        node: declaration,
        bodyNode: declaration.getBody(),
        isAsync: declaration.isAsync(),
        isComponent: false,
        subKind: "nested_function"
      });
    }

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = declaration.getName();
      const initializer = getFunctionInitializer(declaration.getInitializer());
      if (!initializer) continue;
      candidates.push({
        name,
        signature: buildSignature(name, initializer.getParameters().map((param) => param.getText())),
        node: declaration,
        bodyNode: initializer.getBody(),
        isAsync: initializer.isAsync(),
        isComponent: isPascalCase(name) && containsJsx(initializer),
        subKind: isHookName(name) ? "react_hook" : undefined
      });
    }

    const exportAssignment = sourceFile.getExportAssignment((assignment) => !assignment.isExportEquals());
    const exportExpression = exportAssignment?.getExpression();
    if (exportAssignment && exportExpression && (Node.isArrowFunction(exportExpression) || Node.isFunctionExpression(exportExpression))) {
      candidates.push({
        name: "default",
        signature: buildSignature("default", exportExpression.getParameters().map((param) => param.getText())),
        node: exportAssignment,
        bodyNode: exportExpression.getBody(),
        isAsync: exportExpression.isAsync(),
        isComponent: containsJsx(exportExpression),
        subKind: containsJsx(exportExpression) ? "react_default_component" : "default_export_function"
      });
    }

    for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const initializer = property.getInitializer();
      if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) continue;
      const name = getObjectMethodName(property);
      if (!name) continue;
      candidates.push({
        name,
        signature: buildSignature(name, initializer.getParameters().map((param) => param.getText())),
        node: property,
        bodyNode: initializer.getBody(),
        isAsync: initializer.isAsync(),
        isComponent: false,
        subKind: "object_method"
      });
    }

    for (const method of sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
      if (!method.getParentIfKind(SyntaxKind.ObjectLiteralExpression)) continue;
      const name = getObjectLiteralMethodName(method);
      if (!name) continue;
      candidates.push({
        name,
        signature: buildSignature(name, method.getParameters().map((param) => param.getText())),
        node: method,
        bodyNode: method.getBody(),
        isAsync: method.isAsync(),
        isComponent: false,
        subKind: "object_method"
      });
    }

    for (const declaration of sourceFile.getClasses()) {
      const name = declaration.getName();
      if (!name || !isReactClassComponent(declaration)) continue;
      candidates.push({
        name,
        signature: `${name}.render()`,
        node: declaration,
        bodyNode: declaration,
        isAsync: false,
        isComponent: true,
        subKind: "react_class_component"
      });
    }

    for (const declaration of sourceFile.getClasses()) {
      const className = declaration.getName();
      if (!className) continue;
      for (const constructor of declaration.getConstructors()) {
        candidates.push({
          name: `${className}.constructor`,
          signature: buildSignature(`${className}.constructor`, constructor.getParameters().map((param) => param.getText())),
          node: constructor,
          bodyNode: constructor.getBody(),
          isAsync: false,
          isConstructor: true,
          isComponent: false,
          subKind: "class_constructor",
          ownerUnitName: className
        });
      }
      for (const property of declaration.getProperties()) {
        const initializer = property.getInitializer();
        if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) continue;
        const propertyName = property.getName();
        candidates.push({
          name: `${className}.${propertyName}`,
          signature: buildSignature(`${className}.${propertyName}`, initializer.getParameters().map((param) => param.getText())),
          node: property,
          bodyNode: initializer.getBody(),
          isAsync: initializer.isAsync(),
          isStatic: property.isStatic(),
          isComponent: false,
          subKind: "class_property_method",
          ownerUnitName: className
        });
      }
      for (const method of declaration.getMethods()) {
        const methodName = method.getName();
        candidates.push({
          name: `${className}.${methodName}`,
          signature: buildSignature(`${className}.${methodName}`, method.getParameters().map((param) => param.getText())),
          node: method,
          bodyNode: method.getBody(),
          isAsync: method.isAsync(),
          isStatic: method.isStatic(),
          isComponent: false,
          subKind: "class_method",
          ownerUnitName: className
        });
      }
    }

    for (const declaration of sourceFile.getInterfaces()) {
      const interfaceName = declaration.getName();
      for (const method of declaration.getMethods()) {
        const methodName = method.getName();
        candidates.push({
          name: `${interfaceName}.${methodName}`,
          signature: buildSignature(`${interfaceName}.${methodName}`, method.getParameters().map((param) => param.getText())),
          node: method,
          bodyNode: undefined,
          isAsync: false,
          isComponent: false,
          subKind: "interface_method",
          ownerUnitName: interfaceName
        });
      }
    }

    return candidates;
  }

  private addFunctionCandidate(
    sourceFile: SourceFile,
    context: ParseContext,
    moduleNodeId: string,
    language: NodeLanguage,
    candidate: FunctionCandidate
  ): CodeFunction {
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    const fnId = functionId(context.projectName, projectFilePath, candidate.signature);
    const startLine = lineOf(sourceFile, candidate.node.getStart());
    const endLine = lineOf(sourceFile, candidate.node.getEnd());

    const fn: CodeFunction = {
      id: fnId,
      name: candidate.name,
      qualifiedName: fnId,
      language,
      projectFilePath,
      gitRepoUrl: context.options.gitRepoUrl,
      gitBranch: context.options.gitBranch,
      startLine,
      endLine,
      nodeKind: "function",
      subKind: candidate.subKind ?? (candidate.isComponent ? "react_component_render" : "function"),
      signature: candidate.signature,
      returnType: inferReturnType(candidate),
      modifiers: [],
      isAsync: candidate.isAsync,
      isStatic: candidate.isStatic ?? false,
      isConstructor: candidate.isConstructor ?? false,
      isPlaceholder: false
    };

    context.graph.addFunction(fn);
    context.graph.addRelationship({
      fromNodeId: moduleNodeId,
      toNodeId: fn.id,
      relationshipType: "UNIT_TO_FUNCTION",
      language,
      confidence: "exact"
    });

    return fn;
  }

  private parseFunctionBody(sourceFile: SourceFile, context: ParseContext, currentFn: CodeFunction, candidate: FunctionCandidate): void {
    const body = candidate.bodyNode;
    if (!body) return;

    for (const jsx of localDescendants(body).filter((node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node))) {
      const tagName = getJsxTagName(jsx);
      if (!tagName || !isPascalCase(tagName)) continue;

      // Component render edge: parent function/component → child component function.
      const targetFnId = resolveRenderedComponentFunctionId(context, sourceFile, jsx, tagName);
      if (targetFnId && targetFnId !== currentFn.id) {
        ensurePlaceholderFunction(context, targetFnId, currentFn.language);
        context.graph.addRelationship({
          fromNodeId: currentFn.id,
          toNodeId: targetFnId,
          relationshipType: "RENDERS",
          language: currentFn.language,
          lineNumber: lineOf(sourceFile, jsx.getStart()),
          confidence: "inferred",
          attributes: { tagName, source: "jsx-component" }
        });
      }
    }

    const calls = localDescendants(body).filter(Node.isCallExpression);
    for (const call of calls) {
      this.parseCallExpression(sourceFile, context, currentFn, call);
    }
  }

  private parseCallExpression(sourceFile: SourceFile, context: ParseContext, currentFn: CodeFunction, call: CallExpression): void {
    const calleeName = getCallName(call);
    if (!calleeName) return;

    // HTTP endpoints come only from static-extract (SER), not a built-in rule engine.

    const target = resolveCallTargetId(context, call) ?? resolveCallTarget(context, sourceFile, calleeName);
    if (target && target !== currentFn.id) {
      context.graph.addRelationship({
        fromNodeId: currentFn.id,
        toNodeId: target,
        relationshipType: "CALLS",
        language: currentFn.language,
        lineNumber: lineOf(sourceFile, call.getStart()),
        callType: "direct",
        confidence: target === calleeName ? "unresolved" : "inferred"
      });
    }
  }

}

function isSupportedSourceFile(filePath: string): boolean {
  return /\.(jsx?|tsx?|mjs|cjs)$/i.test(filePath);
}


function languageOf(filePath: string): NodeLanguage {
  return /\.(ts|tsx)$/i.test(filePath) ? "typescript" : "javascript";
}

function containsJsx(node: TsNode): boolean {
  return node.getDescendants().some((descendant) =>
    Node.isJsxElement(descendant) ||
    Node.isJsxSelfClosingElement(descendant) ||
    Node.isJsxFragment(descendant)
  );
}

function isReactClassComponent(declaration: ClassDeclaration): boolean {
  return declaration.getExtends()?.getText().includes("Component") === true && containsJsx(declaration);
}

function inferReturnType(candidate: FunctionCandidate): string {
  if (candidate.isComponent) return "ReactElement";
  if (candidate.subKind === "react_hook") return "unknown";
  return "unknown";
}

function getJsxTagName(node: TsNode): string | undefined {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    return node.getTagNameNode().getText().split(".")[0];
  }
  return undefined;
}


function resolveFunctionId(context: ParseContext, sourceFile: SourceFile, functionName: string): string | undefined {
  if (functionName.includes(".")) return resolveCallTarget(context, sourceFile, functionName);
  const imported = resolveImportedFunctionId(context, sourceFile, functionName);
  if (imported) return imported;
  const signature = findExportedSignature(sourceFile, functionName);
  if (!signature) return undefined;
  return functionId(context.projectName, relativeProjectPath(context.projectRoot, sourceFile.getFilePath()), signature);
}

function getCallName(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getText();
  return undefined;
}

function getObjectMethodName(property: import("ts-morph").PropertyAssignment): string | undefined {
  const propertyName = property.getName().replace(/^['"]|['"]$/g, "");
  const ownerName = objectLiteralOwnerName(property.getParentIfKind(SyntaxKind.ObjectLiteralExpression));
  return ownerName ? `${ownerName}.${propertyName}` : propertyName;
}

function getObjectLiteralMethodName(method: import("ts-morph").MethodDeclaration): string | undefined {
  const methodName = method.getName();
  const ownerName = objectLiteralOwnerName(method.getParentIfKind(SyntaxKind.ObjectLiteralExpression));
  return ownerName ? `${ownerName}.${methodName}` : methodName;
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

function resolveImportedUnitId(context: ParseContext, sourceFile: SourceFile, localName: string): string | undefined {
  const imported = context.importIndex.get(sourceFile.getFilePath(), localName);
  if (!imported?.projectFilePath) return undefined;
  const targetSource = imported.sourceFilePath ? sourceFile.getProject().getSourceFile(imported.sourceFilePath) : undefined;
  const exportedName = imported.importedName === "default"
    ? findDefaultExportedUnitName(targetSource) ?? localName
    : imported.importedName;
  return unitId(context.projectName, imported.projectFilePath, exportedName);
}

function resolveImportedFunctionId(context: ParseContext, sourceFile: SourceFile, localName: string): string | undefined {
  const imported = context.importIndex.get(sourceFile.getFilePath(), localName);
  if (!imported?.projectFilePath) return undefined;
  const exportedName = imported.importedName === "default" ? localName : imported.importedName;
  const targetSource = imported.sourceFilePath ? sourceFile.getProject().getSourceFile(imported.sourceFilePath) : undefined;
  const signature = targetSource ? findExportedSignature(targetSource, exportedName) : undefined;
  return functionId(context.projectName, imported.projectFilePath, signature ?? `${exportedName}()`);
}

/**
 * Resolve a JSX component tag to a function node id (for RENDERS edges).
 * Handles: direct imports, local components, React.lazy(() => import(...)), and one-level HOC wrappers.
 */
function resolveRenderedComponentFunctionId(
  context: ParseContext,
  sourceFile: SourceFile,
  jsx: TsNode,
  tagName: string
): string | undefined {
  if (!Node.isJsxOpeningElement(jsx) && !Node.isJsxSelfClosingElement(jsx)) {
    return resolveImportedFunctionId(context, sourceFile, tagName);
  }

  const tagNode = jsx.getTagNameNode();
  const nameNode = Node.isPropertyAccessExpression(tagNode) ? tagNode.getExpression() : tagNode;
  const symbol = nameNode.getSymbol?.() ?? tagNode.getSymbol?.();
  const declarations = [
    ...(symbol?.getAliasedSymbol?.()?.getDeclarations?.() ?? []),
    ...(symbol?.getDeclarations?.() ?? [])
  ];

  for (const declaration of declarations) {
    const id = resolveComponentDeclarationToFunctionId(context, sourceFile, declaration);
    if (id) return id;
  }

  // Fallback: import index (named / default)
  return resolveImportedFunctionId(context, sourceFile, tagName)
    ?? resolveFunctionId(context, sourceFile, tagName);
}

function resolveComponentDeclarationToFunctionId(
  context: ParseContext,
  sourceFile: SourceFile,
  declaration: TsNode
): string | undefined {
  // const Editor = lazy(() => import('./Editor'))
  const lazyId = resolveLazyVariableToFunctionId(context, sourceFile, declaration);
  if (lazyId) return lazyId;

  // const X = connect(...)(Inner) / memo(Inner) / forwardRef(Inner)
  const unwrapped = unwrapHocToFunctionId(context, declaration);
  if (unwrapped) return unwrapped;

  const direct = resolveFunctionDeclarationId(context, declaration);
  if (direct) return direct;

  // ImportSpecifier / ImportClause → follow module
  if (Node.isImportSpecifier(declaration) || Node.isImportClause(declaration) || Node.isNamespaceImport(declaration)) {
    const localName = Node.isImportSpecifier(declaration)
      ? declaration.getName()
      : Node.isImportClause(declaration)
        ? declaration.getDefaultImport()?.getText()
        : undefined;
    if (localName) {
      return resolveImportedFunctionId(context, sourceFile, localName);
    }
  }

  return undefined;
}

function resolveLazyVariableToFunctionId(
  context: ParseContext,
  sourceFile: SourceFile,
  declaration: TsNode
): string | undefined {
  if (!Node.isVariableDeclaration(declaration)) return undefined;
  const initializer = declaration.getInitializer();
  if (!initializer || !Node.isCallExpression(initializer)) return undefined;

  const calleeText = initializer.getExpression().getText();
  if (!/(^|\.)lazy$/.test(calleeText)) return undefined;

  const factory = initializer.getArguments()[0];
  if (!factory || (!Node.isArrowFunction(factory) && !Node.isFunctionExpression(factory))) return undefined;

  const importPath = findDynamicImportModuleSpecifier(factory);
  if (!importPath) return undefined;

  const targetFile = resolveModuleSourceFile(sourceFile, importPath);
  if (!targetFile) return undefined;
  if (!isProjectSourceFile(targetFile.getFilePath(), context.projectRoot)) return undefined;

  const projectFilePath = relativeProjectPath(context.projectRoot, targetFile.getFilePath());
  const signature = findDefaultExportedFunctionSignature(targetFile);
  if (signature) {
    return functionId(context.projectName, projectFilePath, signature);
  }
  // Fallback: file default component name from path
  const baseName = projectFilePath.split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "") ?? "default";
  const componentName = baseName === "index"
    ? projectFilePath.split("/").filter(Boolean).at(-2) ?? "Component"
    : baseName;
  return functionId(context.projectName, projectFilePath, `${componentName}()`);
}

function findDynamicImportModuleSpecifier(factory: TsNode): string | undefined {
  const consider = (call: import("ts-morph").CallExpression): string | undefined => {
    const expr = call.getExpression();
    const isImport = expr.getKind() === SyntaxKind.ImportKeyword || expr.getText() === "import";
    if (!isImport) return undefined;
    const arg = call.getArguments()[0];
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      return arg.getLiteralText();
    }
    return undefined;
  };

  if (Node.isCallExpression(factory)) {
    const direct = consider(factory);
    if (direct) return direct;
  }
  if (Node.isArrowFunction(factory) || Node.isFunctionExpression(factory)) {
    const body = factory.getBody();
    if (Node.isCallExpression(body)) {
      const direct = consider(body);
      if (direct) return direct;
    }
    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const found = consider(call);
      if (found) return found;
    }
  }
  return undefined;
}

function resolveModuleSourceFile(sourceFile: SourceFile, moduleSpecifier: string): SourceFile | undefined {
  const project = sourceFile.getProject();
  const currentDir = path.dirname(sourceFile.getFilePath());
  const candidates: string[] = [];
  if (moduleSpecifier.startsWith(".")) {
    const base = path.resolve(currentDir, moduleSpecifier);
    // Prefer index / extension forms first; bare `base` may be a directory (EISDIR).
    candidates.push(
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
      path.join(base, "index.ts"), path.join(base, "index.tsx"),
      path.join(base, "index.js"), path.join(base, "index.jsx"),
      base
    );
  } else {
    // Alias / absolute-style specs: match already-loaded source files by path suffix
    for (const sf of project.getSourceFiles()) {
      const fp = sf.getFilePath().replace(/\\/g, "/");
      const spec = moduleSpecifier.replace(/^@\//, "src/");
      if (fp.endsWith(`/${spec}`) || fp.endsWith(`/${spec}.js`) || fp.endsWith(`/${spec}.jsx`)
        || fp.endsWith(`/${spec}.ts`) || fp.endsWith(`/${spec}.tsx`)
        || fp.endsWith(`/${spec}/index.js`) || fp.endsWith(`/${spec}/index.jsx`)
        || fp.endsWith(`/${spec}/index.ts`) || fp.endsWith(`/${spec}/index.tsx`)) {
        return sf;
      }
    }
  }

  for (const candidate of candidates) {
    // Skip directories — addSourceFileAtPathIfExists throws EISDIR on them.
    try {
      if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    const sf = project.getSourceFile(candidate) ?? project.addSourceFileAtPathIfExists(candidate);
    if (sf) return sf;
  }
  return undefined;
}

function findDefaultExportedFunctionSignature(sourceFile: SourceFile): string | undefined {
  // export default function Foo
  for (const declaration of sourceFile.getFunctions()) {
    if (declaration.isDefaultExport() && declaration.getName()) {
      return buildSignature(declaration.getName()!, declaration.getParameters().map((p) => p.getText()));
    }
  }
  // export default connect(...)(Foo) / memo(Foo) / Foo
  const defaultExport = sourceFile.getDefaultExportSymbol();
  const declarations = defaultExport?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (Node.isFunctionDeclaration(declaration) && declaration.getName()) {
      return buildSignature(declaration.getName()!, declaration.getParameters().map((p) => p.getText()));
    }
    if (Node.isVariableDeclaration(declaration)) {
      const sig = signatureFromVariableComponent(declaration);
      if (sig) return sig;
    }
    if (Node.isExportAssignment(declaration)) {
      const expr = declaration.getExpression();
      const sig = signatureFromComponentExpression(sourceFile, expr);
      if (sig) return sig;
    }
  }

  // export default Foo where Foo is a local const/function
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    if (name !== "default") continue;
    for (const declaration of declarations) {
      if (Node.isFunctionDeclaration(declaration) && declaration.getName()) {
        return buildSignature(declaration.getName()!, declaration.getParameters().map((p) => p.getText()));
      }
      if (Node.isVariableDeclaration(declaration)) {
        const sig = signatureFromVariableComponent(declaration);
        if (sig) return sig;
      }
      if (Node.isIdentifier(declaration)) {
        const symbol = declaration.getSymbol();
        for (const d of symbol?.getDeclarations() ?? []) {
          const id = resolveFunctionDeclarationId(
            { projectName: "", projectRoot: path.dirname(sourceFile.getFilePath()) },
            d
          );
          // resolveFunctionDeclarationId needs real project context — use local helpers instead
          if (Node.isFunctionDeclaration(d) && d.getName()) {
            return buildSignature(d.getName()!, d.getParameters().map((p) => p.getText()));
          }
          if (Node.isVariableDeclaration(d)) {
            const sig = signatureFromVariableComponent(d);
            if (sig) return sig;
          }
        }
      }
    }
  }

  // Fallback: first PascalCase function/component in file
  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();
    if (name && isPascalCase(name)) {
      return buildSignature(name, declaration.getParameters().map((p) => p.getText()));
    }
  }
  for (const declaration of sourceFile.getVariableDeclarations()) {
    if (!isPascalCase(declaration.getName())) continue;
    const sig = signatureFromVariableComponent(declaration);
    if (sig) return sig;
  }
  return undefined;
}

function signatureFromVariableComponent(declaration: import("ts-morph").VariableDeclaration): string | undefined {
  const name = declaration.getName();
  const initializer = declaration.getInitializer();
  if (!initializer) return undefined;
  // peel HOC: connect(a)(b)(Inner) — walk call chain for function/identifier
  const peeled = peelComponentExpression(initializer);
  if (peeled && (Node.isArrowFunction(peeled) || Node.isFunctionExpression(peeled))) {
    return buildSignature(name, peeled.getParameters().map((p) => p.getText()));
  }
  if (peeled && Node.isIdentifier(peeled)) {
    const symbol = peeled.getSymbol();
    for (const d of symbol?.getDeclarations() ?? []) {
      if (Node.isFunctionDeclaration(d) && d.getName()) {
        return buildSignature(d.getName()!, d.getParameters().map((p) => p.getText()));
      }
      if (Node.isVariableDeclaration(d)) {
        const inner = getFunctionInitializer(d.getInitializer());
        if (inner) return buildSignature(d.getName(), inner.getParameters().map((p) => p.getText()));
      }
    }
  }
  const direct = getFunctionInitializer(initializer);
  if (direct) return buildSignature(name, direct.getParameters().map((p) => p.getText()));
  return undefined;
}

function signatureFromComponentExpression(sourceFile: SourceFile, expr: TsNode): string | undefined {
  const peeled = peelComponentExpression(expr);
  if (!peeled) return undefined;
  if (Node.isArrowFunction(peeled) || Node.isFunctionExpression(peeled)) {
    return buildSignature("anonymous", peeled.getParameters().map((p) => p.getText()));
  }
  if (Node.isIdentifier(peeled)) {
    const name = peeled.getText();
    for (const declaration of sourceFile.getFunctions()) {
      if (declaration.getName() === name) {
        return buildSignature(name, declaration.getParameters().map((p) => p.getText()));
      }
    }
    for (const declaration of sourceFile.getVariableDeclarations()) {
      if (declaration.getName() === name) {
        return signatureFromVariableComponent(declaration);
      }
    }
  }
  return undefined;
}

/** Walk connect(x)(y) / memo(x) / forwardRef(x) to the innermost expression. */
function peelComponentExpression(expr: TsNode): TsNode | undefined {
  let current: TsNode | undefined = expr;
  for (let i = 0; i < 6 && current; i += 1) {
    if (Node.isCallExpression(current)) {
      // connect(map)(Component): peel into first arg of the current call
      const candidate: TsNode | undefined = current.getArguments()[0];
      if (candidate) {
        current = candidate;
        continue;
      }
    }
    if (Node.isParenthesizedExpression(current) || Node.isAsExpression(current)) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return current;
}

function unwrapHocToFunctionId(context: ParseContext, declaration: TsNode): string | undefined {
  if (!Node.isVariableDeclaration(declaration) && !Node.isExportAssignment(declaration)) {
    // export default connect(...)(Foo) handled via ExportAssignment in findDefaultExportedFunctionSignature
    if (Node.isFunctionDeclaration(declaration)) {
      return resolveFunctionDeclarationId(context, declaration);
    }
  }
  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) return undefined;
    const peeled = peelComponentExpression(initializer);
    if (peeled && Node.isIdentifier(peeled)) {
      const symbol = peeled.getSymbol();
      for (const d of symbol?.getDeclarations() ?? []) {
        const id = resolveFunctionDeclarationId(context, d);
        if (id) return id;
      }
    }
    if (peeled && (Node.isArrowFunction(peeled) || Node.isFunctionExpression(peeled))) {
      return resolveFunctionDeclarationId(context, declaration);
    }
  }
  return undefined;
}

function ensurePlaceholderFunction(context: ParseContext, functionNodeId: string, language: NodeLanguage): void {
  if (context.graph.hasFunction(functionNodeId)) return;
  // id format: project#path::signature
  const hash = functionNodeId.indexOf("#");
  const rest = hash >= 0 ? functionNodeId.slice(hash + 1) : functionNodeId;
  const sep = rest.indexOf("::");
  const projectFilePath = sep >= 0 ? rest.slice(0, sep) : rest;
  const signature = sep >= 0 ? rest.slice(sep + 2) : "Component()";
  const name = signature.replace(/\(.*\)$/, "") || "Component";
  context.graph.addFunction({
    id: functionNodeId,
    name,
    qualifiedName: functionNodeId,
    language,
    projectFilePath,
    startLine: 1,
    endLine: 1,
    nodeKind: "function",
    subKind: "placeholder_component",
    signature,
    returnType: "ReactElement",
    modifiers: [],
    isAsync: false,
    isStatic: false,
    isConstructor: false,
    isPlaceholder: true
  });
}

function resolveJsxTagUnitId(context: ParseContext, jsx: TsNode): string | undefined {
  if (!Node.isJsxOpeningElement(jsx) && !Node.isJsxSelfClosingElement(jsx)) return undefined;
  const tagNode = jsx.getTagNameNode();
  const symbol = tagNode.getSymbol();
  if (!symbol) return undefined;
  for (const declaration of symbol.getDeclarations()) {
    const id = resolveUnitDeclarationId(context, declaration);
    if (id) return id;
    const aliasedSymbol = declaration.getSymbol()?.getAliasedSymbol();
    for (const aliasedDeclaration of aliasedSymbol?.getDeclarations() ?? []) {
      const aliasedId = resolveUnitDeclarationId(context, aliasedDeclaration);
      if (aliasedId) return aliasedId;
    }
  }
  return undefined;
}

function resolveCallTarget(context: ParseContext, sourceFile: SourceFile, calleeName: string): string | undefined {
  if (calleeName.includes(".")) return undefined;
  const imported = resolveImportedFunctionId(context, sourceFile, calleeName);
  if (imported) return imported;
  return undefined;
}

function findExportedSignature(sourceFile: SourceFile, name: string): string | undefined {
  for (const declaration of sourceFile.getFunctions()) {
    if (declaration.getName() === name) {
      return buildSignature(name, declaration.getParameters().map((param) => param.getText()));
    }
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (declaration.getName() !== name) continue;
    const initializer = getFunctionInitializer(declaration.getInitializer());
    if (initializer) {
      return buildSignature(name, initializer.getParameters().map((param) => param.getText()));
    }
  }
  return undefined;
}

function getFunctionInitializer(node: TsNode | undefined): import("ts-morph").ArrowFunction | import("ts-morph").FunctionExpression | undefined {
  if (!node) return undefined;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (!Node.isCallExpression(node)) return undefined;
  const firstArgument = node.getArguments()[0];
  if (Node.isArrowFunction(firstArgument) || Node.isFunctionExpression(firstArgument)) return firstArgument;
  return undefined;
}

function findDefaultExportedUnitName(sourceFile: SourceFile | undefined): string | undefined {
  if (!sourceFile) return undefined;
  for (const declaration of [
    ...sourceFile.getClasses(),
    ...sourceFile.getFunctions()
  ]) {
    if (declaration.isDefaultExport()) return declaration.getName();
  }
  for (const declaration of sourceFile.getVariableDeclarations()) {
    if (declaration.getVariableStatementOrThrow().isDefaultExport()) return declaration.getName();
  }
  return undefined;
}


function localDescendants(body: TsNode): TsNode[] {
  const descendants = Node.isCallExpression(body) ? [body, ...body.getDescendants()] : body.getDescendants();
  return descendants.filter((node) => node === body || !hasNestedFunctionBoundary(node, body));
}

function hasNestedFunctionBoundary(node: TsNode, root: TsNode): boolean {
  let current = node.getParent();
  while (current && current !== root) {
    if (isFunctionBoundary(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function isFunctionBoundary(node: TsNode): boolean {
  if (Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)) {
    return true;
  }
  if (Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
    const parent = node.getParent();
    return Node.isVariableDeclaration(parent) ||
      Node.isPropertyDeclaration(parent) ||
      Node.isPropertyAssignment(parent) ||
      Node.isExportAssignment(parent);
  }
  return false;
}
