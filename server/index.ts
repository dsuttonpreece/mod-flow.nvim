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
    const cursor: Cursor = { line: cursorRaw[0] - 1, column: cursorRaw[1] };
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
