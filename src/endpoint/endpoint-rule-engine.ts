import { Node, type CallExpression } from "ts-morph";
import type { ExtractConfig, ExtractedEndpoint, EndpointRule } from "./endpoint-rule.js";
import { ValueTracer } from "./value-tracer.js";
import { normalizeHttpPath } from "../util/string-utils.js";

export class EndpointRuleEngine {
  private readonly tracer = new ValueTracer();

  constructor(private readonly rules: EndpointRule[]) {}

  extract(call: CallExpression): ExtractedEndpoint[] {
    return this.rules.flatMap((rule) => {
      if (!this.matches(rule, call)) return [];
      const method = this.extractField(rule.extract.method, call) ?? "GET";
      const tracedPath = this.extractTracedField(rule.extract.path, call);
      if (!tracedPath.value) return [];

      const normalizedPath = normalizeHttpPath(tracedPath.value);
      const formattedMethod = method.toUpperCase();
      const matchIdentity = (rule.normalize?.matchIdentity ?? "HTTP:{method}:{normalizedPath}")
        .replace("{method}", formattedMethod)
        .replace("{normalizedPath}", normalizedPath);

      return [
        {
          ruleId: rule.id,
          method: formattedMethod,
          path: tracedPath.value,
          normalizedPath,
          matchIdentity,
          rawPath: tracedPath.raw,
          confidence: tracedPath.confidence
        }
      ];
    });
  }

  private matches(rule: EndpointRule, call: CallExpression): boolean {
    if (rule.locate.nodeType !== "CallExpression") return false;
    const callee = getCalleeName(call);
    const matcher = rule.locate.callee;
    if (typeof matcher === "string") return callee === matcher;
    if (matcher.anyOf?.includes(callee)) return true;
    if (matcher.regex) return new RegExp(matcher.regex).test(callee);
    return false;
  }

  private extractField(config: ExtractConfig | undefined, call: CallExpression): string | undefined {
    if (!config) return undefined;
    if (config.const) return applyTransforms(config.const, config.transforms);
    const selector = typeof config.from === "string" ? config.from : undefined;
    if (selector === "callee.property") {
      const property = this.tracer.extractSelector(call, selector);
      const value = property?.getText();
      return value ? applyTransforms(value, config.transforms) : config.default;
    }
    const traced = this.extractTracedField(config, call);
    const value = traced.value ?? config.default;
    return value ? applyTransforms(value, config.transforms) : undefined;
  }

  private extractTracedField(config: ExtractConfig | undefined, call: CallExpression): { value?: string; raw: string; confidence: ExtractedEndpoint["confidence"] } {
    if (!config) return { raw: "", confidence: "unresolved" };
    if (config.const) return { value: config.const, raw: config.const, confidence: "exact" };

    const selectors = typeof config.from === "object" && config.from && "anyOf" in config.from ? config.from.anyOf : config.from ? [config.from] : [];
    for (const selector of selectors) {
      const expression = this.tracer.extractSelector(call, selector);
      const traced = config.trace === false
        ? { value: expression?.getText(), raw: expression?.getText() ?? "", confidence: "heuristic" as const }
        : this.tracer.traceExpression(expression);
      if (traced.value) {
        return {
          value: applyTransforms(traced.value, config.transforms),
          raw: traced.raw,
          confidence: traced.confidence
        };
      }
    }
    if (config.default) return { value: config.default, raw: config.default, confidence: "heuristic" };
    return { raw: "", confidence: "unresolved" };
  }
}

function getCalleeName(call: CallExpression): string {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getText();
  return expression.getText();
}

function applyTransforms(value: string, transforms: string[] | undefined): string {
  let result = value;
  for (const transform of transforms ?? []) {
    if (transform === "upperCase") result = result.toUpperCase();
    if (transform === "lowerCase") result = result.toLowerCase();
    if (transform === "httpMethod" && result === "DEL") result = "DELETE";
  }
  return result;
}
