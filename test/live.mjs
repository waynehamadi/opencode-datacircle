// Each tool of @datacircle/opencode on the live API, as each host registers it: setup() into a recording tool editor
// (OpenCode 2), server()'s tool map (OpenCode 1). argv[2]: a folder whose node_modules has the package.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(dir, 'x.js'));
const entry = require.resolve('@datacircle/opencode');
const { default: plugin } = await import(pathToFileURL(entry).href);
const { z } = await import(pathToFileURL(require.resolve('zod')).href);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failed++;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenCode 2: what setup() registers.
const added = [];
let namespace;
await plugin.setup({ tool: { transform: async (cb) => cb({ namespace: (n) => (namespace = n), add: (t) => added.push(t) }) } });
check('v2 id', plugin.id === 'datacircle');
check('v2 namespace', namespace?.name === 'datacircle', JSON.stringify(namespace));
check('v2 four tools', added.map((t) => t.name).join(',') === 'list_apis,best_plans,search_plans,provider', added.map((t) => t.name).join(','));
check('v2 options', added.every((t) => t.options?.namespace === 'datacircle'));
const v2 = Object.fromEntries(added.map((t) => [t.name, t]));
// OpenCode 2 checks and decodes the input with the tool's standard schema, then runs execute on the decoded value.
const run2 = async (name, input) => {
  const t = v2[name];
  const parsed = await t.input['~standard'].validate(input);
  if (parsed.issues) return { refused: parsed.issues.map((i) => i.message).join('; ') };
  const result = await t.execute(parsed.value, { signal: AbortSignal.timeout(90_000) });
  const out = await t.output['~standard'].validate(result.output);
  check(`v2 ${name} output fits its schema`, !out.issues);
  check(`v2 ${name} content is its output`, result.content === JSON.stringify(result.output));
  return result.output;
};

// OpenCode 1: server()'s map, its args a zod shape the host wraps in z.object and checks, the input given as sent.
const { tool: v1 } = await plugin.server();
check('v1 four tools', Object.keys(v1).join(',') === 'datacircle_list_apis,datacircle_best_plans,datacircle_search_plans,datacircle_provider', Object.keys(v1).join(','));
const run1 = async (name, input) => {
  const t = v1[`datacircle_${name}`];
  const ok = z.object(t.args).safeParse(input);
  if (!ok.success) return { refused: ok.error.issues.map((i) => i.message).join('; ') };
  const text = await t.execute(input, { abort: AbortSignal.timeout(90_000) });
  check(`v1 ${name} gives text`, typeof text === 'string');
  return JSON.parse(text);
};

for (const [host, run] of [['v2', run2], ['v1', run1]]) {
  let a = await run('list_apis', {});
  check(`${host} list_apis all`, a.total > 100 && a.apis.length === 20 && a.apis[0].slug, `total ${a.total}`);
  a = await run('list_apis', { query: 'email', limit: '3' });
  check(`${host} list_apis email, limit as a string`, a.apis.length === 3 && a.apis.every((x) => /email/.test(x.slug)), a.apis.map((x) => x.slug).join(','));
  a = await run('list_apis', { query: 'Bright Data', limit: null === undefined ? 1 : 2 });
  check(`${host} list_apis provider name gets a note`, typeof a.note === 'string', a.note);
  a = await run('list_apis', { query: null });
  check(`${host} list_apis null query`, a.apis?.length === 20);

  let b = await run('best_plans', { slug: 'email-finder', limit: 3 });
  check(`${host} best_plans email-finder`, b.plans?.length === 3 && b.plans[0].rank === 1 && b.plans[0].page, JSON.stringify(b.plans?.[0]).slice(0, 160));
  b = await run('best_plans', { slug: 'Email Finder', limit: 2.7 });
  check(`${host} best_plans name as slug, fraction`, b.plans?.length === 2, JSON.stringify(b).slice(0, 120));
  b = await run('best_plans', { slug: 'bright-data' });
  check(`${host} best_plans provider as API: error with a way out`, typeof b.error === 'string' && b.error.includes('datacircle_search_plans'), b.error);
  b = await run('best_plans', { slug: '' });
  check(`${host} best_plans empty slug`, typeof b.error === 'string', b.error);
  b = await run('best_plans', {});
  check(`${host} best_plans slug left out refused`, typeof b.refused === 'string', b.refused);

  await pause(15_000); // the API takes 60 calls a minute from one address

  let s = await run('search_plans', { api: 'email-finder', sort: 'price', limit: 3 });
  check(`${host} search_plans by price`, s.plans?.length === 3 && s.total > 3, `total ${s.total}`);
  s = await run('search_plans', { query: 'bright-data', limit: 2 });
  check(`${host} search_plans slug as a name`, s.total > 0 && /bright/i.test(s.plans[0].provider) && s.note, s.note);
  s = await run('search_plans', { api: 'Bright Data' });
  check(`${host} search_plans provider as api`, s.total > 0 && s.note, s.note);
  s = await run('search_plans', { api: null, query: null, sort: null, limit: '2', offset: '1' });
  check(`${host} search_plans nulls, counts as strings`, s.plans?.length === 2, `total ${s.total}`);
  s = await run('search_plans', { sort: 'cheapest' });
  check(`${host} search_plans bad sort refused`, typeof s.refused === 'string', s.refused);

  let p = await run('provider', { slug: 'Bright Data' });
  check(`${host} provider by name`, p.total > 0 && Array.isArray(p.apis) && p.apis[0].plans >= 1, `total ${p.total} ranked ${p.ranked}`);
  check(`${host} provider note says no rank overall`, typeof p.note === 'string' && p.note.includes('not one rank overall') && p.note.includes(`best rank is ${p.apis[0].rank}`), p.note);
  p = await run('provider', { slug: 'no-such-provider-xyz' });
  check(`${host} provider unknown`, typeof p.error === 'string', p.error);
  p = await run('provider', { slug: 7 });
  check(`${host} provider slug not a string refused`, typeof p.refused === 'string', p.refused);

  await pause(20_000);
}

// The network down: the tool throws, which each host gives the model as the call's error.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
try {
  await v2.list_apis.execute({}, { signal: AbortSignal.timeout(5000) });
  check('v2 network down throws', false);
} catch (e) {
  check('v2 network down throws', /datacircle: fetch failed/.test(e.message), e.message);
}
try {
  await v1.datacircle_list_apis.execute({}, {});
  check('v1 network down throws', false);
} catch (e) {
  check('v1 network down throws', /datacircle: fetch failed/.test(e.message), e.message);
}
globalThis.fetch = realFetch;

// Stopped by the user: the abort reaches the call.
const controller = new AbortController();
controller.abort(new Error('stopped'));
try {
  await v2.best_plans.execute({ slug: 'email-finder' }, { signal: controller.signal });
  check('v2 aborted call stops', false);
} catch (e) {
  check('v2 aborted call stops', true, e.message);
}

console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
