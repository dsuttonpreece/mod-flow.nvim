import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";

export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "typescriptreact"
  | "javascriptreact";

export type NodeInfo = {
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  text: string;
  type: string;
  cursor: { line: number; column: number };
};

export function getAstGrepLang(language: SupportedLanguage): Lang {
  switch (language) {
    case "javascript":
    case "javascriptreact":
      return Lang.JavaScript;
    case "typescript":
      return Lang.TypeScript;
    case "typescriptreact":
      return Lang.Tsx;
    default:
      return Lang.JavaScript;
  }
}

// Find the smallest/deepest node that contains the cursor position
export async function findNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<SgNode> {
  if (!nodeInfo?.cursor) {
    throw new Error("No cursor position");
  }

  const ast = await parseAsync(getAstGrepLang(language), source);
  const root = ast.root();

  const { line, column } = nodeInfo.cursor;

  function findDeepest(node: SgNode): SgNode | null {
    const range = node.range();

    const afterStart =
      range.start.line < line ||
      (range.start.line === line && range.start.column <= column);
    const beforeEnd =
      range.end.line > line ||
      (range.end.line === line && range.end.column >= column);

    if (!afterStart || !beforeEnd) {
      return null;
    }

    for (const child of node.children()) {
      const deeper = findDeepest(child);
      if (deeper) {
        return deeper;
      }
    }

    return node;
  }

  const result = findDeepest(root);
  if (!result) {
    throw new Error("No node found at cursor");
  }

  return result;
}
