// The default export fits both hosts' own types: OpenCode 1's PluginModule and OpenCode 2's Plugin.define. OpenCode 1's
// args type is its own zod copy's (4.1.8, its version a literal type), so its check leaves args out: the host reads them
// by duck typing (`_zod`), run for real by tests/v1.
import type { Hooks, PluginModule } from '@opencode-ai/plugin';
import { Plugin } from '@opencode/plugin';
import plugin from '../src/index.js';

type V1ToolNoArgs = Omit<NonNullable<Hooks['tool']>[string], 'args'>;
export const v1: Omit<PluginModule, 'server'> & { server: () => Promise<{ tool: Record<string, V1ToolNoArgs> }> } = plugin;
export const v2 = Plugin.define(plugin);
