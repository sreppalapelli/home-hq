// The assistant: a prompt from a frame or phone becomes model calls plus tool calls against the
// household's own data (calendar, shopping, notes). Free by default: Workers AI first, then
// OpenRouter models that cost nothing. Anything that removes data is staged as an approval and
// only runs when a person taps Approve (see decideApproval).

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_TIMEOUT_MS = 25e3;

// Only $0 OpenRouter models may be called, so an account with credits can never be charged.
export function freeOpenRouterModel(id) {
  return typeof id === 'string' && (id === 'openrouter/free' || /:free$/.test(id));
}

// ------------------------------------------------------------------ local time
// The model reads and writes wall-clock times in the family time zone ("2026-11-24T15:30").
function tzOffsetMs(tz, ms) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
export function localToMs(tz, s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return guess - tzOffsetMs(tz, guess - tzOffsetMs(tz, guess));
}
function msToLocal(tz, ms) {
  return new Date(ms + tzOffsetMs(tz, ms)).toISOString().slice(0, 16);
}

// ------------------------------------------------------------------ tools
function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required: required || [] } } };
}
const TOOLS = [
  fn('calendar_list_events', 'List calendar events from now for a number of days.', {
    days: { type: 'integer', description: '1 to 14, default 7' },
    person: { type: 'string', description: 'person id to filter by; omit for everyone' },
  }),
  fn('calendar_add_event', 'Add an event to the family calendar.', {
    title: { type: 'string' },
    start: { type: 'string', description: 'local time YYYY-MM-DDTHH:MM' },
    end: { type: 'string', description: 'local time YYYY-MM-DDTHH:MM, after start' },
    people: { type: 'array', items: { type: 'string' }, description: 'person ids' },
  }, ['title', 'start', 'end', 'people']),
  fn('calendar_delete_event', 'Ask to delete an event added on the dashboard (needs a person to approve).', {
    event_id: { type: 'string' },
  }, ['event_id']),
  fn('shopping_list', 'Show the shopping list.', {}),
  fn('shopping_manage', 'Add items to, tick off, or remove items from the shopping list.', {
    action: { type: 'string', enum: ['add', 'check', 'remove'] },
    items: { type: 'array', items: { type: 'string' }, description: 'item names, e.g. ["milk", "2 bananas"]' },
  }, ['action', 'items']),
  fn('notes_post', 'Post a sticky note on the frames.', {
    text: { type: 'string', description: 'max 140 characters' },
    to: { type: 'string', description: 'person id, or "all"' },
  }, ['text']),
];

// Models sometimes pass a name ("Sam") where an id ("sam") is expected.
function personId(h, v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'all' || s === 'everyone') return 'all';
  const p = h.CFG.people.find((x) => x.id.toLowerCase() === s || x.name.toLowerCase() === s);
  return p ? p.id : null;
}

// h: functions and settings from index.js, passed in so this file has no circular import.
async function runTool(env, h, name, args, ctx) {
  const tz = h.CFG.tz;
  if (args.person) args.person = personId(h, args.person) || args.person;
  if (name === 'calendar_list_events') {
    const days = Math.max(1, Math.min(14, parseInt(args.days, 10) || 7));
    const from = Date.now(), to = from + days * 864e5;
    const cal = await h.getCalendar(env);
    return cal.events
      .filter((e) => Date.parse(e.end) > from && Date.parse(e.start) < to)
      .filter((e) => !args.person || (e.people || []).indexOf(args.person) >= 0 || (e.people || []).indexOf('all') >= 0)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, 40)
      .map((e) => ({ id: e.local ? e.id : undefined, title: e.title, people: e.people, start: msToLocal(tz, Date.parse(e.start)), end: msToLocal(tz, Date.parse(e.end)), allDay: e.allDay || undefined }));
  }
  if (name === 'calendar_add_event') {
    const people = [].concat(args.people || []).map((x) => personId(h, x)).filter((x) => x && x !== 'all');
    const res = await h.addEvent(env, { id: h.uid(), title: args.title, start: localToMs(tz, args.start), end: localToMs(tz, args.end), people: people.length ? people : [ctx.from] });
    const out = await res.json();
    if (out.ok) ctx.actions.push('Added "' + args.title + '" on ' + args.start.replace('T', ' '));
    return out;
  }
  if (name === 'calendar_delete_event') {
    const ev = await env.DB.prepare('SELECT id, title, start FROM events WHERE id = ?').bind(String(args.event_id || '')).first();
    if (!ev) return { error: 'Only events added on the dashboard can be deleted, and no such event exists.' };
    const summary = 'Delete "' + ev.title + '" (' + msToLocal(tz, ev.start).replace('T', ' ') + ')';
    ctx.approvals.push(await stageApproval(env, ctx.runId, 'calendar_delete', { id: ev.id }, summary));
    return { staged: true, note: 'Waiting for a person to approve on the dashboard.' };
  }
  if (name === 'shopping_list') {
    const rows = await env.DB.prepare('SELECT name, qty, done FROM groceries WHERE cleared = 0 ORDER BY updated_at').all();
    return rows.results.map((g) => (g.qty > 1 ? g.qty + ' × ' : '') + g.name + (g.done ? ' (got it)' : ''));
  }
  if (name === 'shopping_manage') {
    const items = (Array.isArray(args.items) ? args.items : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
    const done = [];
    for (const raw of items) {
      const m = /^(\d{1,2})\s*(?:x|×)?\s+(.+)$/i.exec(raw);
      const qty = m ? +m[1] : 1, label = (m ? m[2] : raw).slice(0, 80);
      const row = await env.DB.prepare('SELECT id, name, cat, qty, store, note FROM groceries WHERE cleared = 0 AND lower(name) = lower(?)').bind(label).first();
      if (args.action === 'add') {
        const hit = h.CFG.catalog.find((c) => c[0].toLowerCase() === label.toLowerCase());
        await h.putGrocery(env, row ? Object.assign(row, { qty: row.qty + qty, done: false })
          : { id: h.uid(), name: hit ? hit[0] : label.charAt(0).toUpperCase() + label.slice(1), cat: hit ? hit[1] : 'Other', qty, store: h.CFG.stores[0].id });
        done.push(label);
      } else if (row && args.action === 'check') {
        await h.putGrocery(env, Object.assign(row, { done: true }));
        done.push(label);
      } else if (row && args.action === 'remove') {
        await env.DB.prepare('UPDATE groceries SET cleared = 1, updated_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
        done.push(label);
      }
    }
    if (done.length) ctx.actions.push({ add: 'Added', check: 'Ticked off', remove: 'Removed' }[args.action] + ': ' + done.join(', '));
    return { done, notFound: items.filter((i) => done.indexOf(i) < 0 && !done.some((d) => i.endsWith(d))) };
  }
  if (name === 'notes_post') {
    const res = await h.putNote(env, { id: h.uid(), text: args.text, from: ctx.from, to: personId(h, args.to) || 'all' });
    const out = await res.json();
    if (out.ok) ctx.actions.push('Posted a note: "' + String(args.text).slice(0, 60) + '"');
    return out.ok ? { ok: true } : out;
  }
  return { error: 'unknown tool ' + name };
}

// ------------------------------------------------------------------ approvals
async function stageApproval(env, runId, kind, payload, summary) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.DB.prepare('INSERT INTO approvals (id, at, run_id, kind, payload, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, Date.now(), runId, kind, JSON.stringify(payload), summary, 'pending').run();
  return { id, kind, summary };
}
export async function listApprovals(env) {
  const rows = await env.DB.prepare("SELECT id, at, kind, summary FROM approvals WHERE status = 'pending' AND at > ? ORDER BY at").bind(Date.now() - 7 * 864e5).all();
  return rows.results;
}
export async function decideApproval(env, h, id, decision) {
  const a = await env.DB.prepare("SELECT id, kind, payload FROM approvals WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!a) return { error: 'not pending', status: 404 };
  if (decision === 'approve') {
    const p = JSON.parse(a.payload);
    if (a.kind === 'calendar_delete') {
      const res = await h.deleteEvent(env, p.id);
      if (!res.ok) return { error: (await res.json()).error || 'failed', status: res.status };
    } else return { error: 'unknown approval kind', status: 400 };
  }
  await env.DB.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').bind(decision === 'approve' ? 'approved' : 'cancelled', Date.now(), id).run();
  return { ok: true };
}

// ------------------------------------------------------------------ models
async function callWorkersAi(env, A, messages) {
  if (!env.AI) throw new Error('no AI binding');
  const r = await env.AI.run(A.workersAiModel, { messages, tools: TOOLS, max_tokens: 700 });
  const msg = r && r.choices && r.choices[0] && r.choices[0].message;
  if (!msg) throw new Error('Workers AI returned no message');
  return { message: msg, model: A.workersAiModel };
}
async function callOpenRouter(env, A, messages) {
  if (!env.OPENROUTER_API_KEY) throw new Error('no OPENROUTER_API_KEY');
  const models = A.openrouterModels.filter(freeOpenRouterModel);
  if (!models.length) throw new Error('no free OpenRouter models configured');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.OPENROUTER_API_KEY, 'content-type': 'application/json', 'x-title': 'Home HQ' },
    // data_collection "deny": only providers that don't store or train on prompts serve it.
    body: JSON.stringify({ models, messages, tools: TOOLS, max_tokens: 700, provider: { data_collection: 'deny' } }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('OpenRouter ' + res.status + ': ' + ((out.error && out.error.message) || ''));
  const msg = out.choices && out.choices[0] && out.choices[0].message;
  if (!msg) throw new Error('OpenRouter returned no message');
  if (!freeOpenRouterModel(out.model)) console.warn('OpenRouter answered with', out.model);
  return { message: msg, model: out.model || models[0] };
}
const PROVIDERS = { 'workers-ai': callWorkersAi, openrouter: callOpenRouter };

function systemPrompt(h, from) {
  const tz = h.CFG.tz, now = Date.now();
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
  const day = wd.format(new Date(now));
  // Models miscount weekdays ("Saturday" became a Wednesday), so spell out the next two weeks.
  const dates = [];
  for (let i = 0; i < 14; i++) dates.push(wd.format(new Date(now + i * 864e5)) + ' ' + msToLocal(tz, now + i * 864e5).slice(0, 10));
  return 'You are the assistant on a family wall dashboard. Be brief: one or two short sentences, no markdown. ' +
    'Use the tools to read or change the calendar, shopping list and notes; never invent events or items. ' +
    'Never say something was added, changed or deleted unless a tool call in this conversation did it; if a tool returns an error, say it failed. ' +
    'Deleting an event only stages it for approval: say it is waiting for approval. ' +
    'Now: ' + day + ' ' + msToLocal(tz, now).replace('T', ' ') + ' (' + tz + '). ' +
    'Dates: today ' + dates.join(', ') + '. A weekday name means the next one in this list. ' +
    'People (id: name): ' + h.CFG.people.map((p) => p.id + ': ' + p.name).join(', ') + '. The person asking is ' + from + '.';
}

// ------------------------------------------------------------------ the loop
export async function runAgent(env, h, prompt, from, only) {
  const A = h.CFG.agent, t0 = Date.now();
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const ctx = { runId, from, actions: [], approvals: [], tools: [] };
  const order = only && PROVIDERS[only] ? [only] : A.order.filter((p) => PROVIDERS[p]);
  const errors = [];
  let reply = null, used = null, model = null;
  for (const provider of order) {
    const messages = [{ role: 'system', content: systemPrompt(h, from) }, { role: 'user', content: prompt }];
    try {
      for (let round = 0; round <= A.maxToolRounds; round++) {
        const r = await PROVIDERS[provider](env, A, messages);
        model = r.model;
        const calls = r.message.tool_calls || [];
        if (!calls.length || round === A.maxToolRounds) { reply = (r.message.content || '').trim(); break; }
        messages.push({ role: 'assistant', content: r.message.content || '', tool_calls: calls });
        for (const c of calls) {
          let args = c.function.arguments;
          try { if (typeof args === 'string') args = JSON.parse(args || '{}'); } catch (e) { args = {}; }
          let result;
          try { result = await runTool(env, h, c.function.name, args || {}, ctx); } catch (err) { result = { error: String(err.message || err) }; }
          ctx.tools.push(c.function.name + (result && result.error ? ' ✗ ' + String(result.error).slice(0, 120) + ' ' + JSON.stringify(args).slice(0, 200) : ''));
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 4000) });
        }
      }
      used = provider;
      break;
    } catch (err) {
      errors.push(provider + ': ' + String(err.message || err));
      // A provider that failed after a tool already ran must not run it again on the next one.
      if (ctx.tools.length) break;
    }
  }
  const ms = Date.now() - t0;
  if (!reply && ctx.actions.length) reply = ctx.actions.join('. ') + '.';
  await env.DB.prepare('INSERT INTO agent_runs (id, at, from_id, prompt, provider, model, ms, tools, reply, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(runId, t0, from, prompt.slice(0, 500), used, model, ms, JSON.stringify(ctx.tools), reply, errors.join(' | ') || null).run();
  return { id: runId, reply: reply || 'Sorry, the assistant is not available right now.', ok: !!used, provider: used, model, ms,
    tools: ctx.tools, actions: ctx.actions, approvals: ctx.approvals, errors };
}
