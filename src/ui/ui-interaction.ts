import type { NodeLanguage } from "../model/code-graph.js";

export interface UiInteractionCandidate {
  projectName: string;
  projectFilePath: string;
  language: NodeLanguage;
  line: number;
  eventType: string;
  elementType: string;
  text: string;
  rawElement: string;
  selector: string;
  componentName?: string;
  handlerFunctionId?: string;
  gitRepoUrl?: string;
  gitBranch?: string;
}
