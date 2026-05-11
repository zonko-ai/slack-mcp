export function slackOauthSubjectId(input: {
  readonly teamId: string;
  readonly userId: string;
}): string {
  return `slack-${base64UrlEncodeUtf8(`${input.teamId}:${input.userId}`)}`;
}

function base64UrlEncodeUtf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
