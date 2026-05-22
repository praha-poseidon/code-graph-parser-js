import {
  Node,
  type CallExpression,
  type Expression,
  type Identifier,
  type ObjectLiteralExpression,
  type PropertyAssignment
} from "ts-morph";
import { stripQuotes } from "../util/string-utils.js";

export interface TracedValue {
  value?: string;
  raw: string;
  confidence: "exact" | "inferred" | "heuristic" | "partial" | "unresolved";
}

export class ValueTracer {
  traceExpression(expression: Expression | undefined, depth = 0): TracedValue {
    if (!expression) {
      return { raw: "", confidence: "unresolved" };
    }
    if (depth > 6) {
      return { raw: expression.getText(), confidence: "partial" };
    }

    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
      return { value: expression.getLiteralText(), raw: expression.getText(), confidence: "exact" };
    }

    if (Node.isTemplateExpression(expression)) {
      const head = expression.getHead().getLiteralText();
      let confidence: TracedValue["confidence"] = "exact";
      const parts = expression.getTemplateSpans().map((span) => {
        const tracedExpression = this.traceExpression(span.getExpression(), depth + 1);
        if (!tracedExpression.value) {
          confidence = "inferred";
          return `{param}${span.getLiteral().getLiteralText()}`;
        }
        if (tracedExpression.confidence !== "exact") {
          confidence = tracedExpression.confidence;
        }
        return `${tracedExpression.value}${span.getLiteral().getLiteralText()}`;
      });
      const value = `${head}${parts.join("")}`.replace(/\{param\}\{param\}/g, "{param}");
      return { value: value.includes("{param}") ? value : value, raw: expression.getText(), confidence: confidence === "exact" ? "inferred" : confidence };
    }

    if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getText() === "+") {
      const left = this.traceExpression(expression.getLeft(), depth + 1);
      const right = this.traceExpression(expression.getRight(), depth + 1);
      if (left.value && right.value) {
        return {
          value: `${left.value}${right.value}`,
          raw: expression.getText(),
          confidence: left.confidence === "exact" && right.confidence === "exact" ? "inferred" : "partial"
        };
      }
      return { raw: expression.getText(), confidence: "partial" };
    }

    if (Node.isIdentifier(expression)) {
      return this.traceIdentifier(expression, depth + 1);
    }

    if (Node.isPropertyAccessExpression(expression)) {
      const symbol = expression.getSymbol();
      const declaration = symbol?.getDeclarations()[0];
      if (declaration && Node.isPropertyAssignment(declaration)) {
        return this.tracePropertyAssignment(declaration, depth + 1);
      }
      return { raw: expression.getText(), confidence: "unresolved" };
    }

    return { raw: expression.getText(), confidence: "unresolved" };
  }

  extractSelector(call: CallExpression, selector: string): Expression | undefined {
    if (selector === "callee") return call.getExpression();
    if (selector === "callee.property") {
      const callee = call.getExpression();
      if (Node.isPropertyAccessExpression(callee)) return callee.getNameNode();
      return undefined;
    }

    const argMatch = /^arguments\[(\d+)](?:\.properties\.([A-Za-z_$][\w$-]*))?$/.exec(selector);
    if (!argMatch) return undefined;
    const argument = call.getArguments()[Number(argMatch[1])];
    if (!argument || !Node.isExpression(argument)) return undefined;
    const propertyName = argMatch[2];
    if (!propertyName) return argument;

    const objectLiteral = this.resolveObjectLiteral(argument);
    if (!objectLiteral) return undefined;
    const property = objectLiteral.getProperty(propertyName);
    if (!property || !Node.isPropertyAssignment(property)) return undefined;
    const initializer = property.getInitializer();
    return initializer && Node.isExpression(initializer) ? initializer : undefined;
  }

  private traceIdentifier(identifier: Identifier, depth: number): TracedValue {
    const symbol = identifier.getSymbol();
    const declaration = symbol?.getDeclarations()[0];
    if (!declaration) {
      return { raw: identifier.getText(), confidence: "unresolved" };
    }

    if (Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      return initializer && Node.isExpression(initializer)
        ? this.traceExpression(initializer, depth + 1)
        : { raw: identifier.getText(), confidence: "unresolved" };
    }

    if (Node.isImportSpecifier(declaration) || Node.isImportClause(declaration)) {
      return { raw: identifier.getText(), confidence: "unresolved" };
    }

    if (Node.isPropertyAssignment(declaration)) {
      return this.tracePropertyAssignment(declaration, depth + 1);
    }

    return { raw: identifier.getText(), confidence: "unresolved" };
  }

  private tracePropertyAssignment(property: PropertyAssignment, depth: number): TracedValue {
    const initializer = property.getInitializer();
    return initializer && Node.isExpression(initializer)
      ? this.traceExpression(initializer, depth + 1)
      : { raw: property.getText(), confidence: "unresolved" };
  }

  private resolveObjectLiteral(expression: Expression): ObjectLiteralExpression | undefined {
    if (Node.isObjectLiteralExpression(expression)) {
      return expression;
    }
    if (Node.isIdentifier(expression)) {
      const symbol = expression.getSymbol();
      const declaration = symbol?.getDeclarations()[0];
      if (declaration && Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();
        if (initializer && Node.isObjectLiteralExpression(initializer)) {
          return initializer;
        }
      }
    }
    return undefined;
  }
}

export function literalFromExpression(expression: Expression | undefined): string | undefined {
  if (!expression) return undefined;
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getLiteralText();
  }
  return stripQuotes(expression.getText());
}
