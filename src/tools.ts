// The four tools on Datacircle's open API, with no host's types: index.ts gives them to OpenCode 2 and OpenCode 1.

import { z } from 'zod';
import { ApiError, Client, brief, briefPlans, clamp, objects, slugify } from './client.js';
import type { Answer } from './client.js';

const LIST_APIS_ABOUT = "Lists the GTM APIs on Datacircle's sheet (https://datacircle.dev). GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use. Gives each API's slug, how many plans and providers it has and its best plan. Call it first to find an API's slug.";
const BEST_PLANS_ABOUT = "Gives an API's plans best first by their score out of 100 on Datacircle's benchmark (https://datacircle.dev), each with its rank, provider, plan, $ per 1,000 calls and its page. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const SEARCH_PLANS_ABOUT = "Searches every plan on Datacircle's sheet (https://datacircle.dev), or one API's, by provider or plan name, sorted by score, provider or price. Gives how many were found and up to limit of them. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const PROVIDER_ABOUT = "Gives each API one provider sells and its rank on each on Datacircle's benchmark (https://datacircle.dev), with its best plan there, its best rank first. A provider has no rank overall: each API ranks its own providers, 1 the best. total is how many APIs it sells, ranked on how many of them it has a rank.";

// Tells a model that sent a provider's name to an API's tool where a provider's plans are.
const FOR_PROVIDER = "A provider's plans: datacircle_search_plans with its name as query, like bright data, or datacircle_provider.";

// A number sent as a string is read as one, a fraction cut to its whole part. A limit or an offset below 1 takes its
// default. A null sent for an optional text, as many models send one, is the text left out.
const count = (description: string) => z.coerce.number().optional().describe(description);
const text = (description: string) => z.string().nullish().describe(description);

/** Each tool's input, as zod shapes: OpenCode 1 takes a shape as a tool's args, OpenCode 2 a z.object of it as its input. */
export const shapes = {
  list_apis: {
    query: text("Words of the API's name or slug, like email or linkedin profile: the APIs that hold the most of them come first. The sheet's order when left out"),
    limit: count('How many APIs to give, 1 to 200. 20 when left out: the sheet has about 150'),
  },
  best_plans: {
    slug: z.string().describe("The API's slug, like email-finder or linkedin-profile, as datacircle_list_apis gives it"),
    limit: count('How many plans to give, 1 to 50. 10 when left out'),
  },
  search_plans: {
    api: text("Only this API's plans: its name or slug, like email-finder. A provider's name goes in query, never here. Every API when left out"),
    query: text("Words that must all appear in the provider's or plan's name, like bright data"),
    sort: z.enum(['score', 'provider', 'price']).nullish().describe('score (best first, the default), provider (A to Z) or price ($ per 1,000, lowest first)'),
    limit: count('How many plans to give, 1 to 50. 10 when left out'),
    offset: count('How many found plans to skip first. 0 when left out'),
  },
  provider: {
    slug: z.string().describe("The provider's slug, like bright-data, or its name, like Bright Data: the name is made a slug"),
  },
} as const;

export type ListApisInput = { query?: string | null; limit?: number };
export type BestPlansInput = { slug: string; limit?: number };
export type SearchPlansInput = { api?: string | null; query?: string | null; sort?: 'score' | 'provider' | 'price' | null; limit?: number; offset?: number };
export type ProviderInput = { slug: string };

// OpenCode 1 checks the model's input with the shape but gives the tool the input as sent: a limit as "3", a null.
// Each run reads its input through these, so both hosts give it the same values.
const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);
const asCount = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** A limit the model sent, within the API's bounds, or undefined for the API's default. */
const bounded = (n: number | undefined, high: number) => (n === undefined || !(n >= 1) ? undefined : clamp(n, 1, high));

/** An answer of 4xx (an unknown slug, a wrong argument) is the tool's result as {error}, so that the model reads the API's words and can call again. */
function asResult(error: unknown): Answer {
  if (error instanceof ApiError) return { error: error.message };
  throw error;
}

async function listApisRun(client: Client, { query, limit }: ListApisInput, signal?: AbortSignal): Promise<Answer> {
  let apis: Answer[];
  try {
    apis = objects(await client.get<unknown>('/apis', {}, signal));
  } catch (error) {
    return asResult(error);
  }
  const words = (query ?? '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const found = apis
    .map((api, order) => {
      const name = `${String(api.api ?? '')} ${String(api.slug ?? '').replace(/-/g, ' ')}`.toLowerCase();
      return { order, matched: words.filter((word) => name.includes(word)).length, api };
    })
    .filter(({ matched }) => matched > 0 || words.length === 0)
    // The most words matched first, the sheet's order within each.
    .sort((a, b) => b.matched - a.matched || a.order - b.order);
  const answer: Answer = {
    total: found.length,
    apis: found.slice(0, bounded(limit, 200) ?? 20)
      .map(({ api }) => brief(api, ['api', 'slug', 'plans', 'providers', 'best', 'bestPage', 'sheetPage'])),
  };
  if (words.length > 0 && (found.length === 0 || found[0].matched < words.length)) {
    // A provider's name sent as an API's, like Bright Data, whose data matches many APIs: where its plans are.
    answer.note = `No API's name holds every word of ${JSON.stringify(query)}. A provider's plans: datacircle_search_plans with its name as query, or datacircle_provider.`;
  }
  return answer;
}

async function bestPlansRun(client: Client, { slug, limit }: BestPlansInput, signal?: AbortSignal): Promise<Answer> {
  const api = slugify(slug ?? '');
  if (api === '') return { error: `Give an API's slug, like email-finder: datacircle_list_apis gives every slug. ${FOR_PROVIDER}` };
  try {
    const answer = await client.get(`/apis/${api}/best`, { limit: bounded(limit, 50) }, signal);
    return { ...answer, plans: briefPlans(answer.plans) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // A provider's name sent as the API's slug: the API's words, and where a provider's plans are.
      return { error: `${error.message}. datacircle_list_apis gives every API's slug. ${FOR_PROVIDER}` };
    }
    return asResult(error);
  }
}

async function searchPlansRun(client: Client, input: SearchPlansInput, signal?: AbortSignal): Promise<Answer> {
  const search = (api: string, query: string) =>
    client.get('/plans', {
      api: api.trim(),
      query: query.trim(),
      sort: input.sort ?? undefined,
      limit: bounded(input.limit, 50),
      offset: input.offset === undefined || !(input.offset > 0) ? undefined : Math.trunc(input.offset),
    }, signal);
  let api = input.api ?? '';
  let query = input.query ?? '';
  const notes: string[] = [];
  try {
    let answer: Answer;
    try {
      answer = await search(api, query);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 400 && error.message.includes('api must be') && query.trim() === '')) throw error;
      // A provider's name sent as the API: the plans whose provider or plan name holds it.
      [api, query] = ['', api];
      answer = await search(api, query);
      notes.push(`No API is named ${JSON.stringify(input.api)}: these are the plans whose provider or plan name holds it.`);
    }
    if (answer.total === 0 && query.includes('-')) {
      // A slug sent as a name, like bright-data, which no name holds: its words, like bright data. A name with a
      // hyphen, like A-Leads, is found as it is first.
      const words = query.replace(/-/g, ' ').split(/\s+/).filter(Boolean).join(' ');
      try {
        answer = await search(api, words);
        notes.push(`No provider's or plan's name holds ${JSON.stringify(query)}: these are the plans whose name holds ${JSON.stringify(words)}.`);
      } catch {
        // The first answer stands.
      }
    }
    return { ...answer, plans: briefPlans(answer.plans), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  } catch (error) {
    return asResult(error);
  }
}

async function providerRun(client: Client, { slug }: ProviderInput, signal?: AbortSignal): Promise<Answer> {
  const provider = slugify(slug ?? '');
  if (provider === '') return { error: "Give a provider's slug or name, like bright-data or Bright Data" };
  let answer: Answer;
  try {
    answer = await client.get(`/providers/${provider}`, {}, signal);
  } catch (error) {
    return asResult(error);
  }
  const apis = objects(answer.apis).map((entry) => {
    const plans = objects(entry.plans);
    const kept: Answer = { ...brief(entry, ['api', 'slug', 'rank', 'bestPage']), plans: plans.length };
    const best = bestPlan(plans);
    if (best) kept.best = brief(best, ['plan', 'score', 'perThousand', 'page']);
    return kept;
  });
  // Its best rank first, the APIs where it has none last, in the API's order.
  const rank = (api: Answer) => (typeof api.rank === 'number' ? api.rank : Infinity);
  apis.sort((a, b) => rank(a) - rank(b));
  const ranked = apis.filter((api) => typeof api.rank === 'number');
  // A model asked where a provider ranks reads a count as a rank: the note says what the ranks are, before the list.
  const name = typeof answer.provider === 'string' ? answer.provider : provider;
  const best = ranked[0] ? ` Its best rank is ${ranked[0].rank} on ${String(ranked[0].api)}.` : '';
  const note = `${name} has a rank on each API it sells, not one rank overall: rank 1 is the best on that API. ` +
    `${name} sells ${apis.length} APIs on Datacircle and has a rank on ${ranked.length} of them.${best}`;
  const { apis: _apis, ...head } = answer;
  return { ...head, note, total: apis.length, ranked: ranked.length, apis };
}

/** A provider's best plan on an API: its lowest rank, the first when none has a rank. */
function bestPlan(plans: Answer[]): Answer | undefined {
  const ranked = plans.filter((plan) => typeof plan.rank === 'number');
  if (ranked.length === 0) return plans[0];
  return ranked.reduce((best, plan) => ((plan.rank as number) < (best.rank as number) ? plan : best));
}

/** One tool: its name within the datacircle namespace, what it does, its input's shape and its run on the raw input. */
export interface Def {
  readonly name: 'list_apis' | 'best_plans' | 'search_plans' | 'provider';
  readonly description: string;
  readonly shape: z.ZodRawShape;
  readonly run: (client: Client, input: unknown, signal?: AbortSignal) => Promise<Answer>;
}

/** The four tools, in this order. Their answers name each other datacircle_<name>, the name both hosts give them. */
export const defs: readonly Def[] = [
  {
    name: 'list_apis',
    description: LIST_APIS_ABOUT,
    shape: shapes.list_apis,
    run: (client, raw, signal) => {
      const input = asObject(raw);
      return listApisRun(client, { query: asText(input.query), limit: asCount(input.limit) }, signal);
    },
  },
  {
    name: 'best_plans',
    description: BEST_PLANS_ABOUT,
    shape: shapes.best_plans,
    run: (client, raw, signal) => {
      const input = asObject(raw);
      return bestPlansRun(client, { slug: asText(input.slug) ?? '', limit: asCount(input.limit) }, signal);
    },
  },
  {
    name: 'search_plans',
    description: SEARCH_PLANS_ABOUT,
    shape: shapes.search_plans,
    run: (client, raw, signal) => {
      const input = asObject(raw);
      const sort = asText(input.sort);
      return searchPlansRun(client, {
        api: asText(input.api),
        query: asText(input.query),
        // A sort the shape refuses never reaches here on OpenCode 2; on OpenCode 1 the API's own 400 answers it.
        sort: sort === undefined || sort === '' ? undefined : (sort as SearchPlansInput['sort']),
        limit: asCount(input.limit),
        offset: asCount(input.offset),
      }, signal);
    },
  },
  {
    name: 'provider',
    description: PROVIDER_ABOUT,
    shape: shapes.provider,
    run: (client, raw, signal) => providerRun(client, { slug: asText(asObject(raw).slug) ?? '' }, signal),
  },
];
