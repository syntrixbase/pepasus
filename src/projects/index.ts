/**
 * Project system — long-lived task spaces with independent Agent instances.
 */
export { parseProjectFile, scanProjectDir } from "./loader.ts";
export { ProjectManager } from "./manager.ts";
export { ProxyLanguageModel } from "./proxy-language-model.ts";
export type { CreateProjectOptions } from "./manager.ts";
export type { LLMProxyRequest } from "./proxy-language-model.ts";
export type { ProjectDefinition, ProjectStatus } from "./types.ts";
