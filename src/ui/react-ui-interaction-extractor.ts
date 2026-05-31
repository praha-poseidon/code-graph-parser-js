import { Node, SyntaxKind, type Node as TsNode, type SourceFile } from "ts-morph";
import type { NodeLanguage } from "../model/code-graph.js";
import { lineOf, relativeProjectPath } from "../util/path-utils.js";
import type { UiInteractionCandidate } from "./ui-interaction.js";

export interface ReactUiInteractionInput {
  projectName: string;
  projectRoot: string;
  sourceFile: SourceFile;
  language: NodeLanguage;
  node: TsNode;
  componentName?: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  resolveHandlerTarget: (node: TsNode) => string | undefined;
}

export function extractReactUiInteraction(input: ReactUiInteractionInput): UiInteractionCandidate | undefined {
  const eventType = getUiEvent(input.node);
  if (!eventType) return undefined;

  const rawElement = getJsxTagName(input.node);
  if (!rawElement) return undefined;

  const elementType = normalizeUiElement(rawElement);
  const text = getJsxVisibleText(input.node)
    ?? getJsxAttributeLiteral(input.node, "aria-label")
    ?? getJsxAttributeLiteral(input.node, "title")
    ?? getJsxAttributeLiteral(input.node, "placeholder")
    ?? getJsxAttributeLiteral(input.node, "name")
    ?? getJsxAttributeLiteral(input.node, "id")
    ?? rawElement;

  return {
    projectName: input.projectName,
    projectFilePath: relativeProjectPath(input.projectRoot, input.sourceFile.getFilePath()),
    language: input.language,
    line: lineOf(input.sourceFile, input.node.getStart()),
    eventType,
    elementType,
    text,
    rawElement,
    selector: `${rawElement}[${eventType}]`,
    componentName: input.componentName,
    handlerFunctionId: input.resolveHandlerTarget(input.node),
    gitRepoUrl: input.gitRepoUrl,
    gitBranch: input.gitBranch
  };
}

function getUiEvent(node: TsNode): string | undefined {
  for (const attribute of getJsxAttributes(node)) {
    if (!Node.isJsxAttribute(attribute)) continue;
    const name = attribute.getNameNode().getText();
    if (name === "onClick") return "click";
    if (name === "onSubmit") return "submit";
    if (name === "onChange") return "change";
    if (name === "onKeyDown") return "keydown";
  }
  return undefined;
}

function normalizeUiElement(tagName: string): string {
  const lower = tagName.toLowerCase();
  if (lower === "a" || lower === "link" || lower === "navlink") return "link";
  if (lower === "form") return "form";
  if (lower === "input") return "input";
  if (lower.includes("button")) return "button";
  if (lower.includes("menu")) return "menu";
  if (lower.includes("tab")) return "tab";
  return lower;
}

function getJsxVisibleText(node: TsNode): string | undefined {
  const parent = node.getParent();
  if (!parent || !Node.isJsxElement(parent)) return undefined;
  const opening = parent.getOpeningElement();
  if (opening !== node) return undefined;
  const text = parent.getJsxChildren()
    .map((child) => {
      if (Node.isJsxText(child)) return child.getText();
      if (Node.isJsxExpression(child)) {
        const expression = child.getExpression();
        if (expression && Node.isStringLiteral(expression)) return expression.getLiteralText();
        if (expression) {
          const literals = expression.getDescendantsOfKind(SyntaxKind.StringLiteral)
            .map((literal) => literal.getLiteralText().trim())
            .filter(Boolean);
          if (literals.length > 0) return literals.join(" / ");
        }
      }
      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function getJsxAttributeLiteral(node: TsNode, name: string): string | undefined {
  const attribute = getJsxAttributes(node)
    .find((item) => Node.isJsxAttribute(item) && item.getNameNode().getText() === name);
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (!initializer) return undefined;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralText();
  if (Node.isJsxExpression(initializer)) {
    const expression = initializer.getExpression();
    if (expression && Node.isStringLiteral(expression)) return expression.getLiteralText();
  }
  return undefined;
}

function getJsxAttributes(node: TsNode): TsNode[] {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    return node.getAttributes();
  }
  return [];
}

function getJsxTagName(node: TsNode): string | undefined {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    return node.getTagNameNode().getText().split(".")[0];
  }
  return undefined;
}
