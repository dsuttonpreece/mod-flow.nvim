import process from "node:process";
import type { SgNode } from "@ast-grep/napi";
import { attach } from "neovim";
import {
  findNodeUnderCursor,
  type NodeInfo,
  type SupportedLanguage,
} from "./utils.ts";

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

  for (const child of node.children()) {
    if (depth < maxDepth) {
      result += printNodeTree(child, depth + 1, maxDepth, targetNode);
    }
  }

  return result;
}

async function handleDebugNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
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

const modMap = {
  debug_node_under_cursor: handleDebugNodeUnderCursor,
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
            throw error;
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
