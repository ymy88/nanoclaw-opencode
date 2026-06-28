// NanoClaw integration entry point.
// Re-exports the OpenCode internals that the NanoClaw agent-runner embeds.
// Paths updated for the post-v2 (Effect Context.Service) architecture.
//
// Actually consumed by the agent-runner today: bootstrap, AppRuntime, Session,
// SessionPrompt, z. The rest are re-exported for tooling/future use.
export { AppRuntime } from "./effect/app-runtime"
export { bootstrap } from "./cli/bootstrap"
export { SessionPrompt, type PromptInput } from "./session/prompt"
export { Session } from "./session/session"
// InstanceStore.provide(input, effect) runs an effect with InstanceRef provided —
// required by the new runtime when calling services from plain (non-Effect) async code.
export { InstanceStore } from "./project/instance-store"
export { MessageV2 } from "./session/message-v2"
export { Config } from "./config/config"
export { Plugin } from "./plugin"
export { ToolRegistry } from "./tool/registry"
export { Tool } from "./tool/tool"
export { Provider } from "./provider/provider"
export { Agent } from "./agent/agent"
export { default as z } from "zod"
