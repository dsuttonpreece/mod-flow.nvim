import { kind, parseAsync, type SgNode } from "@ast-grep/napi";
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
};

type ModError = {
  code: string;
  message: string;
};

type ModResult = ModSuccessResult | ModError;

type ListModsResult = {
  mods: string[];
};

async function handleDebugNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<ModResult> {
  if (!nodeInfo) {
    throw new DebugError("No tree-sitter node info received");
  }

  const ast = await parseAsync(getAstGrepLang(language), source);
  const root = ast.root();

  // Find all nodes to search through
  const allNodes = root.findAll();

  // Find the matching ast-grep node using exact range matching
  let matchingAstGrepNode: SgNode | undefined;

  for (const node of allNodes) {
    const range = node.range();

    // Match by exact range coordinates
    if (
      range.start.line === nodeInfo.range.start.line &&
      range.start.column === nodeInfo.range.start.column &&
      range.end.line === nodeInfo.range.end.line &&
      range.end.column === nodeInfo.range.end.column
    ) {
      matchingAstGrepNode = node;
      break;
    }
  }

  let debugInfo = `Tree-sitter Node:
  Type: ${nodeInfo.type}
  Range: (${nodeInfo.range.start.line},${nodeInfo.range.start.column}) -> (${nodeInfo.range.end.line},${nodeInfo.range.end.column})
  Text: "${nodeInfo.text}"

AST-grep Node:`;

  if (matchingAstGrepNode) {
    const astRange = matchingAstGrepNode.range();
    debugInfo += `
  Kind: ${matchingAstGrepNode.kind()}
  Range: (${astRange.start.line},${astRange.start.column}) -> (${astRange.end.line},${astRange.end.column})
  Text: "${matchingAstGrepNode.text()}"

  ✅ EXACT RANGE MATCH FOUND`;
  } else {
    debugInfo += `
  ❌ NO EXACT RANGE MATCH FOUND

  Searching for similar nodes...`;

    // Find nodes with same text but different range
    const sameTextNodes = allNodes.filter(node => node.text() === nodeInfo.text);
    if (sameTextNodes.length > 0) {
      debugInfo += `\n\n  Nodes with same text but different ranges:`;
      for (const node of sameTextNodes.slice(0, 3)) { // Show max 3
        const range = node.range();
        debugInfo += `\n    Kind: ${node.kind()}, Range: (${range.start.line},${range.start.column}) -> (${range.end.line},${range.end.column})`;
      }
    }

    // Find nodes with overlapping ranges
    const overlappingNodes = allNodes.filter(node => {
      const range = node.range();
      return (
        range.start.line <= nodeInfo.range.end.line &&
        range.end.line >= nodeInfo.range.start.line &&
        !(range.start.line === nodeInfo.range.start.line && range.start.column === nodeInfo.range.start.column &&
          range.end.line === nodeInfo.range.end.line && range.end.column === nodeInfo.range.end.column)
      );
    });

    if (overlappingNodes.length > 0) {
      debugInfo += `\n\n  Nodes with overlapping ranges:`;
      for (const node of overlappingNodes.slice(0, 3)) { // Show max 3
        const range = node.range();
        debugInfo += `\n    Kind: ${node.kind()}, Range: (${range.start.line},${range.start.column}) -> (${range.end.line},${range.end.column}), Text: "${node.text().slice(0, 30)}${node.text().length > 30 ? '...' : ''}"`;
      }
    }
  }

  throw new DebugError(debugInfo);
}

async function handleDeleteFunction(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<ModResult> {
  const ast = await parseAsync(getAstGrepLang(language), source);
  const root = ast.root();
  const lang = getAstGrepLang(language);

  let targetFunction: SgNode | undefined;

  if (nodeInfo) {
    // Find the node using range and text constraints
    const functionDeclarations = root.findAll(
      kind(lang, "function_declaration"),
    );

    for (const func of functionDeclarations) {
      const range = func.range();
      const funcText = func.text();

      // Match by range and text content
      if (
        range.start.line === nodeInfo.range.start.line &&
        range.start.column === nodeInfo.range.start.column &&
        range.end.line === nodeInfo.range.end.line &&
        range.end.column === nodeInfo.range.end.column &&
        funcText === nodeInfo.text
      ) {
        targetFunction = func;
        break;
      }
    }
  }

  if (targetFunction) {
    const range = targetFunction.range();

    return {
      mod: "", // Delete means empty replacement
      original_range: {
        start: { line: range.start.line, column: range.start.column },
        end: { line: range.end.line, column: range.end.column },
      },
      original_source: source,
      source: source.replace(targetFunction.text(), ""),
    };
  } else {
    throw new NoMatchError("function");
  }
}

const modMap = {
  debug_node_under_cursor: handleDebugNodeUnderCursor,
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
