import { slackTools } from "./tool-catalog.js";

export function splitCsv(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function userScopesFromEnv(value: string | undefined): readonly string[] {
  const explicit = splitCsv(value);
  if (explicit.length > 0) {
    return explicit;
  }
  return Array.from(
    new Set(
      slackTools
        .filter((tool) => tool.annotations.token !== "admin" && tool.annotations.token !== "bot")
        .flatMap((tool) => tool.annotations.scopes)
        .filter(isRealOAuthScope)
    )
  ).sort();
}

export function botScopesFromEnv(value: string | undefined): readonly string[] {
  const explicit = splitCsv(value);
  if (explicit.length > 0) {
    return explicit;
  }
  return Array.from(
    new Set(
      slackTools
        .filter((tool) => tool.annotations.token === "bot")
        .flatMap((tool) => tool.annotations.scopes)
        .filter(isRealOAuthScope)
    )
  ).sort();
}

function isRealOAuthScope(scope: string): boolean {
  return scope.includes(":");
}
