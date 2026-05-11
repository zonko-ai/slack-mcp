import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SlackTokenType = "user" | "bot" | "admin";

export type SlackInstallationInput = {
  readonly teamId: string;
  readonly teamName: string | null;
  readonly enterpriseId: string | null;
  readonly userId: string;
  readonly accessToken: string;
  readonly botAccessToken?: string | undefined;
  readonly scope: string;
  readonly botScope?: string | undefined;
  readonly tokenType: SlackTokenType;
};

export type SlackInstallation = SlackInstallationInput & {
  readonly connectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SlackInstallationSummary = Omit<
  SlackInstallation,
  "accessToken" | "botAccessToken" | "createdAt" | "updatedAt" | "enterpriseId" | "botScope"
>;

export interface TokenStore {
  save(installation: SlackInstallationInput): Promise<SlackInstallation>;
  get(connectionId: string): Promise<SlackInstallation | null>;
  getDefault(): Promise<SlackInstallation | null>;
  listSummaries(): Promise<readonly SlackInstallationSummary[]>;
}

type StoreFile = {
  readonly installations: readonly SlackInstallation[];
};

export class FileTokenStore implements TokenStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async save(input: SlackInstallationInput): Promise<SlackInstallation> {
    const now = new Date().toISOString();
    const file = await this.readStore();
    const connectionId = `${input.teamId}:${input.userId}`;
    const existing = file.installations.find((installation) => installation.connectionId === connectionId);
    const next: SlackInstallation = {
      ...input,
      connectionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const installations = [
      ...file.installations.filter((installation) => installation.connectionId !== connectionId),
      next
    ];
    await this.writeStore({ installations });
    return next;
  }

  async get(connectionId: string): Promise<SlackInstallation | null> {
    const file = await this.readStore();
    return file.installations.find((installation) => installation.connectionId === connectionId) ?? null;
  }

  async getDefault(): Promise<SlackInstallation | null> {
    const file = await this.readStore();
    if (file.installations.length === 0) {
      return null;
    }
    if (file.installations.length === 1) {
      return file.installations[0] ?? null;
    }
    const sorted = [...file.installations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return sorted[0] ?? null;
  }

  async listSummaries(): Promise<readonly SlackInstallationSummary[]> {
    const file = await this.readStore();
    return file.installations.map((installation) => ({
      connectionId: installation.connectionId,
      teamId: installation.teamId,
      teamName: installation.teamName,
      userId: installation.userId,
      tokenType: installation.tokenType,
      scope: installation.scope
    }));
  }

  private async readStore(): Promise<StoreFile> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as Partial<StoreFile>;
      return { installations: Array.isArray(parsed.installations) ? parsed.installations : [] };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { installations: [] };
      }
      throw error;
    }
  }

  private async writeStore(file: StoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.path);
    await chmod(this.path, 0o600);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
