// An OpenCode plugin on Datacircle's open API: find the best GTM APIs. The API needs no key: https://api.datacircle.dev/v1
// (its spec: https://api.datacircle.dev/v1/openapi.json). More at https://datacircle.dev
//
// One default export for both OpenCode 2, which calls setup() (Plugin.define's shape), and OpenCode 1 from 1.18.29,
// which calls server() (its object entrypoint): the shape OpenCode's migration guide gives a package for both.

import { z } from 'zod';
import { BASE_URL, Client, VERSION } from './client.js';
import type { Answer } from './client.js';
import { defs } from './tools.js';

export { BASE_URL, VERSION };
export type { Answer };

const NAMESPACE = {
  name: 'datacircle',
  description: "Datacircle's open API: every GTM API, who is best for each, every plan and where a provider ranks (https://datacircle.dev).",
};

// OpenCode 2 gives a tool's content to the model and its output to Code Mode scripts, as an object.
const output = z.record(z.string(), z.unknown());

/** What setup() uses of OpenCode 2's plugin context: its tool domain. */
export interface SetupContext {
  readonly tool: {
    readonly transform: (callback: (editor: ToolEditor) => void) => Promise<unknown>;
  };
}

/** What setup() uses of OpenCode 2's tool editor. */
export interface ToolEditor {
  namespace(namespace: { name: string; description: string }): void;
  add(tool: {
    name: string;
    description: string;
    input: z.ZodType;
    output: z.ZodType;
    options: { namespace: string };
    execute: (input: unknown, context: { readonly signal?: AbortSignal }) => Promise<{ output: Answer; content: string }>;
  }): void;
}

/** One tool as OpenCode 1 takes it from server(): its args a zod shape, its result text. */
export interface V1Tool {
  description: string;
  args: z.ZodRawShape;
  execute(args: any, context: { readonly abort?: AbortSignal }): Promise<string>;
}

export interface DatacirclePlugin {
  readonly id: 'datacircle';
  /** OpenCode 2: registers the four tools in the datacircle namespace. */
  setup(context: SetupContext): Promise<void>;
  /** OpenCode 1: gives the four tools as its tool map. */
  server(): Promise<{ tool: Record<string, V1Tool> }>;
}

const plugin: DatacirclePlugin = {
  id: 'datacircle',

  async setup(ctx) {
    const client = new Client();
    await ctx.tool.transform((editor) => {
      editor.namespace(NAMESPACE);
      for (const def of defs) {
        editor.add({
          name: def.name,
          description: def.description,
          input: z.object(def.shape),
          output,
          options: { namespace: NAMESPACE.name },
          execute: async (input, context) => {
            const answer = await def.run(client, input, context.signal);
            return { output: answer, content: JSON.stringify(answer) };
          },
        });
      }
    });
  },

  async server() {
    const client = new Client();
    const tool: Record<string, V1Tool> = {};
    for (const def of defs) {
      tool[`${NAMESPACE.name}_${def.name}`] = {
        description: def.description,
        args: def.shape,
        execute: async (args, context) => JSON.stringify(await def.run(client, args, context?.abort)),
      };
    }
    return { tool };
  },
};

export default plugin;
