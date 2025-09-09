import { Lang, type SgNode } from "@ast-grep/napi";

export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "typescriptreact"
  | "javascriptreact";

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

export type Cursor = {
  line: number;
  column: number;
};

export function findClosestNodeAtCursor(matches: SgNode[], cursor: Cursor) {
  let closestNode: SgNode | undefined;
  let smallestRange = Infinity;

  for (const match of matches) {
    const range = match.range();
    const start = range.start;
    const end = range.end;

    const withinLineRange =
      cursor.line >= start.line && cursor.line <= end.line;
    const withinStartCol =
      cursor.line > start.line || cursor.column >= start.column;
    const withinEndCol = cursor.line < end.line || cursor.column <= end.column;

    if (withinLineRange && withinStartCol && withinEndCol) {
      const rangeSize =
        (end.line - start.line) * 1000 + (end.column - start.column);

      if (rangeSize < smallestRange) {
        smallestRange = rangeSize;
        closestNode = match;
      }
    }
  }

  return closestNode;
}

