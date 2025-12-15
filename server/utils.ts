import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";

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
  nodeInfo: NodeInfo,
): Promise<SgNode> {
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
      (range.end.line === line && range.end.column > column);

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

// Find the closest ancestor matching any of the given kinds
export function findAncestorOfKind(node: SgNode, kinds: string[]): SgNode | null {
  let current: SgNode | null = node;
  while (current) {
    if (kinds.includes(current.kind() as string)) {
      return current;
    }
    current = current.parent();
  }
  return null;
}

const LIST_PARENT_KINDS = ["arguments", "formal_parameters", "binary_expression", "ternary_expression", "object_pattern", "intersection_type", "union_type"];

export async function findListParentAtCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo,
): Promise<SgNode | null> {
  const node = await findNodeUnderCursor(source, language, nodeInfo);
  return findAncestorOfKind(node, LIST_PARENT_KINDS);
}

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

