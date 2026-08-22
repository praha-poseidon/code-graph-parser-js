import crypto from "node:crypto";
import type {
  CodeEndpoint,
  CodeFunction,
  CodeGraph,
  CodePackage,
  CodeRelationship,
  CodeUnit,
  Confidence,
  NodeLanguage,
  RelationshipType
} from "../model/code-graph.js";
import { createEmptyGraph } from "../model/code-graph.js";

export class GraphBuilder {
  readonly graph: CodeGraph = createEmptyGraph();

  private readonly packageIds = new Set<string>();
  private readonly unitIds = new Set<string>();
  private readonly functionIds = new Set<string>();
  private readonly endpointIds = new Set<string>();
  private readonly relationshipIds = new Set<string>();

  addPackage(pkg: CodePackage): void {
    if (this.packageIds.has(pkg.id)) return;
    this.packageIds.add(pkg.id);
    this.graph.packages.push(pkg);
  }

  addUnit(unit: CodeUnit): void {
    if (this.unitIds.has(unit.id)) return;
    this.unitIds.add(unit.id);
    this.graph.units.push(unit);
  }

  addFunction(fn: CodeFunction): void {
    if (this.functionIds.has(fn.id)) {
      // RENDERS may create a placeholder before the target file is parsed.
      // Upgrade placeholder entries when the real definition arrives.
      if (!fn.isPlaceholder) {
        const index = this.graph.functions.findIndex((existing) => existing.id === fn.id);
        if (index >= 0 && this.graph.functions[index].isPlaceholder) {
          this.graph.functions[index] = fn;
        }
      }
      return;
    }
    this.functionIds.add(fn.id);
    this.graph.functions.push(fn);
  }

  hasFunction(id: string): boolean {
    return this.functionIds.has(id);
  }

  addEndpoint(endpoint: CodeEndpoint): void {
    if (this.endpointIds.has(endpoint.id)) return;
    this.endpointIds.add(endpoint.id);
    this.graph.endpoints.push(endpoint);
  }

  addRelationship(input: {
    fromNodeId: string;
    toNodeId: string;
    relationshipType: RelationshipType;
    language: NodeLanguage;
    lineNumber?: number;
    callType?: string;
    confidence?: Confidence;
    attributes?: Record<string, unknown>;
  }): void {
    const relationshipType = languageRelationshipType(input.relationshipType, input.language);
    const contract = relationshipContract(relationshipType);
    const relationship = { ...input, relationshipType, ...contract };
    const id = relationshipId(relationship);
    if (this.relationshipIds.has(id)) return;
    this.relationshipIds.add(id);
    this.graph.relationships.push({ id, ...relationship });
  }
}

function languageRelationshipType(type: RelationshipType, language: NodeLanguage): RelationshipType {
  if (type !== "EXTENDS" && type !== "IMPLEMENTS" && type !== "OVERRIDES") return type;
  const prefix = language === "typescript" ? "TS" : "JS";
  return `${prefix}_${type}` as RelationshipType;
}

function relationshipContract(type: RelationshipType): Pick<CodeRelationship, "relationshipKind" | "fromNodeType" | "toNodeType"> {
  switch (type) {
    case "CALLS": return { relationshipKind: "CALL", fromNodeType: "CodeFunction", toNodeType: "CodeFunction" };
    case "RENDERS": return { relationshipKind: "RENDERS", fromNodeType: "CodeFunction", toNodeType: "CodeFunction" };
    case "PACKAGE_TO_UNIT": return { relationshipKind: "CONTAINS", fromNodeType: "CodePackage", toNodeType: "CodeUnit" };
    case "PACKAGE_TO_PACKAGE": return { relationshipKind: "CONTAINS", fromNodeType: "CodePackage", toNodeType: "CodePackage" };
    case "UNIT_TO_FUNCTION": return { relationshipKind: "CONTAINS", fromNodeType: "CodeUnit", toNodeType: "CodeFunction" };
    case "JS_EXTENDS":
    case "TS_EXTENDS": return { relationshipKind: "SPECIALIZES", fromNodeType: "CodeUnit", toNodeType: "CodeUnit" };
    case "JS_IMPLEMENTS":
    case "TS_IMPLEMENTS": return { relationshipKind: "CONFORMS", fromNodeType: "CodeUnit", toNodeType: "CodeUnit" };
    case "JS_OVERRIDES":
    case "TS_OVERRIDES": return { relationshipKind: "REFINES", fromNodeType: "CodeFunction", toNodeType: "CodeFunction" };
    case "ENDPOINT_TO_FUNCTION": return { relationshipKind: "BINDS_ENDPOINT", fromNodeType: "CodeEndpoint", toNodeType: "CodeFunction" };
    case "FUNCTION_TO_ENDPOINT": return { relationshipKind: "BINDS_ENDPOINT", fromNodeType: "CodeFunction", toNodeType: "CodeEndpoint" };
    case "MATCHES": return { relationshipKind: "MATCHES_ENDPOINT", fromNodeType: "CodeEndpoint", toNodeType: "CodeEndpoint" };
    default: throw new Error(`Missing relationship contract for ${type}`);
  }
}

function relationshipId(input: Omit<CodeRelationship, "id">): string {
  const raw = [
    input.relationshipType,
    input.fromNodeId,
    input.toNodeId
  ].join("|");
  return crypto.createHash("sha1").update(raw).digest("hex");
}
