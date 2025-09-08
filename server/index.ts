import { kind, Lang, parse, type SgNode } from "@ast-grep/napi";
import { attach } from "neovim";

type Cursor = {
  line: number;
  column: number;
};

type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "typescriptreact"
  | "javascriptreact";

type HandlerResult = {
  found: boolean;
  transformation?: string;
  target_range?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  cursor?: Cursor;
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

function handleFindClosestFunction(
  source: string,
  language: SupportedLanguage,
  cursor: Cursor,
): HandlerResult {
  const ast = parse(getAstGrepLang(language), source);
  const root = ast.root();
  const lang = getAstGrepLang(language);

  const functionDeclarations = root.findAll(kind(lang, "function_declaration"));

  const closestFunction = findClosestNodeAtCursor(functionDeclarations, cursor);

  if (closestFunction) {
    const range = closestFunction.range();
    return {
      found: true,
      transformation: closestFunction.text(),
      target_range: {
        start: { line: range.start.line, column: range.start.column },
        end: { line: range.end.line, column: range.end.column },
      },
      cursor: cursor,
    };
  } else {
    return {
      found: false,
      cursor: cursor,
    };
  }
}

function getHandler(
  method: string,
):
  | ((
      source: string,
      language: SupportedLanguage,
      cursor: Cursor,
    ) => HandlerResult)
  | null {
  switch (method) {
    case "find_closest_function":
      return handleFindClosestFunction;
    default:
      return null;
  }
}

function getAstGrepLang(language: SupportedLanguage): Lang {
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
      const handler = getHandler(method);
      if (handler) {
        const result = handler(source, language, cursor);
        await nvim.lua("require('mod-flow').handle_response(...)", [requestId, result]);
      }
    } catch (error) {
      nvim.logger.error(`Error: ${error}`);
    }
  });
}

main().catch((err) => {
  console.error(err);
});
