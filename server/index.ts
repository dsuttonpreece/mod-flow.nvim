import process from "node:process";
import { parseAsync, type SgNode } from "@ast-grep/napi";
import { attach } from "neovim";
import {
  type Cursor,
  getAstGrepLang,
  type SupportedLanguage,
} from "./utils.ts";

type NodeInfo = {
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  text: string;
  type: string;
  cursor?: { line: number; column: number };
};

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
  cursor?: Cursor;
  source?: string;
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

  const children = node.children();
  for (const child of children) {
    if (depth < maxDepth) {
      result += printNodeTree(child, depth + 1, maxDepth, targetNode);
    }
  }

  return result;
}

async function findNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<SgNode> {
  if (!nodeInfo) {
    throw new NoMatchError("tree-sitter node");
  }

  const ast = await parseAsync(getAstGrepLang(language), source);
  const root = ast.root();

  // Use range constraint directly in the query for better performance
  const matchingNodes = root.findAll({
    rule: {
      pattern: "$$$", // Match any node
      range: {
        start: {
          line: nodeInfo.range.start.line,
          column: nodeInfo.range.start.column,
        },
        end: {
          line: nodeInfo.range.end.line,
          column: nodeInfo.range.end.column,
        },
      },
    },
  });

  if (matchingNodes.length === 0) {
    throw new NoMatchError("AST-grep node");
  }

  // Should find exactly one node with this exact range
  const targetNode = matchingNodes[0];
  return targetNode;
}

async function handleDebugNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<ModResult> {
  const targetNode = await findNodeUnderCursor(source, language, nodeInfo);

  if (targetNode) {
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
    const debugInfo = `✅ AST Context (3 levels up, 3 levels down):

${treeView}`;

    throw new DebugError(debugInfo);
  } else {
    throw new NoMatchError("AST-grep node");
  }
}

async function handleCallNearestExpression(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<ModResult> {
  const targetNode = await findNodeUnderCursor(source, language, nodeInfo);

  // Walk up the tree to find the nearest member_expression
  let currentNode = targetNode;
  let memberExpression = null;

  while (currentNode) {
    if (
      currentNode.kind() === "member_expression" ||
      currentNode.kind() === "call_expression"
    ) {
      memberExpression = currentNode;
      break;
    }
    currentNode = currentNode.parent();
  }

  if (!memberExpression) {
    throw new NoMatchError("member expression");
  }

  // Find the root of the member expression chain
  let chainRoot = memberExpression;
  while (chainRoot.parent()) {
    const parent = chainRoot.parent();
    if (
      parent.kind() === "member_expression" ||
      parent.kind() === "call_expression"
    ) {
      chainRoot = parent;
    } else {
      break;
    }
  }

  const originalText = chainRoot.text();
  const range = chainRoot.range();
  const newText = `() => ${originalText}()`;

  return {
    mod: newText,
    original_source: source,
    original_range: range,
  };
}

async function handleDeleteClosestTag(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<ModResult> {
  const targetNode = await findNodeUnderCursor(source, language, nodeInfo);

  // Walk up from the target node to find the nearest JSX construct
  let currentNode = targetNode;
  let foundJsxBoundary = false;

  while (currentNode) {
    const kind = currentNode.kind();

    // Found a JSX construct - delete it (but only the first one we encounter)
    if (
      kind === "jsx_element" ||
      kind === "jsx_self_closing_element" ||
      kind === "jsx_fragment"
    ) {
      if (!foundJsxBoundary) {
        // This is the deepest JSX construct we're inside
        foundJsxBoundary = true;
        return {
          mod: "",
          original_source: source,
          original_range: currentNode.range(),
          clipboard: currentNode.text(),
        };
      } else {
        // We've already found our target JSX construct, don't cross this boundary
        break;
      }
    }

    currentNode = currentNode.parent();
  }

  throw new NoMatchError("JSX tag or fragment");
}

const modMap = {
  debug_node_under_cursor: handleDebugNodeUnderCursor,
  call_nearest_expression: handleCallNearestExpression,
  delete_closest_tag: handleDeleteClosestTag,
} as const;

function handleListMods(): ListModsResult {
  return {
    mods: Object.keys(modMap),
  };
}

type ModHandler = (
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
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

    const [buffer, bufferFiletype] = await Promise.all([
      nvim.buffer,
      nvim.eval("&filetype"),
    ]);
    const lines = await buffer.lines;
    const source = lines.join("\n");
    const language = bufferFiletype as SupportedLanguage;

    // Extract node_info from requestArgs if available
    const nodeInfo = requestArgs?.node_info || null;

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
            throw error; // Re-throw non-ModFlowError errors
          }
        }
      }
    } catch (error) {
      nvim.logger.error(`Error: ${error}`);
    }
  });
}

main().catch((err) => {
  console.error(err);
});
