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
    if (this.functionIds.has(fn.id)) return;
    this.functionIds.add(fn.id);
    this.graph.functions.push(fn);
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
    const id = relationshipId(input);
    if (this.relationshipIds.has(id)) return;
    this.relationshipIds.add(id);
    this.graph.relationships.push({ id, ...input });
  }
}

function relationshipId(input: Omit<CodeRelationship, "id">): string {
  const raw = [
    input.relationshipType,
    input.fromNodeId,
    input.toNodeId,
    input.lineNumber ?? "",
    input.callType ?? "",
    input.confidence ?? ""
  ].join("|");
  return crypto.createHash("sha1").update(raw).digest("hex");
}
