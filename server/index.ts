import { kind, parse, type SgNode } from "@ast-grep/napi";
import { attach } from "neovim";
import { getAstGrepLang, type SupportedLanguage } from "./utils.ts";

type Cursor = {
  line: number;
  column: number;
};

type ModResult = {
  found: boolean;
  mod?: string;
  original_range?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  cursor?: Cursor;
  original_source?: string;
  source?: string;
};

type ListModsResult = {
  mods: string[];
};

function findClosestNodeAtCursor(matches: SgNode[], cursor: Cursor) {
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

function handleDeleteFunction(
  source: string,
  language: SupportedLanguage,
  cursor: Cursor,
): ModResult {
  const ast = parse(getAstGrepLang(language), source);
  const root = ast.root();
  const lang = getAstGrepLang(language);

  const functionDeclarations = root.findAll(kind(lang, "function_declaration"));

  const closestFunction = findClosestNodeAtCursor(functionDeclarations, cursor);

  if (closestFunction) {
    const range = closestFunction.range();

    return {
      found: true,
      mod: "", // Delete means empty replacement
      original_range: {
        start: { line: range.start.line, column: range.start.column },
        end: { line: range.end.line, column: range.end.column },
      },
      cursor: cursor,
      original_source: source,
      source: source.replace(closestFunction.text(), ""),
    };
  } else {
    return {
      found: false,
      cursor: cursor,
    };
  }
}

function findParentCallExpression(node: SgNode): SgNode | null {
  // Start from parent to ensure we don't match the node itself
  let current = node.parent();
  while (current) {
    if (current.kind() === "call_expression") {
      return current;
    }
    current = current.parent();
  }
  return null;
}

function extractCallArguments(callExpression: SgNode): string[] {
  const argumentsNode = callExpression.field("arguments");
  if (!argumentsNode) return [];

  return argumentsNode.children().map((arg) => arg.text());
}

function findTargetNodeAtCursor(
  nodes: SgNode[],
  cursor: Cursor,
): SgNode | undefined {
  // Find nodes that contain the cursor, including children of member expression types
  const candidateNodes: SgNode[] = [];

  for (const node of nodes) {
    // Check if cursor is within this node
    const range = node.range();
    const withinLineRange =
      cursor.line >= range.start.line && cursor.line <= range.end.line;
    const withinStartCol =
      cursor.line > range.start.line || cursor.column >= range.start.column;
    const withinEndCol =
      cursor.line < range.end.line || cursor.column <= range.end.column;

    if (withinLineRange && withinStartCol && withinEndCol) {
      candidateNodes.push(node);

      // Also check children for member expression types
      if (
        [
          "member_expression",
          "optional_member_expression",
          "subscript_expression",
        ].includes(node.kind().toString())
      ) {
        const children = node.children();
        for (const child of children) {
          if (
            [
              "identifier",
              "member_expression",
              "subscript_expression",
              "optional_member_expression",
            ].includes(child.kind().toString())
          ) {
            const childRange = child.range();
            const childWithinLineRange =
              cursor.line >= childRange.start.line &&
              cursor.line <= childRange.end.line;
            const childWithinStartCol =
              cursor.line > childRange.start.line ||
              cursor.column >= childRange.start.column;
            const childWithinEndCol =
              cursor.line < childRange.end.line ||
              cursor.column <= childRange.end.column;

            if (
              childWithinLineRange &&
              childWithinStartCol &&
              childWithinEndCol
            ) {
              candidateNodes.push(child);
            }
          }
        }
      }
    }
  }

  // Return the smallest (most specific) node
  return findClosestNodeAtCursor(candidateNodes, cursor);
}

function findParentJsxExpression(node: SgNode): SgNode | null {
  let current = node.parent();
  while (current) {
    if (current.kind() === "jsx_expression") {
      return current;
    }
    current = current.parent();
  }
  return null;
}

function isOnlyChildOfJsxExpression(
  node: SgNode,
  jsxExpression: SgNode,
): boolean {
  const children = jsxExpression
    .children()
    .filter((child) => child.kind() !== "{" && child.kind() !== "}");
  return (
    children.length === 1 && children[0].text().trim() === node.text().trim()
  );
}

function handlePointFreeToAnon(
  source: string,
  language: SupportedLanguage,
  cursor: Cursor,
): ModResult {
  const ast = parse(getAstGrepLang(language), source);
  const root = ast.root();
  const lang = getAstGrepLang(language);

  const targetNodes = [
    ...root.findAll(kind(lang, "identifier")),
    ...root.findAll(kind(lang, "member_expression")),
    ...root.findAll(kind(lang, "subscript_expression")),
    ...root.findAll(kind(lang, "optional_member_expression")),
  ];

  const closestNode = findTargetNodeAtCursor(targetNodes, cursor);

  if (closestNode) {
    const range = closestNode.range();
    const originalText = closestNode.text();

    // Check if the second-to-last member accessor is optional
    const hasOptionalChaining = originalText.includes("?.");
    const transformedText = hasOptionalChaining
      ? `() => ${originalText}?.()`
      : `() => ${originalText}()`;

    // Check if target node is any argument of a call
    const parentCall = findParentCallExpression(closestNode);
    if (parentCall) {
      const args = extractCallArguments(parentCall);
      if (args.includes(originalText)) {
        return {
          found: true,
          mod: transformedText,
          original_range: {
            start: { line: range.start.line, column: range.start.column },
            end: { line: range.end.line, column: range.end.column },
          },
          cursor: cursor,
          original_source: source,
          source: source.replace(originalText, transformedText),
        };
      }
    }

    // Check if target node is the only child of a JSX attribute expression
    const parentJsxExpression = findParentJsxExpression(closestNode);
    if (
      parentJsxExpression &&
      isOnlyChildOfJsxExpression(closestNode, parentJsxExpression)
    ) {
      return {
        found: true,
        mod: transformedText,
        original_range: {
          start: { line: range.start.line, column: range.start.column },
          end: { line: range.end.line, column: range.end.column },
        },
        cursor: cursor,
        original_source: source,
        source: source.replace(originalText, transformedText),
      };
    }

    return {
      found: false,
      cursor: cursor,
    };
  } else {
    return {
      found: false,
      cursor: cursor,
    };
  }
}

const modMap = {
  delete_function: handleDeleteFunction,
  point_free_to_anon: handlePointFreeToAnon,
} as const;

function handleListMods(): ListModsResult {
  return {
    mods: Object.keys(modMap),
  };
}

type ModHandler = (
  source: string,
  language: SupportedLanguage,
  cursor: Cursor,
) => ModResult;

type ListModsHandler = () => ListModsResult;

function getModHandler(method: string): ModHandler | null {
  return modMap[method as keyof typeof modMap] || null;
}

function getListModsHandler(method: string): ListModsHandler | null {
  return method === "list_mods" ? handleListMods : null;
}

async function main() {
  const nvim = attach({
    reader: process.stdin,
    writer: process.stdout,
  });

  nvim.on("notification", async (method, args) => {
    const [requestId, requestArgs] = args;

    const [cursorRaw, buffer, bufferFiletype] = await Promise.all([
      nvim.window.cursor,
      nvim.buffer,
      nvim.eval("&filetype"),
    ]);
    const cursor: Cursor = { line: cursorRaw[0] - 1, column: cursorRaw[1] + 1 };
    const lines = await buffer.lines;
    const source = lines.join("\n");
    const language = bufferFiletype as SupportedLanguage;

    try {
      const listModsHandler = getListModsHandler(method);
      if (listModsHandler) {
        const result = listModsHandler();
        await nvim.lua("require('mod-flow').handle_response(...)", [
          requestId,
          result,
        ]);
        return;
      }

      const modHandler = getModHandler(method);
      if (modHandler) {
        const result = modHandler(source, language, cursor);
        await nvim.lua("require('mod-flow').handle_response(...)", [
          requestId,
          result,
        ]);
      }
    } catch (error) {
      nvim.logger.error(`Error: ${error}`);
    }
  });
}

main().catch((err) => {
  console.error(err);
});
