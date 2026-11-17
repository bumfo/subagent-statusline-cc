/** The command's output: an agent's id to the text drawn as its row's body. */
export type Decorations = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'subagent-statusline': { decorations: Decorations }
  }
}
