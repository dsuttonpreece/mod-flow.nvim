import { Lang } from "@ast-grep/napi";

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