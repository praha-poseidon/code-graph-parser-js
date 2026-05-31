import path from "node:path";
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type Node as TsNode,
  type SourceFile
} from "ts-morph";
import { EndpointRuleEngine } from "../endpoint/endpoint-rule-engine.js";
import { loadEndpointRules } from "../endpoint/rule-loader.js";
import { GraphBuilder } from "../graph/graph-builder.js";
import type { CodeFunction, CodeUnit, NodeLanguage } from "../model/code-graph.js";
import type { ParserOptions, ParseResult } from "../model/parser-options.js";
import { loadTypeScriptProject, resolveProjectName } from "../project/project-loader.js";
import { StaticExtractEndpointProvider } from "../static-extract/static-extract-endpoint-provider.js";
import { extractReactUiInteraction } from "../ui/react-ui-interaction-extractor.js";
import { addUiInteractionEndpoint } from "../ui/ui-endpoint-builder.js";
import { isProjectSourceFile, lineOf, relativeProjectPath } from "../util/path-utils.js";
import { isHookName, isPascalCase } from "../util/string-utils.js";
import { externalModuleId, ImportIndex } from "./import-index.js";
import { endpointId, functionId, moduleId, unitId } from "./node-id.js";
import {
  buildSignature,
  resolveCallTargetId,
  resolveFunctionDeclarationId,
  resolveUnitDeclarationId,
  resolveTypeReferenceUnitId
} from "../semantic/symbol-resolver.js";
import { ValueTracer } from "../endpoint/value-tracer.js";

interface ParseContext {
  projectName: string;
  projectRoot: string;
  graph: GraphBuilder;
  importIndex: ImportIndex;
  endpointEngine: EndpointRuleEngine;
  options: ParserOptions;
  componentPropHandlers: Map<string, Set<string>>;
  pendingPropEndpoints: Map<string, PropEndpointReference[]>;
  routePrefixes: Map<string, string>;
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

interface PropEndpointReference {
  endpointNodeId: string;
  language: NodeLanguage;
  line: number;
  eventType: string;
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
      options: { ...options, projectRoot },
      componentPropHandlers: new Map(),
      pendingPropEndpoints: new Map(),
      routePrefixes: new Map()
    };

    this.addProjectPackage(context);
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
    collectRoutePrefixes(sourceFile, context);
    this.parseTypeUnits(sourceFile, context, moduleNodeId, language);
    this.parseExports(sourceFile, context, moduleNodeId, language);

    const candidates = this.collectFunctionCandidates(sourceFile);
    for (const candidate of candidates) {
      const fn = this.addFunctionCandidate(sourceFile, context, moduleNodeId, language, candidate);
      this.parseFunctionBody(sourceFile, context, fn, candidate);
    }
    if (legacyEndpointInferenceEnabled(context)) {
      this.parseRegisteredRoutes(sourceFile, context, moduleNodeId, language);
    }
  }

  private parseTypeUnits(sourceFile: SourceFile, context: ParseContext, moduleNodeId: string, language: NodeLanguage): void {
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    const addTypeUnit = (node: ClassDeclaration | import("ts-morph").InterfaceDeclaration | import("ts-morph").TypeAliasDeclaration | import("ts-morph").EnumDeclaration, unitType: string): void => {
      const name = node.getName();
      if (!name) return;
      const id = unitId(context.projectName, projectFilePath, name);
      context.graph.addUnit({
        id,
        name,
        qualifiedName: id,
        language,
        projectFilePath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        startLine: lineOf(sourceFile, node.getStart()),
        endLine: lineOf(sourceFile, node.getEnd()),
        nodeKind: "module",
        subKind: unitType,
        unitType,
        modifiers: [],
        packageId: moduleNodeId
      });
      context.graph.addRelationship({
        fromNodeId: moduleNodeId,
        toNodeId: id,
        relationshipType: "MODULE_TO_UNIT",
        language,
        confidence: "exact"
      });
    };

    for (const declaration of sourceFile.getClasses()) {
      const name = declaration.getName();
      addTypeUnit(declaration, "class");
      const fromId = name ? unitId(context.projectName, projectFilePath, name) : undefined;
      if (!fromId) continue;
      const extendNode = declaration.getExtends();
      const extendTarget = extendNode ? resolveTypeReferenceUnitId(context, extendNode) ?? resolveImportedUnitId(context, sourceFile, cleanTypeName(extendNode.getText())) ?? extendNode.getText() : undefined;
      if (extendTarget) {
        context.graph.addRelationship({
          fromNodeId: fromId,
          toNodeId: extendTarget,
          relationshipType: "EXTENDS",
          language,
          lineNumber: lineOf(sourceFile, declaration.getStart()),
          confidence: extendTarget === extendNode?.getText() ? "unresolved" : "exact"
        });
      }
      for (const impl of declaration.getImplements()) {
        const target = resolveTypeReferenceUnitId(context, impl) ?? resolveImportedUnitId(context, sourceFile, cleanTypeName(impl.getText())) ?? impl.getText();
        context.graph.addRelationship({
          fromNodeId: fromId,
          toNodeId: target,
          relationshipType: "IMPLEMENTS",
          language,
          lineNumber: lineOf(sourceFile, impl.getStart()),
          confidence: target === impl.getText() ? "unresolved" : "exact"
        });
      }
      for (const method of declaration.getMethods()) {
        const fromFunctionId = functionId(context.projectName, projectFilePath, buildSignature(`${name}.${method.getName()}`, method.getParameters().map((param) => param.getText())));
        for (const target of resolveOverrideTargets(context, sourceFile, declaration, method.getName())) {
          if (target === fromFunctionId) continue;
          context.graph.addRelationship({
            fromNodeId: fromFunctionId,
            toNodeId: target,
            relationshipType: "OVERRIDES",
            language,
            lineNumber: lineOf(sourceFile, method.getStart()),
            confidence: "inferred"
          });
        }
      }
      if (legacyEndpointInferenceEnabled(context)) {
        this.addDecoratorEntrypoints(sourceFile, context, language, declaration);
      }
    }

    for (const declaration of sourceFile.getInterfaces()) {
      const name = declaration.getName();
      addTypeUnit(declaration, "interface");
      const fromId = name ? unitId(context.projectName, projectFilePath, name) : undefined;
      if (!fromId) continue;
      for (const ext of declaration.getExtends()) {
        const target = resolveTypeReferenceUnitId(context, ext) ?? resolveImportedUnitId(context, sourceFile, cleanTypeName(ext.getText())) ?? ext.getText();
        context.graph.addRelationship({
          fromNodeId: fromId,
          toNodeId: target,
          relationshipType: "EXTENDS",
          language,
          lineNumber: lineOf(sourceFile, ext.getStart()),
          confidence: target === ext.getText() ? "unresolved" : "exact"
        });
      }
    }

    for (const declaration of sourceFile.getTypeAliases()) {
      addTypeUnit(declaration, "type_alias");
    }
    for (const declaration of sourceFile.getEnums()) {
      addTypeUnit(declaration, "enum");
    }
  }

  private parseExports(sourceFile: SourceFile, context: ParseContext, moduleNodeId: string, language: NodeLanguage): void {
    for (const declaration of sourceFile.getExportDeclarations()) {
      const targetSource = declaration.getModuleSpecifierSourceFile();
      if (!targetSource || !isProjectSourceFile(targetSource.getFilePath(), context.projectRoot)) continue;
      context.graph.addRelationship({
        fromNodeId: moduleNodeId,
        toNodeId: moduleId(context.projectName, relativeProjectPath(context.projectRoot, targetSource.getFilePath())),
        relationshipType: "EXPORTS",
        language,
        lineNumber: lineOf(sourceFile, declaration.getStart()),
        confidence: "exact"
      });
    }

    for (const declaration of [
      ...sourceFile.getClasses(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
      ...sourceFile.getEnums()
    ]) {
      if (!declaration.isExported()) continue;
      const name = declaration.getName();
      if (!name) continue;
      context.graph.addRelationship({
        fromNodeId: moduleNodeId,
        toNodeId: unitId(context.projectName, relativeProjectPath(context.projectRoot, sourceFile.getFilePath()), name),
        relationshipType: "EXPORTS",
        language,
        lineNumber: lineOf(sourceFile, declaration.getStart()),
        confidence: "exact"
      });
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
          projectFilePath: externalProjectFilePath(specifier),
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

    if (candidate.ownerUnitName) {
      context.graph.addRelationship({
        fromNodeId: unitId(context.projectName, projectFilePath, candidate.ownerUnitName),
        toNodeId: fn.id,
        relationshipType: "UNIT_TO_FUNCTION",
        language,
        confidence: "exact"
      });
    }

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

    if (legacyEndpointInferenceEnabled(context)) {
      this.addFrameworkEntrypointEndpoint(sourceFile, context, fn, candidate);
    }

    return fn;
  }

  private addFrameworkEntrypointEndpoint(
    sourceFile: SourceFile,
    context: ParseContext,
    fn: CodeFunction,
    candidate: FunctionCandidate
  ): void {
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    const nextRoute = nextAppRouteEndpoint(projectFilePath, candidate.name) ?? nextPagesApiEndpoint(projectFilePath);
    if (!nextRoute) return;

    const line = lineOf(sourceFile, candidate.node.getStart());
    const endpointNodeId = endpointId(context.projectName, projectFilePath, nextRoute.matchIdentity, line);
    context.graph.addEndpoint({
      id: endpointNodeId,
      name: nextRoute.matchIdentity,
      qualifiedName: endpointNodeId,
      language: fn.language,
      projectFilePath,
      gitRepoUrl: context.options.gitRepoUrl,
      gitBranch: context.options.gitBranch,
      startLine: line,
      endLine: line,
      nodeKind: "endpoint",
      subKind: "http_inbound",
      endpointType: "HTTP",
      direction: "inbound",
      isExternal: false,
      parseLevel: "full",
      matchIdentity: nextRoute.matchIdentity,
      httpMethod: nextRoute.method,
      path: nextRoute.path,
      normalizedPath: nextRoute.path,
      attributes: {
        source: "next-app-route"
      }
    });
    context.graph.addRelationship({
      fromNodeId: endpointNodeId,
      toNodeId: fn.id,
      relationshipType: "ENDPOINT_TO_FUNCTION",
      language: fn.language,
      lineNumber: line,
      confidence: "exact",
      attributes: { source: "next-app-route" }
    });
  }

  private addDecoratorEntrypoints(
    sourceFile: SourceFile,
    context: ParseContext,
    language: NodeLanguage,
    declaration: ClassDeclaration
  ): void {
    const className = declaration.getName();
    if (!className) return;
    const controllerPath = decoratorPath(declaration, ["Controller"]) ?? "";
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    for (const method of declaration.getMethods()) {
      const route = decoratorHttpRoute(method, controllerPath);
      if (!route) continue;
      const line = lineOf(sourceFile, method.getStart());
      const endpointNodeId = endpointId(context.projectName, projectFilePath, route.matchIdentity, line);
      context.graph.addEndpoint({
        id: endpointNodeId,
        name: route.matchIdentity,
        qualifiedName: endpointNodeId,
        language,
        projectFilePath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        startLine: line,
        endLine: line,
        nodeKind: "endpoint",
        subKind: "http_inbound",
        endpointType: "HTTP",
        direction: "inbound",
        isExternal: false,
        parseLevel: "full",
        matchIdentity: route.matchIdentity,
        httpMethod: route.method,
        path: route.path,
        normalizedPath: route.path,
        attributes: {
          source: "decorator-route"
        }
      });
      context.graph.addRelationship({
        fromNodeId: endpointNodeId,
        toNodeId: functionId(
          context.projectName,
          projectFilePath,
          buildSignature(`${className}.${method.getName()}`, method.getParameters().map((param) => param.getText()))
        ),
        relationshipType: "ENDPOINT_TO_FUNCTION",
        language,
        lineNumber: line,
        confidence: "inferred",
        attributes: { source: "decorator-route" }
      });
    }
  }

  private parseFunctionBody(sourceFile: SourceFile, context: ParseContext, currentFn: CodeFunction, candidate: FunctionCandidate): void {
    const body = candidate.bodyNode;
    if (!body) return;

    for (const jsx of localDescendants(body).filter((node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node))) {
      const propReference = resolveUiHandlerPropReference(sourceFile, context, jsx, candidate);
      if (legacyEndpointInferenceEnabled(context)) {
        const interaction = extractReactUiInteraction({
          projectName: context.projectName,
          projectRoot: context.projectRoot,
          sourceFile,
          language: currentFn.language,
          node: jsx,
          componentName: candidate.isComponent ? candidate.name : undefined,
          gitRepoUrl: context.options.gitRepoUrl,
          gitBranch: context.options.gitBranch,
          resolveHandlerTarget: (node) => resolveUiHandlerTarget(context, sourceFile, node, currentFn)
        });
        if (interaction) {
          const endpointNodeId = addUiInteractionEndpoint(context.graph, interaction);
          if (propReference) {
            addPendingPropEndpoint(context, propReference.componentId, propReference.propName, {
              endpointNodeId,
              language: currentFn.language,
              line: interaction.line,
              eventType: interaction.eventType
            });
          }
        }
      }
      const tagName = getJsxTagName(jsx);
      if (!tagName || !isPascalCase(tagName)) continue;
      const targetId = resolveComponentUnitId(context, sourceFile, jsx, tagName);
      bindRenderedComponentProps(context, sourceFile, jsx, targetId, currentFn);
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

    const calls = localDescendants(body).filter(Node.isCallExpression);
    for (const call of calls) {
      this.parseCallExpression(sourceFile, context, currentFn, call);
    }
  }

  private parseCallExpression(sourceFile: SourceFile, context: ParseContext, currentFn: CodeFunction, call: CallExpression): void {
    const calleeName = getCallName(call);
    if (!calleeName) return;

    if (legacyEndpointInferenceEnabled(context)) {
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
    }

    if (isHookName(calleeName)) {
      const target = resolveCallTargetId(context, call) ?? resolveImportedFunctionId(context, sourceFile, calleeName) ?? calleeName;
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

  private parseRegisteredRoutes(sourceFile: SourceFile, context: ParseContext, moduleNodeId: string, language: NodeLanguage): void {
    const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const route = registeredRouteEndpoint(call, context.routePrefixes);
      if (!route) continue;
      const handler = this.resolveRouteHandlerTarget(context, sourceFile, moduleNodeId, language, call, route);
      if (!handler) continue;

      const line = lineOf(sourceFile, call.getStart());
      const endpointNodeId = endpointId(context.projectName, projectFilePath, route.matchIdentity, line);
      context.graph.addEndpoint({
        id: endpointNodeId,
        name: route.matchIdentity,
        qualifiedName: endpointNodeId,
        language,
        projectFilePath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        startLine: line,
        endLine: line,
        nodeKind: "endpoint",
        subKind: "http_inbound",
        endpointType: "HTTP",
        direction: "inbound",
        isExternal: false,
        parseLevel: "full",
        matchIdentity: route.matchIdentity,
        httpMethod: route.method,
        path: route.path,
        normalizedPath: route.path,
        attributes: {
          source: "router-registration"
        }
      });
      context.graph.addRelationship({
        fromNodeId: endpointNodeId,
        toNodeId: handler,
        relationshipType: "ENDPOINT_TO_FUNCTION",
        language,
        lineNumber: line,
        confidence: "inferred",
        attributes: { source: "router-registration" }
      });
    }
  }

  private resolveRouteHandlerTarget(
    context: ParseContext,
    sourceFile: SourceFile,
    moduleNodeId: string,
    language: NodeLanguage,
    call: CallExpression,
    route: RegisteredRoute
  ): string | undefined {
    const handler = call.getArguments()[route.handlerArgIndex];
    if (!handler) return undefined;
    if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
      const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
      const signature = buildSignature(`route.${route.method}.${route.path}`, handler.getParameters().map((param) => param.getText()));
      const fn: CodeFunction = {
        id: functionId(context.projectName, projectFilePath, signature),
        name: `route.${route.method} ${route.path}`,
        qualifiedName: functionId(context.projectName, projectFilePath, signature),
        language,
        projectFilePath,
        gitRepoUrl: context.options.gitRepoUrl,
        gitBranch: context.options.gitBranch,
        startLine: lineOf(sourceFile, handler.getStart()),
        endLine: lineOf(sourceFile, handler.getEnd()),
        nodeKind: "function",
        subKind: "route_inline_handler",
        signature,
        returnType: "unknown",
        modifiers: [],
        isAsync: handler.isAsync(),
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
      this.parseFunctionBody(sourceFile, context, fn, {
        name: fn.name,
        signature,
        node: handler,
        bodyNode: handler.getBody(),
        isAsync: handler.isAsync(),
        isComponent: false,
        subKind: "route_inline_handler"
      });
      return fn.id;
    }
    return resolveRouteHandlerTarget(context, sourceFile, call, route.handlerArgIndex);
  }
}

function isSupportedSourceFile(filePath: string): boolean {
  return /\.(jsx?|tsx?|mjs|cjs)$/i.test(filePath);
}

function legacyEndpointInferenceEnabled(context: ParseContext): boolean {
  return context.options.legacyEndpointInference !== false;
}

function languageOf(filePath: string): NodeLanguage {
  return /\.(ts|tsx)$/i.test(filePath) ? "typescript" : "javascript";
}

function externalProjectFilePath(specifier: string): string {
  return `external:${specifier}`;
}

function cleanTypeName(text: string): string {
  return text.split("<")[0]?.trim() ?? text;
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

function getJsxAttributes(node: TsNode): TsNode[] {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    return node.getAttributes();
  }
  return [];
}

function resolveUiHandlerTarget(context: ParseContext, sourceFile: SourceFile, node: TsNode, currentFn: CodeFunction): string | undefined {
  const eventAttribute = getJsxAttributes(node)
    .find((item) => Node.isJsxAttribute(item) && item.getNameNode().getText().startsWith("on"));
  if (!eventAttribute || !Node.isJsxAttribute(eventAttribute)) return currentFn.id;
  const initializer = eventAttribute.getInitializer();
  if (!initializer) return currentFn.id;
    if (Node.isJsxExpression(initializer)) {
      const expression = initializer.getExpression();
      if (!expression) return currentFn.id;
      if (readPropReferenceName(expression)) return undefined;
      if (Node.isIdentifier(expression)) {
      return resolveFunctionDeclarationId(context, expression) ?? resolveFunctionId(context, sourceFile, expression.getText()) ?? currentFn.id;
    }
    if (Node.isPropertyAccessExpression(expression)) {
      const classMethodTarget = resolveThisMethodTarget(context, sourceFile, expression, currentFn);
      if (classMethodTarget) return classMethodTarget;
      return resolveFunctionDeclarationId(context, expression.getNameNode()) ?? resolveFunctionId(context, sourceFile, expression.getName()) ?? currentFn.id;
    }
    if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
      const call = expression.getDescendantsOfKind(SyntaxKind.CallExpression)[0];
      const callee = call ? getCallName(call) : undefined;
      if (callee) return resolveFunctionId(context, sourceFile, callee) ?? currentFn.id;
      return currentFn.id;
    }
    if (Node.isCallExpression(expression)) {
      const callee = getCallName(expression);
      if (callee) return resolveCallTargetId(context, expression) ?? resolveFunctionId(context, sourceFile, callee) ?? currentFn.id;
    }
  }
  return currentFn.id;
}

function resolveThisMethodTarget(
  context: ParseContext,
  sourceFile: SourceFile,
  expression: import("ts-morph").PropertyAccessExpression,
  currentFn: CodeFunction
): string | undefined {
  if (expression.getExpression().getText() !== "this") return undefined;
  const className = currentFn.signature.match(/^(.+)\.render\(/)?.[1]
    ?? currentFn.signature.match(/^(.+)\.[^.]+\(.*\)$/)?.[1];
  if (!className) return undefined;
  const sourceClass = sourceFile.getClass(className);
  const method = sourceClass?.getMethods().find((item) => item.getName() === expression.getName());
  if (!method) return undefined;
  return functionId(
    context.projectName,
    relativeProjectPath(context.projectRoot, sourceFile.getFilePath()),
    buildSignature(`${className}.${method.getName()}`, method.getParameters().map((param) => param.getText()))
  );
}

function resolveUiHandlerPropReference(
  sourceFile: SourceFile,
  context: ParseContext,
  node: TsNode,
  candidate: FunctionCandidate
): { componentId: string; propName: string } | undefined {
  if (!candidate.isComponent) return undefined;
  const eventAttribute = getJsxAttributes(node)
    .find((item) => Node.isJsxAttribute(item) && item.getNameNode().getText().startsWith("on"));
  if (!eventAttribute || !Node.isJsxAttribute(eventAttribute)) return undefined;
  const initializer = eventAttribute.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return undefined;
  const expression = initializer.getExpression();
  if (!expression) return undefined;
  const propName = readPropReferenceName(expression);
  if (!propName) return undefined;
  const projectFilePath = relativeProjectPath(context.projectRoot, sourceFile.getFilePath());
  return {
    componentId: unitId(context.projectName, projectFilePath, candidate.name),
    propName
  };
}

function bindRenderedComponentProps(
  context: ParseContext,
  sourceFile: SourceFile,
  jsx: TsNode,
  componentId: string,
  currentFn: CodeFunction
): void {
  for (const attribute of getJsxAttributes(jsx)) {
    if (!Node.isJsxAttribute(attribute)) continue;
    const propName = attribute.getNameNode().getText();
    if (!propName || propName === "children") continue;
    const handlerId = resolveJsxAttributeFunctionTarget(context, sourceFile, attribute, currentFn);
    if (!handlerId) continue;
    addComponentPropHandler(context, componentId, propName, handlerId);
  }
}

function resolveJsxAttributeFunctionTarget(
  context: ParseContext,
  sourceFile: SourceFile,
  attribute: import("ts-morph").JsxAttribute,
  currentFn: CodeFunction
): string | undefined {
  const initializer = attribute.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return undefined;
  const expression = initializer.getExpression();
  if (!expression) return undefined;
  if (Node.isIdentifier(expression)) {
    return resolveFunctionDeclarationId(context, expression) ?? resolveFunctionId(context, sourceFile, expression.getText());
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return resolveFunctionDeclarationId(context, expression.getNameNode()) ?? resolveCallTarget(context, sourceFile, expression.getText());
  }
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    const signature = `${currentFn.id}::${attribute.getNameNode().getText()}@${attribute.getStart()}`;
    return signature;
  }
  if (Node.isCallExpression(expression)) {
    return resolveCallTargetId(context, expression);
  }
  return undefined;
}

function addComponentPropHandler(context: ParseContext, componentId: string, propName: string, handlerId: string): void {
  const key = componentPropKey(componentId, propName);
  const handlers = context.componentPropHandlers.get(key) ?? new Set<string>();
  handlers.add(handlerId);
  context.componentPropHandlers.set(key, handlers);
  for (const pending of context.pendingPropEndpoints.get(key) ?? []) {
    addEndpointToPropHandler(context, pending, handlerId);
  }
}

function addPendingPropEndpoint(
  context: ParseContext,
  componentId: string,
  propName: string,
  endpoint: PropEndpointReference
): void {
  const key = componentPropKey(componentId, propName);
  const handlers = context.componentPropHandlers.get(key);
  if (handlers && handlers.size > 0) {
    for (const handlerId of handlers) addEndpointToPropHandler(context, endpoint, handlerId);
    return;
  }
  const pending = context.pendingPropEndpoints.get(key) ?? [];
  pending.push(endpoint);
  context.pendingPropEndpoints.set(key, pending);
}

function addEndpointToPropHandler(context: ParseContext, endpoint: PropEndpointReference, handlerId: string): void {
  context.graph.addRelationship({
    fromNodeId: endpoint.endpointNodeId,
    toNodeId: handlerId,
    relationshipType: "ENDPOINT_TO_FUNCTION",
    language: endpoint.language,
    lineNumber: endpoint.line,
    confidence: "inferred",
    attributes: { event: endpoint.eventType, source: "react-prop-binding" }
  });
}

function componentPropKey(componentId: string, propName: string): string {
  return `${componentId}#${propName}`;
}

function readPropReferenceName(expression: TsNode): string | undefined {
  if (Node.isPropertyAccessExpression(expression)) {
    const ownerText = expression.getExpression().getText();
    if (ownerText === "props" || ownerText === "this.props") return expression.getName();
  }
  if (Node.isIdentifier(expression)) {
    for (const declaration of expression.getSymbol()?.getDeclarations() ?? []) {
      if (!Node.isBindingElement(declaration)) continue;
      const parentText = declaration.getFirstAncestorByKind(SyntaxKind.Parameter)?.getText()
        ?? declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getInitializer()?.getText();
      if (parentText?.includes("props")) return declaration.getName();
      if (declaration.getFirstAncestorByKind(SyntaxKind.Parameter)) return declaration.getName();
    }
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

function resolveOverrideTargets(context: ParseContext, sourceFile: SourceFile, declaration: ClassDeclaration, methodName: string): string[] {
  const output: string[] = [];
  const targetNames = [
    declaration.getExtends()?.getText(),
    ...declaration.getImplements().map((item) => item.getText())
  ].filter((value): value is string => Boolean(value));

  for (const rawTargetName of targetNames) {
    const targetName = cleanTypeName(rawTargetName);
    const imported = context.importIndex.get(sourceFile.getFilePath(), targetName);
    const targetSource = imported?.sourceFilePath
      ? sourceFile.getProject().getSourceFile(imported.sourceFilePath)
      : sourceFile;
    if (!targetSource) continue;
    const targetProjectFilePath = imported?.projectFilePath ?? relativeProjectPath(context.projectRoot, targetSource.getFilePath());
    const targetDeclaration =
      targetSource.getClass(targetName) ??
      targetSource.getInterface(targetName);
    if (!targetDeclaration) continue;
    const targetMethod = targetDeclaration.getMethods().find((method) => method.getName() === methodName);
    if (!targetMethod) continue;
    output.push(functionId(
      context.projectName,
      targetProjectFilePath,
      buildSignature(`${targetName}.${methodName}`, targetMethod.getParameters().map((param) => param.getText()))
    ));
  }

  return output;
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

function resolveComponentUnitId(context: ParseContext, sourceFile: SourceFile, jsx: TsNode, tagName: string): string {
  const resolved = resolveJsxTagUnitId(context, jsx);
  if (resolved) return resolved;
  return resolveImportedUnitId(context, sourceFile, tagName)
    ?? unitId(context.projectName, relativeProjectPath(context.projectRoot, sourceFile.getFilePath()), tagName)
    ?? tagName;
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

function nextAppRouteEndpoint(projectFilePath: string, functionName: string): { method: string; path: string; matchIdentity: string } | undefined {
  const method = functionName.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) return undefined;
  const parts = projectFilePath.split("/");
  const fileName = parts.at(-1);
  if (!fileName || !/^route\.[cm]?[tj]sx?$/i.test(fileName)) return undefined;
  const appIndex = parts.lastIndexOf("app");
  if (appIndex < 0) return undefined;
  const routeParts = parts.slice(appIndex + 1, -1)
    .filter((part) => !part.startsWith("(") && !part.startsWith("@"))
    .map((part) => {
      if (/^\[\.\.\..+\]$/.test(part)) return "{param}";
      if (/^\[\[.+\]\]$/.test(part)) return "{param}";
      if (/^\[.+\]$/.test(part)) return "{param}";
      return part;
    });
  const routePath = `/${routeParts.join("/")}`.replace(/\/+/g, "/");
  const path = routePath === "/" ? "/" : routePath.replace(/\/$/, "");
  return {
    method,
    path,
    matchIdentity: `HTTP:${method}:${path}`
  };
}

function nextPagesApiEndpoint(projectFilePath: string): { method: string; path: string; matchIdentity: string } | undefined {
  const parts = projectFilePath.split("/");
  const pagesIndex = parts.lastIndexOf("pages");
  if (pagesIndex < 0 || parts[pagesIndex + 1] !== "api") return undefined;
  const fileName = parts.at(-1);
  if (!fileName || !/\.[cm]?[tj]sx?$/i.test(fileName)) return undefined;
  const lastSegment = fileName.replace(/\.[^.]+$/, "");
  const routeParts = [...parts.slice(pagesIndex + 1, -1), lastSegment]
    .filter((part) => part !== "index")
    .map((part) => {
      if (/^\[\.\.\..+\]$/.test(part)) return "{param}";
      if (/^\[\[.+\]\]$/.test(part)) return "{param}";
      if (/^\[.+\]$/.test(part)) return "{param}";
      return part;
    });
  const routePath = `/${routeParts.join("/")}`.replace(/\/+/g, "/");
  const path = routePath === "/" ? "/" : routePath.replace(/\/$/, "");
  return {
    method: "ANY",
    path,
    matchIdentity: `HTTP:ANY:${path}`
  };
}

function collectRoutePrefixes(sourceFile: SourceFile, context: ParseContext): void {
  const tracer = new ValueTracer();
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = declaration.getName();
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const callee = getCallName(initializer);
    if (!callee || !/(^|\.)(Router|route|group)$/i.test(callee)) continue;
    const firstArg = initializer.getArguments()[0];
    const objectPrefix = Node.isObjectLiteralExpression(firstArg)
      ? firstArg.getProperty("prefix")
      : undefined;
    const prefixExpression = objectPrefix && Node.isPropertyAssignment(objectPrefix)
      ? objectPrefix.getInitializer()
      : firstArg;
    if (!prefixExpression || !Node.isExpression(prefixExpression)) continue;
    const prefix = tracer.traceExpression(prefixExpression).value;
    if (prefix?.startsWith("/")) {
      context.routePrefixes.set(name, normalizeRoutePath(prefix));
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== "use") continue;
    const args = call.getArguments();
    const prefixArg = args[0];
    const routerArg = args[1];
    if (!prefixArg || !routerArg || !Node.isExpression(prefixArg) || !Node.isIdentifier(routerArg)) continue;
    const prefix = new ValueTracer().traceExpression(prefixArg).value;
    if (!prefix?.startsWith("/")) continue;
    const existing = context.routePrefixes.get(routerArg.getText()) ?? "";
    context.routePrefixes.set(routerArg.getText(), normalizeRoutePath(`${prefix}/${existing}`));
  }
}

interface RegisteredRoute {
  method: string;
  path: string;
  matchIdentity: string;
  handlerArgIndex: number;
}

function registeredRouteEndpoint(call: CallExpression, routePrefixes: Map<string, string>): RegisteredRoute | undefined {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return undefined;
  const method = expression.getName().toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) return undefined;
  const args = call.getArguments();
  const receiverExpression = expression.getExpression();
  const routeCall = Node.isCallExpression(receiverExpression) ? receiverExpression : undefined;
  const routeCallName = routeCall ? getCallName(routeCall) : undefined;
  const routeCallPath = routeCallName?.endsWith(".route") || routeCallName === "route"
    ? literalText(routeCall?.getArguments()[0])
    : undefined;
  const pathArgIndex = routeCallPath ? -1 : args.findIndex((arg) => literalText(arg)?.startsWith("/") === true);
  const rawPath = routeCallPath ?? literalText(args[pathArgIndex]);
  if (!rawPath || !rawPath.startsWith("/")) return undefined;
  const handlerArgIndex = findRouteHandlerArgIndex(args, pathArgIndex);
  if (handlerArgIndex < 0) return undefined;
  const receiver = expression.getExpression().getText();
  const prefix = routePrefixes.get(receiver) ?? "";
  const path = normalizeRoutePath(`${prefix}/${rawPath}`);
  return {
    method,
    path,
    matchIdentity: `HTTP:${method}:${path}`,
    handlerArgIndex
  };
}

function findRouteHandlerArgIndex(args: TsNode[], pathArgIndex: number): number {
  for (let index = args.length - 1; index > pathArgIndex; index -= 1) {
    const arg = args[index];
    if (Node.isIdentifier(arg) ||
      Node.isPropertyAccessExpression(arg) ||
      Node.isCallExpression(arg) ||
      Node.isArrowFunction(arg) ||
      Node.isFunctionExpression(arg)) {
      return index;
    }
  }
  return -1;
}

function resolveRouteHandlerTarget(context: ParseContext, sourceFile: SourceFile, call: CallExpression, handlerArgIndex: number): string | undefined {
  const handler = call.getArguments()[handlerArgIndex];
  if (!handler) return undefined;
  if (Node.isIdentifier(handler)) {
    return resolveFunctionDeclarationId(context, handler) ?? resolveFunctionId(context, sourceFile, handler.getText());
  }
  if (Node.isPropertyAccessExpression(handler)) {
    return resolveFunctionDeclarationId(context, handler.getNameNode()) ?? resolveFunctionId(context, sourceFile, handler.getText());
  }
  if (Node.isCallExpression(handler)) {
    return resolveCallTargetId(context, handler);
  }
  return undefined;
}

function literalText(node: TsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isExpression(node)) return new ValueTracer().traceExpression(node).value;
  return undefined;
}

function decoratorHttpRoute(method: import("ts-morph").MethodDeclaration, controllerPath: string): { method: string; path: string; matchIdentity: string } | undefined {
  const decorators = method.getDecorators();
  for (const decorator of decorators) {
    const name = decorator.getName();
    const httpMethod = decoratorNameToHttpMethod(name);
    if (!httpMethod) continue;
    const methodPath = decoratorPath(method, [name]) ?? "";
    const path = normalizeRoutePath(`${controllerPath}/${methodPath}`);
    return {
      method: httpMethod,
      path,
      matchIdentity: `HTTP:${httpMethod}:${path}`
    };
  }
  return undefined;
}

function decoratorNameToHttpMethod(name: string): string | undefined {
  const upper = name.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(upper) ? upper : undefined;
}

function decoratorPath(node: ClassDeclaration | import("ts-morph").MethodDeclaration, names: string[]): string | undefined {
  const decorator = node.getDecorators().find((item) => names.includes(item.getName()));
  if (!decorator) return undefined;
  const argument = decorator.getArguments()[0];
  return literalText(argument);
}

function normalizeRoutePath(value: string): string {
  const path = `/${value}`
    .replace(/\/+/g, "/")
    .replace(/\/:[^/]+/g, "/{param}")
    .replace(/\*[^/]*/g, "{param}")
    .replace(/\/$/, "");
  return path || "/";
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
