import { CopilotClient } from "@github/copilot-sdk";

export interface JudgeResponse {
  data: { content: string };
}

export interface ScopeJudgeSession {
  sendAndWait(request: { prompt: string }, timeout?: number): Promise<JudgeResponse | undefined>;
  disconnect(): Promise<void>;
}

export interface ScopeJudgeClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(config: Record<string, unknown>): Promise<ScopeJudgeSession>;
}

export type ScopeJudgeClientFactory = () => ScopeJudgeClient;

export const createCopilotJudgeClient: ScopeJudgeClientFactory = () =>
  new CopilotClient() as unknown as ScopeJudgeClient;

export async function withJudgeClient<T>(
  factory: ScopeJudgeClientFactory,
  callback: (client: ScopeJudgeClient) => Promise<T>,
): Promise<T> {
  const client = factory();
  await client.start();
  try {
    return await callback(client);
  } finally {
    await client.stop();
  }
}
