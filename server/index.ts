import { kind, parseAsync, type SgNode } from "@ast-grep/napi";
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

async function handleDeleteFunction(
  source: string,
  language: SupportedLanguage,
  cursor: Cursor,
): Promise<ModResult> {
  const ast = await parseAsync(getAstGrepLang(language), source);
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

async function hasOptionalLastAccessor(
  source: string,
  language: SupportedLanguage,
  expressionText: string,
): Promise<boolean> {
  // Parse just the expression to check for optional chaining on the last accessor
  const ast = await parseAsync(getAstGrepLang(language), expressionText);
  const root = ast.root();
  const lang = getAstGrepLang(language);

  // Find the outermost expression node (the root of the member/call chain)
  const memberExpressions = root.findAll(kind(lang, "member_expression"));
  const optionalMemberExpressions = root.findAll(
    kind(lang, "optional_member_expression"),
  );
  const subscriptExpressions = root.findAll(kind(lang, "subscript_expression"));

  // Find the outermost (top-level) expression
  const allExpressions = [
    ...memberExpressions,
    ...optionalMemberExpressions,
    ...subscriptExpressions,
  ];

  // The outermost expression is the one that's not a child of another member expression
  const outermostExpression = allExpressions.find((expr) => {
    let parent = expr.parent();
    while (parent && parent !== root) {
      if (
        [
          "member_expression",
          "optional_member_expression",
          "subscript_expression",
        ].includes(parent.kind().toString())
      ) {
        return false; // This expression is nested inside another
      }
      parent = parent.parent();
    }
    return true;
  });

  // Check if the outermost expression is an optional member expression
  return outermostExpression?.kind() === "optional_member_expression";
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

async function handlePointFreeToAnon(
  source: string,
  language: SupportedLanguage,
  cursor: Cursor,
): Promise<ModResult> {
  const ast = await parseAsync(getAstGrepLang(language), source);
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

    // We'll determine optional chaining based on the full expression being transformed
    const transformedText = `() => ${originalText}()`;

    // Check if target node is any argument of a call
    const parentCall = findParentCallExpression(closestNode);
    if (parentCall) {
      const args = extractCallArguments(parentCall);
      // Check if the exact node text is an argument
      if (args.includes(originalText)) {
        // Check if the last accessor is already optional - if not, add optional chaining
        const lastAccessorIsOptional = await hasOptionalLastAccessor(
          source,
          language,
          originalText,
        );
        const exactTransformedText = lastAccessorIsOptional
          ? `() => ${originalText}()`
          : `() => ${originalText}?.()`;

        return {
          found: true,
          mod: exactTransformedText,
          original_range: {
            start: { line: range.start.line, column: range.start.column },
            end: { line: range.end.line, column: range.end.column },
          },
          cursor: cursor,
          original_source: source,
          source: source.replace(originalText, exactTransformedText),
        };
      }

      // Check if the target node is part of a member expression that is an argument
      // This handles cases like cursor anywhere in a member expression chain
      for (const arg of args) {
        // Check if the target node appears anywhere in the argument
        // Handle various patterns: obj.prop, obj?.prop, obj[key], obj?.method()
        const escapedOriginalText = originalText.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const patterns = [
          // At start: obj.something, obj?.something, obj[something]
          new RegExp(`^${escapedOriginalText}[\\.\\?\\[]`),
          // In middle: something.obj.something, something?.obj?.something
          new RegExp(`[\\.\\?]${escapedOriginalText}[\\.\\?\\[]`),
          // At end before parentheses: something.obj(), something?.obj?()
          new RegExp(`[\\.\\?]${escapedOriginalText}\\??\\(`),
          // Exact match: just obj (when it's the whole expression)
          new RegExp(`^${escapedOriginalText}$`),
        ];

        const matchesPattern = patterns.some((pattern) => pattern.test(arg));

        if (matchesPattern) {
          // Check if the last accessor in the full expression is already optional
          const lastAccessorIsOptional = await hasOptionalLastAccessor(
            source,
            language,
            arg,
          );
          const fullTransformedText = lastAccessorIsOptional
            ? `() => ${arg}()`
            : `() => ${arg}?.()`;

          // Find the range of the full argument expression, not just the target node
          const ast = await parseAsync(getAstGrepLang(language), source);
          const root = ast.root();
          const lang = getAstGrepLang(language);

          // Find all expressions that match the full argument text
          const allNodes = [
            ...root.findAll(kind(lang, "member_expression")),
            ...root.findAll(kind(lang, "optional_member_expression")),
            ...root.findAll(kind(lang, "subscript_expression")),
            ...root.findAll(kind(lang, "identifier")),
          ];

          const argNode = allNodes.find((node) => node.text() === arg);
          const argRange = argNode ? argNode.range() : range;

          return {
            found: true,
            mod: fullTransformedText,
            original_range: {
              start: {
                line: argRange.start.line,
                column: argRange.start.column,
              },
              end: { line: argRange.end.line, column: argRange.end.column },
            },
            cursor: cursor,
            original_source: source,
            source: source.replace(arg, fullTransformedText),
          };
        }
      }
    }

    // Check if target node is part of a JSX attribute expression
    const parentJsxExpression = findParentJsxExpression(closestNode);
    if (parentJsxExpression) {
      // Get the full expression text from the JSX expression
      const jsxChildren = parentJsxExpression
        .children()
        .filter((child) => child.kind() !== "{" && child.kind() !== "}");

      if (jsxChildren.length === 1) {
        const fullExpressionText = jsxChildren[0].text().trim();

        // Always try to transform when we're in a JSX expression with a single child
        // Check if the target is part of the expression (exact match or partial match)
        const escapedOriginalText = originalText.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const patterns = [
          // At start: obj.something, obj?.something, obj[something]
          new RegExp(`^${escapedOriginalText}[\\.\\?\\[]`),
          // In middle: something.obj.something, something?.obj?.something
          new RegExp(`[\\.\\?]${escapedOriginalText}[\\.\\?\\[]`),
          // At end before parentheses: something.obj(), something?.obj?()
          new RegExp(`[\\.\\?]${escapedOriginalText}\\??\\(`),
          // Exact match: just obj (when it's the whole expression)
          new RegExp(`^${escapedOriginalText}$`),
        ];

        const matchesPattern = patterns.some((pattern) =>
          pattern.test(fullExpressionText),
        );

        if (matchesPattern) {
          // Check if the last accessor in the full expression is already optional
          const lastAccessorIsOptional = await hasOptionalLastAccessor(
            source,
            language,
            fullExpressionText,
          );
          const fullTransformedText = lastAccessorIsOptional
            ? `() => ${fullExpressionText}()`
            : `() => ${fullExpressionText}?.()`;

          // Find the range of the full expression, not just the target node
          const ast = await parseAsync(getAstGrepLang(language), source);
          const root = ast.root();
          const lang = getAstGrepLang(language);

          // Find all expressions that match the full expression text
          const allNodes = [
            ...root.findAll(kind(lang, "member_expression")),
            ...root.findAll(kind(lang, "optional_member_expression")),
            ...root.findAll(kind(lang, "subscript_expression")),
            ...root.findAll(kind(lang, "identifier")),
          ];

          const exprNode = allNodes.find(
            (node) => node.text() === fullExpressionText,
          );
          const exprRange = exprNode ? exprNode.range() : range;

          return {
            found: true,
            mod: fullTransformedText,
            original_range: {
              start: {
                line: exprRange.start.line,
                column: exprRange.start.column,
              },
              end: { line: exprRange.end.line, column: exprRange.end.column },
            },
            cursor: cursor,
            original_source: source,
            source: source.replace(fullExpressionText, fullTransformedText),
          };
        }
      }
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
) => Promise<ModResult>;

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
        const result = await modHandler(source, language, cursor);
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
