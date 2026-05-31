import type { GraphBuilder } from "../graph/graph-builder.js";
import { endpointId } from "../parser/node-id.js";
import type { UiInteractionCandidate } from "./ui-interaction.js";

export function addUiInteractionEndpoint(graph: GraphBuilder, candidate: UiInteractionCandidate): string {
  const matchIdentity = `UI:${candidate.eventType.toUpperCase()}:${candidate.elementType}:${candidate.text}`;
  const endpointNodeId = endpointId(candidate.projectName, candidate.projectFilePath, matchIdentity, candidate.line);

  graph.addEndpoint({
    id: endpointNodeId,
    name: candidate.text,
    qualifiedName: endpointNodeId,
    language: candidate.language,
    projectFilePath: candidate.projectFilePath,
    gitRepoUrl: candidate.gitRepoUrl,
    gitBranch: candidate.gitBranch,
    startLine: candidate.line,
    endLine: candidate.line,
    nodeKind: "endpoint",
    subKind: "ui_action",
    endpointType: "UI",
    direction: "inbound",
    isExternal: false,
    parseLevel: "full",
    matchIdentity,
    path: `${candidate.componentName ?? candidate.projectFilePath}#${candidate.elementType}:${candidate.text}`,
    normalizedPath: `${candidate.elementType}:${candidate.text}`,
    uiEvent: candidate.eventType,
    uiElement: candidate.elementType,
    uiText: candidate.text,
    uiSelector: candidate.selector,
    componentName: candidate.componentName,
    attributes: {
      source: "ui-interaction",
      rawElement: candidate.rawElement
    }
  });

  if (!candidate.handlerFunctionId) return endpointNodeId;
  graph.addRelationship({
    fromNodeId: endpointNodeId,
    toNodeId: candidate.handlerFunctionId,
    relationshipType: "ENDPOINT_TO_FUNCTION",
    language: candidate.language,
    lineNumber: candidate.line,
    confidence: "inferred",
    attributes: { event: candidate.eventType }
  });
  return endpointNodeId;
}
