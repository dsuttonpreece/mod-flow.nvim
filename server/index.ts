import process from "node:process";
import type { SgNode } from "@ast-grep/napi";
import { attach } from "neovim";
import {
  findListParentAtCursor,
  findNodeUnderCursor,
  type NodeInfo,
  type SupportedLanguage,
} from "./utils.ts";

type Direction = "left" | "right";

function cursorContains(
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  },
  line: number,
  column: number,
): boolean {
  const afterStart =
    range.start.line < line ||
    (range.start.line === line && range.start.column <= column);
  const beforeEnd =
    range.end.line > line ||
    (range.end.line === line && range.end.column >= column);
  return afterStart && beforeEnd;
}

function calculateCursorOffset(
  line: number,
  column: number,
  itemStart: { line: number; column: number },
): { lineOffset: number; colOffset: number } {
  const lineOffset = line - itemStart.line;
  const colOffset = lineOffset === 0 ? column - itemStart.column : column;
  return { lineOffset, colOffset };
}

function applyCursorOffset(
  newStart: { line: number; column: number },
  offset: { lineOffset: number; colOffset: number },
): { line: number; column: number } {
  return {
    line: newStart.line + offset.lineOffset,
    column:
      offset.lineOffset === 0
        ? newStart.column + offset.colOffset
        : offset.colOffset,
  };
}

async function handleMoveNode(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo,
  direction: Direction,
): Promise<ModResult> {
  const listParent = await findListParentAtCursor(source, language, nodeInfo);
  if (!listParent) {
    throw new NoMatchError("swappable expression");
  }

  const { line, column } = nodeInfo.cursor;
  const parentKind = listParent.kind() as string;

  // Handle binary expressions specially
  if (parentKind === "binary_expression") {
    const children = listParent.children();
    // binary_expression has: left, operator, right
    const left = children[0];
    const operator = children[1];
    const right = children[2];

    if (!left || !operator || !right) {
      throw new NoMatchError("binary operand");
    }

    const onLeft = cursorContains(left.range(), line, column);
    const onRight = cursorContains(right.range(), line, column);
    const onOperator = cursorContains(operator.range(), line, column);

    if (!onLeft && !onRight && !onOperator) {
      throw new NoMatchError("operand");
    }

    // move_left on left or move_right on right = can't move further
    // (cursor on operator can always swap)
    if (
      !onOperator &&
      ((direction === "left" && onLeft) || (direction === "right" && onRight))
    ) {
      throw new NoMatchError(
        direction === "left" ? "previous operand" : "next operand",
      );
    }

    // Swap: left op right -> right op left
    // Calculate new cursor position
    let newCursor;

    if (onOperator) {
      // Cursor on operator - keep it on operator after swap
      const rightText = right.text();
      const rightLines = rightText.split("\n");
      const rightLineCount = rightLines.length - 1;
      const rightLastLineLen = rightLines[rightLines.length - 1].length;

      const cursorOffset = calculateCursorOffset(
        line,
        column,
        operator.range().start,
      );

      if (rightLineCount === 0) {
        newCursor = {
          line: left.range().start.line + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? left.range().start.column +
                rightLastLineLen +
                1 +
                cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      } else {
        newCursor = {
          line:
            left.range().start.line + rightLineCount + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? rightLastLineLen + 1 + cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      }
    } else if (onRight) {
      // Cursor was on right, moving left -> cursor now at start (where left was)
      const cursorOffset = calculateCursorOffset(
        line,
        column,
        right.range().start,
      );
      newCursor = applyCursorOffset(left.range().start, cursorOffset);
    } else {
      // Cursor was on left, moving right -> cursor now after "right op "
      const cursorOffset = calculateCursorOffset(
        line,
        column,
        left.range().start,
      );
      const rightText = right.text();
      const rightLines = rightText.split("\n");
      const rightLineCount = rightLines.length - 1;
      const rightLastLineLen = rightLines[rightLines.length - 1].length;
      const opText = operator.text();

      if (rightLineCount === 0) {
        newCursor = {
          line: left.range().start.line + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? left.range().start.column +
                rightLastLineLen +
                opText.length +
                2 +
                cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      } else {
        newCursor = {
          line:
            left.range().start.line + rightLineCount + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? rightLastLineLen + opText.length + 2 + cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      }
    }

    return {
      mod: `${right.text()} ${operator.text()} ${left.text()}`,
      original_source: source,
      original_range: {
        start: listParent.range().start,
        end: listParent.range().end,
      },
      cursor: newCursor,
    };
  }

  // Handle ternary expressions: condition ? consequent : alternate
  // We swap consequent and alternate around the : operator
  if (parentKind === "ternary_expression") {
    const children = listParent.children();
    // ternary_expression has: condition, ?, consequent, :, alternate
    const condition = children[0];
    const questionMark = children[1];
    const consequent = children[2];
    const colonOp = children[3];
    const alternate = children[4];

    if (!condition || !questionMark || !consequent || !colonOp || !alternate) {
      throw new NoMatchError("ternary branch");
    }

    const onCondition = cursorContains(condition.range(), line, column);
    const onQuestionMark = cursorContains(questionMark.range(), line, column);
    const onConsequent = cursorContains(consequent.range(), line, column);
    const onColon = cursorContains(colonOp.range(), line, column);
    const onAlternate = cursorContains(alternate.range(), line, column);

    // Only allow swapping when cursor is on consequent, :, or alternate
    if (onCondition || onQuestionMark) {
      throw new NoMatchError("ternary branch (cursor on condition)");
    }

    if (!onConsequent && !onColon && !onAlternate) {
      throw new NoMatchError("ternary branch");
    }

    // move_left on consequent or move_right on alternate = can't move further
    if (
      !onColon &&
      ((direction === "left" && onConsequent) || (direction === "right" && onAlternate))
    ) {
      throw new NoMatchError(
        direction === "left" ? "previous branch" : "next branch",
      );
    }

    // Swap: condition ? consequent : alternate -> condition ? alternate : consequent
    // We only replace the "consequent : alternate" portion
    let newCursor;

    if (onColon) {
      // Cursor on colon - keep it on colon after swap
      const alternateText = alternate.text();
      const alternateLines = alternateText.split("\n");
      const alternateLineCount = alternateLines.length - 1;
      const alternateLastLineLen = alternateLines[alternateLines.length - 1].length;

      const cursorOffset = calculateCursorOffset(
        line,
        column,
        colonOp.range().start,
      );

      if (alternateLineCount === 0) {
        newCursor = {
          line: consequent.range().start.line + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? consequent.range().start.column +
                alternateLastLineLen +
                1 +
                cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      } else {
        newCursor = {
          line:
            consequent.range().start.line + alternateLineCount + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? alternateLastLineLen + 1 + cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      }
    } else if (onAlternate) {
      // Cursor was on alternate, moving left -> cursor now at start (where consequent was)
      const cursorOffset = calculateCursorOffset(
        line,
        column,
        alternate.range().start,
      );
      newCursor = applyCursorOffset(consequent.range().start, cursorOffset);
    } else {
      // Cursor was on consequent, moving right -> cursor now after "alternate : "
      const cursorOffset = calculateCursorOffset(
        line,
        column,
        consequent.range().start,
      );
      const alternateText = alternate.text();
      const alternateLines = alternateText.split("\n");
      const alternateLineCount = alternateLines.length - 1;
      const alternateLastLineLen = alternateLines[alternateLines.length - 1].length;

      if (alternateLineCount === 0) {
        newCursor = {
          line: consequent.range().start.line + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? consequent.range().start.column +
                alternateLastLineLen +
                3 + // " : " is 3 chars
                cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      } else {
        newCursor = {
          line:
            consequent.range().start.line + alternateLineCount + cursorOffset.lineOffset,
          column:
            cursorOffset.lineOffset === 0
              ? alternateLastLineLen + 3 + cursorOffset.colOffset
              : cursorOffset.colOffset,
        };
      }
    }

    return {
      mod: `${condition.text()} ${questionMark.text()} ${alternate.text()} ${colonOp.text()} ${consequent.text()}`,
      original_source: source,
      original_range: {
        start: listParent.range().start,
        end: listParent.range().end,
      },
      cursor: newCursor,
    };
  }

  // Handle comma-separated lists (arguments, formal_parameters)
  const items = listParent.children().filter((child) => {
    const kind = child.kind();
    return kind !== "," && kind !== "(" && kind !== ")";
  });

  const currentIndex = items.findIndex((item) =>
    cursorContains(item.range(), line, column),
  );

  if (currentIndex < 0) {
    throw new NoMatchError("item");
  }

  if (direction === "left") {
    if (currentIndex === 0) {
      throw new NoMatchError("previous item");
    }
    const prevItem = items[currentIndex - 1];
    const currItem = items[currentIndex];

    const cursorOffset = calculateCursorOffset(
      line,
      column,
      currItem.range().start,
    );
    const newCursor = applyCursorOffset(prevItem.range().start, cursorOffset);

    return {
      mod: `${currItem.text()}, ${prevItem.text()}`,
      original_source: source,
      original_range: {
        start: prevItem.range().start,
        end: currItem.range().end,
      },
      cursor: newCursor,
    };
  } else {
    if (currentIndex >= items.length - 1) {
      throw new NoMatchError("next item");
    }
    const currItem = items[currentIndex];
    const nextItem = items[currentIndex + 1];

    const cursorOffset = calculateCursorOffset(
      line,
      column,
      currItem.range().start,
    );

    const nextText = nextItem.text();
    const nextLines = nextText.split("\n");
    const nextLineCount = nextLines.length - 1;
    const nextLastLineLen = nextLines[nextLines.length - 1].length;

    let newCursor;
    if (nextLineCount === 0) {
      newCursor = {
        line: currItem.range().start.line + cursorOffset.lineOffset,
        column:
          cursorOffset.lineOffset === 0
            ? currItem.range().start.column +
              nextLastLineLen +
              2 +
              cursorOffset.colOffset
            : cursorOffset.colOffset,
      };
    } else {
      newCursor = {
        line:
          currItem.range().start.line + nextLineCount + cursorOffset.lineOffset,
        column:
          cursorOffset.lineOffset === 0
            ? nextLastLineLen + 2 + cursorOffset.colOffset
            : cursorOffset.colOffset,
      };
    }

    return {
      mod: `${nextItem.text()}, ${currItem.text()}`,
      original_source: source,
      original_range: {
        start: currItem.range().start,
        end: nextItem.range().end,
      },
      cursor: newCursor,
    };
  }
}

const handleMoveLeft = (
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo,
) => handleMoveNode(source, language, nodeInfo, "left");

const handleMoveRight = (
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo,
) => handleMoveNode(source, language, nodeInfo, "right");

async function handleDebugNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo,
): Promise<ModResult> {
  const targetNode = await findNodeUnderCursor(source, language, nodeInfo);

  // Walk up 3 parent levels to find the root for our tree
  let contextRoot = targetNode;
  for (let i = 0; i < 3; i++) {
    const parent = contextRoot.parent();
    if (
      parent &&
      parent.kind() !== "source_file" &&
      parent.kind() !== "program"
    ) {
      contextRoot = parent;
    } else {
      break;
    }
  }

  const treeView = printNodeTree(contextRoot, 0, 3, targetNode);
  const debugInfo = `AST Context (3 levels up, 3 levels down):

${treeView}`;

  throw new DebugError(debugInfo);
}

function printNodeTree(
  node: SgNode,
  depth: number = 0,
  maxDepth: number = 3,
  targetNode?: SgNode,
): string {
  if (depth > maxDepth) {
    return "";
  }

  const indent = "  ".repeat(depth);
  const isTarget =
    targetNode &&
    node.range().start.line === targetNode.range().start.line &&
    node.range().start.column === targetNode.range().start.column &&
    node.range().end.line === targetNode.range().end.line &&
    node.range().end.column === targetNode.range().end.column;

  const nodeKind = isTarget ? `<<<${node.kind()}>>>` : node.kind();
  let result = `${indent}${nodeKind}\n`;

  for (const child of node.children()) {
    if (depth < maxDepth) {
      result += printNodeTree(child, depth + 1, maxDepth, targetNode);
    }
  }

  return result;
}

const modMap = {
  debug_node_under_cursor: handleDebugNodeUnderCursor,
  move_left: handleMoveLeft,
  move_right: handleMoveRight,
} as const;

function handleListMods(): ListModsResult {
  return {
    mods: Object.keys(modMap),
  };
}

type ModHandler = (
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo,
) => Promise<ModResult>;

type ListModsHandler = () => ListModsResult;

function getModHandler(method: string): ModHandler | null {
  return modMap[method as keyof typeof modMap] || null;
}

function getListModsHandler(method: string): ListModsHandler | null {
  return method === "list_mods" ? handleListMods : null;
}

function main() {
  const nvim = attach({
    reader: process.stdin,
    writer: process.stdout,
  });

  nvim.on("notification", async (method, args) => {
    const [requestId, requestArgs] = args;

    const [buffer, bufferFiletype] = await Promise.all([
      nvim.buffer,
      nvim.eval("&filetype"),
    ]);
    const lines = await buffer.lines;
    const source = lines.join("\n");
    const language = bufferFiletype as SupportedLanguage;

    const nodeInfo = requestArgs?.node_info;

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
        if (!nodeInfo) {
          throw new NoMatchError("cursor position");
        }
        try {
          const result = await modHandler(source, language, nodeInfo);
          await nvim.lua("require('mod-flow').handle_response(...)", [
            requestId,
            result,
          ]);
        } catch (error) {
          if (error instanceof ModFlowError) {
            const errorResult: ModError = {
              code: error.code,
              message: error.message,
            };
            await nvim.lua("require('mod-flow').handle_response(...)", [
              requestId,
              errorResult,
            ]);
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      nvim.logger.error(`Error: ${error}`);
    }
  });
}

try {
  main();
} catch (err) {
  console.error(err);
}

class ModFlowError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModFlowError";
    this.code = code;
  }
}

class NoMatchError extends ModFlowError {
  constructor(nodeType: string) {
    super("NO_MATCH", `No ${nodeType} found at cursor`);
  }
}

class DebugError extends ModFlowError {
  constructor(message: string) {
    super("DEBUG", message);
  }
}

type ModSuccessResult = {
  mod: string;
  original_source: string;
  original_range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  cursor?: { line: number; column: number };
  clipboard?: string;
};

type ModError = {
  code: string;
  message: string;
};

type ModResult = ModSuccessResult | ModError;

type ListModsResult = {
  mods: string[];
};
