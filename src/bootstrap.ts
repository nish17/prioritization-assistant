import type { Config } from "./config.js";

export interface AppDeps {
  config: Config;
  close(): Promise<void>;
}

export async function bootstrap(config: Config): Promise<AppDeps> {
  return {
    config,
    async close() {},
  };
}
