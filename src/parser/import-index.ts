import path from "node:path";
import { type ImportDeclaration, type SourceFile } from "ts-morph";
import { relativeProjectPath } from "../util/path-utils.js";

export interface ImportedSymbol {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  sourceFilePath?: string;
  projectFilePath?: string;
  isDefault?: boolean;
  isNamespace?: boolean;
}

export class ImportIndex {
  private readonly byFile = new Map<string, Map<string, ImportedSymbol>>();

  constructor(private readonly projectRoot: string) {}

  index(sourceFiles: SourceFile[]): void {
    for (const sourceFile of sourceFiles) {
      const imports = new Map<string, ImportedSymbol>();
      for (const declaration of sourceFile.getImportDeclarations()) {
        for (const symbol of extractImportDeclaration(this.projectRoot, declaration)) {
          imports.set(symbol.localName, symbol);
        }
      }
      this.byFile.set(sourceFile.getFilePath(), imports);
    }
  }

  get(filePath: string, localName: string): ImportedSymbol | undefined {
    return this.byFile.get(filePath)?.get(localName);
  }
}

function extractImportDeclaration(projectRoot: string, declaration: ImportDeclaration): ImportedSymbol[] {
  const moduleSpecifier = declaration.getModuleSpecifierValue();
  const targetFile = declaration.getModuleSpecifierSourceFile();
  const sourceFilePath = targetFile?.getFilePath();
  const projectFilePath = sourceFilePath ? relativeProjectPath(projectRoot, sourceFilePath) : undefined;
  const output: ImportedSymbol[] = [];

  const defaultImport = declaration.getDefaultImport();
  if (defaultImport) {
    output.push({
      localName: defaultImport.getText(),
      importedName: "default",
      moduleSpecifier,
      sourceFilePath,
      projectFilePath,
      isDefault: true
    });
  }

  const namespaceImport = declaration.getNamespaceImport();
  if (namespaceImport) {
    output.push({
      localName: namespaceImport.getText(),
      importedName: "*",
      moduleSpecifier,
      sourceFilePath,
      projectFilePath,
      isNamespace: true
    });
  }

  for (const namedImport of declaration.getNamedImports()) {
    output.push({
      localName: namedImport.getAliasNode()?.getText() ?? namedImport.getName(),
      importedName: namedImport.getName(),
      moduleSpecifier,
      sourceFilePath,
      projectFilePath
    });
  }

  return output;
}

export function externalModuleId(specifier: string): string {
  const parts = specifier.startsWith("@") ? specifier.split("/").slice(0, 2) : [specifier.split("/")[0] ?? specifier];
  return `npm:${path.posix.join(...parts)}`;
}
