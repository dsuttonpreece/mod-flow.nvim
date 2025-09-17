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

function printNodeTree(node: SgNode, depth: number = 0, maxDepth: number = 3, targetNode?: SgNode, fieldName?: string): string {
  if (depth > maxDepth) {
    return "";
  }

  const indent = "  ".repeat(depth);
  const isTarget = targetNode &&
    node.range().start.line === targetNode.range().start.line &&
    node.range().start.column === targetNode.range().start.column &&
    node.range().end.line === targetNode.range().end.line &&
    node.range().end.column === targetNode.range().end.column;

  const nodeKind = isTarget ? `<<<${node.kind()}>>>` : node.kind();
  const fieldPrefix = fieldName ? `${fieldName}: ` : "";
  let result = `${indent}${fieldPrefix}${nodeKind}`;

  // Check if this node is punctuation or comma-like that should join on same line
  if (node.kind() === "," || node.kind() === ";" || node.kind() === "{" || node.kind() === "}" || node.kind() === "(" || node.kind() === ")") {
    // For punctuation, don't add newline until after we process children
  } else {
    result += "\n";
  }

  // Simple field name detection based on common patterns
  const children = node.children();
  for (const child of children) {
    if (depth < maxDepth) {
      let childFieldName: string | undefined;
      const childKind = child.kind();

      // Basic field mappings for common cases
      if (node.kind() === "class_declaration" && childKind === "type_identifier") {
        childFieldName = "name";
      } else if (node.kind() === "class_declaration" && childKind === "class_body") {
        childFieldName = "body";
      } else if (node.kind() === "extends_clause" && (childKind === "identifier" || childKind === "type_identifier")) {
        childFieldName = "value";
      } else if ((node.kind() === "method_definition" || node.kind() === "function_declaration") && (childKind === "property_identifier" || childKind === "identifier")) {
        childFieldName = "name";
      } else if ((node.kind() === "method_definition" || node.kind() === "function_declaration") && childKind === "formal_parameters") {
        childFieldName = "parameters";
      } else if ((node.kind() === "method_definition" || node.kind() === "function_declaration") && childKind === "statement_block") {
        childFieldName = "body";
      }

      const childResult = printNodeTree(child, depth + 1, maxDepth, targetNode, childFieldName);

      // If current node is punctuation and child is not empty, append on same line
      if ((node.kind() === "," || node.kind() === ";" || node.kind() === "{" || node.kind() === "}" || node.kind() === "(" || node.kind() === ")") && childResult.trim()) {
        result += " " + childResult.trim();
      } else {
        result += childResult;
      }
    }
  }

  // Add final newline for punctuation nodes
  if (node.kind() === "," || node.kind() === ";" || node.kind() === "{" || node.kind() === "}" || node.kind() === "(" || node.kind() === ")") {
    result += "\n";
  }

  return result;
}

async function handleDebugNodeUnderCursor(
  source: string,
  language: SupportedLanguage,
  nodeInfo: NodeInfo | null,
): Promise<ModResult> {
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

  // Should find exactly one node with this exact range
  const targetNode = matchingNodes[0];

  if (targetNode) {
    // Walk up 3 parent levels to find the root for our tree
    let contextRoot = targetNode;
    for (let i = 0; i < 3; i++) {
      const parent = contextRoot.parent();
      if (parent && parent.kind() !== "source_file" && parent.kind() !== "program") {
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
