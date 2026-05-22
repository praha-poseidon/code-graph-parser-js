import path from "node:path";
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type FunctionDeclaration,
  type Node as TsNode,
  type SourceFile,
  type VariableDeclaration
} from "ts-morph";
import { EndpointRuleEngine } from "../endpoint/endpoint-rule-engine.js";
import { loadEndpointRules } from "../endpoint/rule-loader.js";
import { GraphBuilder } from "../graph/graph-builder.js";
import type { CodeFunction, CodeUnit, NodeLanguage } from "../model/code-graph.js";
import type { ParserOptions, ParseResult } from "../model/parser-options.js";
import { loadTypeScriptProject, resolveProjectName } from "../project/project-loader.js";
import { isProjectSourceFile, lineOf, relativeProjectPath } from "../util/path-utils.js";
import { isHookName, isPascalCase } from "../util/string-utils.js";
import { externalModuleId, ImportIndex } from "./import-index.js";
import { endpointId, functionId, moduleId, unitId } from "./node-id.js";

interface ParseContext {
  projectName: string;
  projectRoot: string;
  graph: GraphBuilder;
  importIndex: ImportIndex;
  endpointEngine: EndpointRuleEngine;
  options: ParserOptions;
}

interface FunctionCandidate {
  name: string;
  signature: string;
  node: TsNode;
  bodyNode: TsNode | undefined;
  isAsync: boolean;
  isComponent: boolean;
  subKind?: string;
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

    const rules = options.endpointRulesDir ? await loadEndpointRules(options.endpointRulesDir) : [];
    const importIndex = new ImportIndex(projectRoot);
    importIndex.index(sourceFiles);

    const context: ParseContext = {
      projectName,
      projectRoot,
      graph: new GraphBuilder(),
      importIndex,
      endpointEngine: new EndpointRuleEngine(rules),
      options: { ...options, projectRoot }
    };

    this.addProjectPackage(context);
    for (const sourceFile of sourceFiles) {
      this.parseSourceFile(sourceFile, context);
    }

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

  private addProjectPackage(context: ParseContext): void {
    context.graph.addPackage({
      id: context.projectName,
      name: context.projectName,
      qualifiedName: context.projectName,
      language: "unknown",
      projectFilePath: ".",
      gitRepoUrl: context.options.gitRepoUrl,
      gitBranch: context.options.gitBranch,
      nodeKind: "package",
      subKind: "frontend_project",
      packagePath: "."
    });
  }

  private parseSourceFile(sourceFile: SourceFile, context: ParseContext): void {
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    const language = languageOf(sourceFile.getFilePath());
    const moduleNodeId = moduleId(context.projectName, projectFilePath);

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
      packageId: context.projectName,
      attributes: {
        extension: path.extname(projectFilePath)
      }
    });

    context.graph.addRelationship({
      fromNodeId: context.projectName,
      toNodeId: moduleNodeId,
      relationshipType: "PACKAGE_TO_UNIT",
      language,
      confidence: "exact"
    });

    this.parseImports(sourceFile, context, moduleNodeId, language);

    const candidates = this.collectFunctionCandidates(sourceFile);
    for (const candidate of candidates) {
      const fn = this.addFunctionCandidate(sourceFile, context, moduleNodeId, language, candidate);
      this.parseFunctionBody(sourceFile, context, fn, candidate);
    }
  }

  private parseImports(sourceFile: SourceFile, context: ParseContext, moduleNodeId: string, language: NodeLanguage): void {
    for (const declaration of sourceFile.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const targetSource = declaration.getModuleSpecifierSourceFile();
      const targetId = targetSource && isProjectSourceFile(targetSource.getFilePath(), context.projectRoot)
        ? moduleId(context.projectName, relativeProjectPath(context.projectRoot, targetSource.getFilePath()))
        : externalModuleId(specifier);

      if (!targetSource) {
        context.graph.addUnit({
          id: targetId,
          name: specifier,
          qualifiedName: targetId,
          language: "unknown",
          projectFilePath: "",
          nodeKind: "external",
          subKind: "npm_module",
          unitType: "external_module",
          modifiers: [],
          attributes: { moduleSpecifier: specifier }
        });
      }

      context.graph.addRelationship({
        fromNodeId: moduleNodeId,
        toNodeId: targetId,
        relationshipType: "IMPORTS",
        language,
        lineNumber: lineOf(sourceFile, declaration.getStart()),
        confidence: targetSource ? "exact" : "heuristic",
        attributes: { moduleSpecifier: specifier }
      });
    }
  }

  private collectFunctionCandidates(sourceFile: SourceFile): FunctionCandidate[] {
    const candidates: FunctionCandidate[] = [];

    for (const declaration of sourceFile.getFunctions()) {
      const name = declaration.getName();
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

    for (const declaration of sourceFile.getVariableDeclarations()) {
      const name = declaration.getName();
      const initializer = declaration.getInitializer();
      if (!initializer || (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer))) continue;
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
      isStatic: false,
      isConstructor: false,
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

    if (candidate.isComponent) {
      const componentId = unitId(context.projectName, projectFilePath, candidate.name);
      const component: CodeUnit = {
        id: componentId,
        name: candidate.name,
        qualifiedName: componentId,
        language,
        projectFilePath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        startLine,
        endLine,
        nodeKind: "component",
        subKind: candidate.subKind ?? "react_function_component",
        unitType: candidate.subKind ?? "react_component",
        modifiers: [],
        packageId: moduleNodeId
      };
      context.graph.addUnit(component);
      context.graph.addRelationship({
        fromNodeId: moduleNodeId,
        toNodeId: component.id,
        relationshipType: "MODULE_TO_UNIT",
        language,
        confidence: "exact"
      });
      context.graph.addRelationship({
        fromNodeId: component.id,
        toNodeId: fn.id,
        relationshipType: "UNIT_TO_FUNCTION",
        language,
        confidence: "exact"
      });
    }

    return fn;
  }

  private parseFunctionBody(sourceFile: SourceFile, context: ParseContext, currentFn: CodeFunction, candidate: FunctionCandidate): void {
    const body = candidate.bodyNode;
    if (!body) return;

    for (const jsx of body.getDescendants().filter((node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node))) {
      const tagName = getJsxTagName(jsx);
      if (!tagName || !isPascalCase(tagName)) continue;
      const targetId = resolveImportedUnitId(context, sourceFile, tagName) ?? `${tagName}`;
      context.graph.addRelationship({
        fromNodeId: componentOrFunctionSourceId(context, sourceFile, candidate, currentFn),
        toNodeId: targetId,
        relationshipType: "RENDERS",
        language: currentFn.language,
        lineNumber: lineOf(sourceFile, jsx.getStart()),
        confidence: targetId === tagName ? "unresolved" : "inferred",
        attributes: { jsxTag: tagName }
      });
    }

    const calls = Node.isCallExpression(body)
      ? [body, ...body.getDescendantsOfKind(SyntaxKind.CallExpression)]
      : body.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      this.parseCallExpression(sourceFile, context, currentFn, call);
    }
  }

  private parseCallExpression(sourceFile: SourceFile, context: ParseContext, currentFn: CodeFunction, call: CallExpression): void {
    const calleeName = getCallName(call);
    if (!calleeName) return;

    for (const endpoint of context.endpointEngine.extract(call)) {
      const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
      const line = lineOf(sourceFile, call.getStart());
      const endpointNodeId = endpointId(context.projectName, projectFilePath, endpoint.matchIdentity, line);
      context.graph.addEndpoint({
        id: endpointNodeId,
        name: endpoint.matchIdentity,
        qualifiedName: endpointNodeId,
        language: currentFn.language,
        projectFilePath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        startLine: line,
        endLine: line,
        nodeKind: "endpoint",
        subKind: "http_outbound",
        endpointType: "HTTP",
        direction: "outbound",
        isExternal: true,
        parseLevel: endpoint.confidence === "exact" || endpoint.confidence === "inferred" ? "full" : "partial",
        matchIdentity: endpoint.matchIdentity,
        httpMethod: endpoint.method,
        path: endpoint.path,
        normalizedPath: endpoint.normalizedPath,
        attributes: {
          ruleId: endpoint.ruleId,
          rawPath: endpoint.rawPath,
          confidence: endpoint.confidence
        }
      });
      context.graph.addRelationship({
        fromNodeId: currentFn.id,
        toNodeId: endpointNodeId,
        relationshipType: "FUNCTION_TO_ENDPOINT",
        language: currentFn.language,
        lineNumber: line,
        confidence: endpoint.confidence,
        attributes: { ruleId: endpoint.ruleId }
      });
    }

    if (isHookName(calleeName)) {
      const target = resolveImportedFunctionId(context, sourceFile, calleeName) ?? calleeName;
      context.graph.addRelationship({
        fromNodeId: currentFn.id,
        toNodeId: target,
        relationshipType: "USES_HOOK",
        language: currentFn.language,
        lineNumber: lineOf(sourceFile, call.getStart()),
        confidence: target === calleeName ? "unresolved" : "inferred"
      });
      return;
    }

    const target = resolveCallTarget(context, sourceFile, calleeName);
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

function buildSignature(name: string, params: string[]): string {
  return `${name}(${params.join(",")})`;
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

function getCallName(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getText();
  return undefined;
}

function getObjectMethodName(property: import("ts-morph").PropertyAssignment): string | undefined {
  const propertyName = property.getName().replace(/^['"]|['"]$/g, "");
  const objectLiteral = property.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
  const variableDeclaration = objectLiteral?.getParentIfKind(SyntaxKind.VariableDeclaration);
  if (variableDeclaration) {
    return `${variableDeclaration.getName()}.${propertyName}`;
  }
  return propertyName;
}

function resolveImportedUnitId(context: ParseContext, sourceFile: SourceFile, localName: string): string | undefined {
  const imported = context.importIndex.get(sourceFile.getFilePath(), localName);
  if (!imported?.projectFilePath) return undefined;
  const exportedName = imported.importedName === "default" ? localName : imported.importedName;
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

function componentOrFunctionSourceId(context: ParseContext, sourceFile: SourceFile, candidate: FunctionCandidate, currentFn: CodeFunction): string {
  if (!candidate.isComponent) return currentFn.id;
  const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
  return unitId(context.projectName, projectFilePath, candidate.name);
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
  for (const declaration of sourceFile.getVariableDeclarations()) {
    if (declaration.getName() !== name) continue;
    const initializer = declaration.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return buildSignature(name, initializer.getParameters().map((param) => param.getText()));
    }
  }
  return undefined;
}
