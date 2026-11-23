'use strict';
const { mkdirSync, readFileSync, writeFileSync, renameSync } = require('fs');
const { join } = require('path');

// Session status for the sidebar. Two layers, both shown as one badge per session:
//  - what a session says about itself: open questions, blocked, done (an end-of-turn "[status: ...]" line, or
//    the report/questions commands);
//  - a free-form "stage" any session can set on any other (status/stage), with one of three attention levels.
// CliDeck never interprets a stage's words, only its level, so the workflow vocabulary lives in the repo.

const LEVELS = ['you', 'waiting', 'active'];
const LEVEL_TEXT = { you: 'needs you', waiting: 'waiting on something else', active: 'in progress' };
const DEFAULT_ICON = { you: '❗', waiting: '⏳', active: '⚙' };
const BLOCKED_ICON = '⛔';
const MAX_LABEL = 60;
const MAX_QUESTIONS = 20;
const BADGE_LABEL = 32;
const BADGE_TITLE = 200;

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fit(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

function age(now, at) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The last "[status: questions=2 blocked=no done=no]" line in a final message. Separators are forgiving
// (spaces, commas, "·"); a bare "blocked" or "done" means yes. Returns null when there is no such line.
function parseStatusLine(text) {
  const matches = [...String(text ?? '').matchAll(/\[status:([^\]\n]*)\]/gi)];
  if (!matches.length) return null;
  const body = matches[matches.length - 1][1].replace(/\b(questions?|q)\s+(\d+)/gi, '$1=$2');
  const status = { questions: 0, blocked: false, done: false };
  for (const token of body.split(/[\s,;|·]+/)) {
    const match = /^([a-z]+)(?:[=:](.*))?$/i.exec(token);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = (match[2] ?? '').toLowerCase();
    if (key === 'questions' || key === 'question' || key === 'q') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) status.questions = Math.min(99, Math.max(0, n));
    } else if (key === 'blocked' || key === 'done') {
      status[key] = !['no', 'false', '0', 'n'].includes(value);
    }
  }
  return status;
}

// One badge per session, so the most attention-worthy thing wins the label and glyph; the tooltip has it all.
// blocked > stage that needs the user > open questions > stage waiting on others > done > stage in progress
function badgeFor(entry, now) {
  const status = entry?.status, stage = entry?.stage;
  const questions = status?.questions || 0, blocked = Boolean(status?.blocked), done = Boolean(status?.done);
  let kind = null;
  if (blocked) kind = 'blocked';
  else if (stage?.level === 'you') kind = 'stage';
  else if (questions > 0) kind = 'questions';
  else if (stage?.level === 'waiting') kind = 'stage';
  else if (done) kind = 'done';
  else if (stage) kind = 'stage';
  if (!kind) return null;

  const withQuestions = questions ? ` · ?${questions}` : '';
  let label, icon;
  if (kind === 'blocked') { label = `Blocked${withQuestions}`; icon = BLOCKED_ICON; }
  else if (kind === 'questions') { label = plural(questions, 'open question'); icon = questions > 9 ? '9+' : `?${questions}`; }
  else if (kind === 'done') { label = 'Done'; icon = '✓'; }
  else {
    const suffix = `${withQuestions}${done ? ' · done' : ''}`;
    label = fit(stage.label, BADGE_LABEL - [...suffix].length) + suffix;
    icon = stage.icon || DEFAULT_ICON[stage.level];
  }

  const parts = [];
  if (blocked) parts.push('Blocked: cannot continue until you answer.');
  if (questions) parts.push(`${plural(questions, 'open question')} (reported ${age(now, status.at)}).`);
  if (done) parts.push('Reports all assigned work finished or handed off.');
  if (stage) {
    const by = stage.by && stage.byName ? `set by ${stage.byName}` : 'set';
    parts.push(`Stage: ${stage.label} (${LEVEL_TEXT[stage.level]}; ${by} ${age(now, stage.at)}).`);
  }
  return { label: fit(label, BADGE_LABEL), icon, title: fit(parts.join(' '), BADGE_TITLE) };
}

// Flags may appear anywhere; `spec` maps a flag name to 'bool' or 'value'.
function parseFlags(args, spec) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--') { rest.push(...args.slice(i + 1).map(String)); break; }
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!match) { rest.push(arg); continue; }
    const [, name, inline] = match;
    if (!spec[name]) return { error: `Unknown option --${name}.` };
    if (spec[name] === 'bool') { flags[name] = inline === undefined || !['no', 'false', '0'].includes(inline); continue; }
    const value = inline !== undefined ? inline : args[++i];
    if (value === undefined) return { error: `--${name} needs a value.` };
    flags[name] = String(value);
  }
  return { flags, rest };
}

const idOf = (session) => session.sessionId || session.id;
const fail = (message) => ({ stderr: `${message}\n`, exitCode: 1 });
const ok = (lines) => ({ stdout: `${[].concat(lines).join('\n')}\n`, exitCode: 0 });

// A target is a session id, a unique id prefix, a name (the caller's project first), or @project/name.
function resolveTarget(value, sessions, projects, caller) {
  const target = String(value ?? '').trim();
  if (!target) return { error: 'Empty session name.' };
  const named = (list, name) => list.filter((s) => String(s.name || '').toLowerCase() === name.toLowerCase());
  const pick = (list, label) => (list.length === 1 ? { session: list[0] }
    : { error: `"${label}" matches ${list.length} sessions; use an id or @project/name (clideck agents --all).` });

  if (target.startsWith('@')) {
    const slash = target.indexOf('/');
    if (slash > 1 && slash < target.length - 1) {
      const projectName = target.slice(1, slash), name = target.slice(slash + 1);
      const project = projects.find((p) => p.id === projectName)
        || projects.find((p) => String(p.name || '').toLowerCase() === projectName.toLowerCase());
      if (!project) return { error: `No project "${projectName}".` };
      const list = named(sessions.filter((s) => s.projectId === project.id), name);
      return list.length ? pick(list, target) : { error: `No session "${name}" in project ${projectName}.` };
    }
    return { error: 'Cross-project targets look like @project/session.' };
  }
  const byId = sessions.find((s) => idOf(s) === target);
  if (byId) return { session: byId };
  if (caller) {
    const local = named(sessions.filter((s) => (caller.projectId ? s.projectId === caller.projectId : !s.projectId && s.cwd === caller.cwd)), target);
    if (local.length) return pick(local, target);
  }
  const all = named(sessions, target);
  if (all.length) return pick(all, target);
  if (target.length >= 6) {
    const prefix = sessions.filter((s) => idOf(s).startsWith(target));
    if (prefix.length) return pick(prefix, target);
  }
  return { error: `No session "${target}" (see clideck agents).` };
}

function normalizeEntry(raw) {
  const entry = {};
  const s = raw?.status;
  if (s && typeof s === 'object') {
    entry.status = {
      questions: Math.min(99, Math.max(0, Number.parseInt(s.questions, 10) || 0)),
      blocked: Boolean(s.blocked), done: Boolean(s.done), at: Number(s.at) || Date.now(),
    };
  }
  if (Array.isArray(raw?.questionList)) entry.questionList = raw.questionList.map((q) => clean(q)).filter(Boolean).slice(0, MAX_QUESTIONS);
  const g = raw?.stage;
  if (g && typeof g === 'object' && LEVELS.includes(g.level) && clean(g.label)) {
    entry.stage = {
      label: clean(g.label, MAX_LABEL), level: g.level, icon: clean(g.icon, 8),
      by: clean(g.by), byName: clean(g.byName, 80), at: Number(g.at) || Date.now(),
    };
  }
  return Object.keys(entry).length ? entry : null;
}

function createStatus(api, { now = Date.now } = {}) {
  const file = join(api.dataDir, 'state.json');
  const entries = new Map();   // sessionId -> { status?, questionList?, stage? }
  const shown = new Map();     // sessionId -> JSON of the badge last handed to CliDeck
  let saveTimer = null, ageTimer = null;

  function load() {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const [id, raw] of Object.entries(data?.sessions || {})) {
        const entry = normalizeEntry(raw);
        if (entry) entries.set(id, entry);
      }
    } catch { /* no saved state yet */ }
  }

  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      mkdirSync(api.dataDir, { recursive: true });
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }));
      renameSync(temp, file);
    } catch (error) { api.log('could not save state:', error.message); }
  }
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 250);
    saveTimer.unref?.();
  }

  const actionable = (entry) => Boolean(entry?.questionList?.length || entry?.stage || entry?.status?.blocked || entry?.status?.done || entry?.status?.questions);

  function publish(id, { actions = true } = {}) {
    const entry = entries.get(id);
    if (entry && !actionable(entry)) entries.delete(id);
    const badge = badgeFor(entries.get(id), now());
    const json = JSON.stringify(badge);
    if (shown.get(id) !== json) {
      shown.set(id, json);
      api.setSessionBadge(id, badge);
    }
    if (!badge) shown.delete(id);
    if (actions) api.refreshActions();
  }

  function touch(id, change) {
    const entry = entries.get(id) || {};
    change(entry);
    entries.set(id, entry);
    publish(id);
    save();
  }

  // ── events ──────────────────────────────────────────────────────────────────
  function onFinal(event) {
    const id = event.sessionId;
    const parsed = id && parseStatusLine(event.text);
    if (!parsed) return;   // no line: keep what we had
    touch(id, (entry) => {
      entry.status = { ...parsed, at: now() };
      // A recorded list that no longer matches the reported count is out of date.
      if (parsed.questions !== (entry.questionList?.length || 0)) delete entry.questionList;
    });
  }

  // A new prompt means the user answered (so not blocked) and there is new work (so not done). Open
  // questions stay until the agent restates them.
  function onUserTurn(event) {
    const id = event.sessionId, entry = id && entries.get(id);
    if (!entry?.status || !(entry.status.blocked || entry.status.done)) return;
    touch(id, (e) => { e.status = { ...e.status, blocked: false, done: false }; });
  }

  function forget(id) {
    entries.delete(id);
    publish(id);
    save();
  }

  async function onClosed(event) {
    const id = event.sessionId;
    if (!id || !entries.has(id) || await api.getSession(id).catch(() => null)) return;
    forget(id);
    shown.delete(id);
  }

  // ── commands ────────────────────────────────────────────────────────────────
  async function snapshot() {
    const [sessions, projects] = await Promise.all([api.getSessions().catch(() => []), api.getProjects().catch(() => [])]);
    return { sessions, projects };
  }

  const scopeOf = (sessions, callerId, all) => {
    const caller = sessions.find((s) => idOf(s) === callerId);
    if (all || !caller) return { caller, list: sessions };
    return { caller, list: sessions.filter((s) => (caller.projectId ? s.projectId === caller.projectId : !s.projectId && s.cwd === caller.cwd)) };
  };

  function report({ args, sessionId }) {
    const parsed = parseFlags(args, { questions: 'value', blocked: 'bool', done: 'bool' });
    if (parsed.error) return fail(parsed.error);
    if (parsed.rest.length) return fail('Usage: status/report [--questions N] [--blocked] [--done]');
    const n = parsed.flags.questions === undefined ? 0 : Number.parseInt(parsed.flags.questions, 10);
    if (!Number.isFinite(n) || n < 0) return fail('--questions needs a number.');
    const status = { questions: Math.min(99, n), blocked: Boolean(parsed.flags.blocked), done: Boolean(parsed.flags.done), at: now() };
    touch(sessionId, (entry) => {
      entry.status = status;
      if (status.questions !== (entry.questionList?.length || 0)) delete entry.questionList;
    });
    return ok(`Status: ${plural(status.questions, 'open question')}${status.blocked ? ', blocked' : ''}${status.done ? ', done' : ''}.`);
  }

  function questions({ args, sessionId }) {
    const parsed = parseFlags(args, { clear: 'bool' });
    if (parsed.error) return fail(parsed.error);
    const entry = entries.get(sessionId);
    if (!parsed.flags.clear && !parsed.rest.length) {
      const list = entry?.questionList || [];
      return ok(list.length ? list.map((q, i) => `${i + 1}. ${q}`) : 'No questions recorded.');
    }
    const list = parsed.flags.clear ? [] : parsed.rest.map((q) => clean(q)).filter(Boolean).slice(0, MAX_QUESTIONS);
    touch(sessionId, (e) => {
      e.questionList = list;
      e.status = { blocked: false, done: false, ...e.status, questions: list.length, at: now() };
    });
    return ok(list.length ? `Recorded ${plural(list.length, 'open question')}.` : 'Cleared your open questions.');
  }

  async function stage({ args, sessionId }) {
    const parsed = parseFlags(args, { you: 'bool', waiting: 'bool', active: 'bool', clear: 'bool', icon: 'value' });
    if (parsed.error) return fail(parsed.error);
    const { flags } = parsed;
    const levels = LEVELS.filter((level) => flags[level]);
    if (levels.length > 1) return fail('Choose one of --you, --waiting, --active.');
    let label = '', targets = parsed.rest;
    if (!flags.clear) {
      label = clean(parsed.rest[0], MAX_LABEL);
      targets = parsed.rest.slice(1);
      if (!label) return fail('Usage: status/stage "<label>" --you|--waiting|--active [--icon <emoji>] [<session> ...]  (or --clear)');
      if (!levels.length) return fail('Say who needs to act: --you (the user must do something), --waiting (waiting on something outside, such as CI or review) or --active (work in progress).');
    }
    const icon = clean(flags.icon, 8);
    if ([...icon].length > 2) return fail('--icon takes one emoji or one or two characters.');

    const { sessions, projects } = await snapshot();
    const caller = sessions.find((s) => idOf(s) === sessionId);
    const lines = [], errors = [];
    for (const name of targets.length ? targets : [sessionId]) {
      const found = targets.length ? resolveTarget(name, sessions, projects, caller) : { session: caller || { sessionId, name: '' } };
      if (found.error) { errors.push(found.error); continue; }
      const id = idOf(found.session), shownName = found.session.name || id.slice(0, 8);
      if (flags.clear) {
        touch(id, (entry) => { delete entry.stage; });
        lines.push(`Cleared the stage of ${shownName}.`);
      } else {
        touch(id, (entry) => {
          entry.stage = { label, level: levels[0], icon, by: sessionId, byName: caller?.name || '', at: now() };
        });
        lines.push(`${shownName}: ${label} (${LEVEL_TEXT[levels[0]]}).`);
      }
    }
    const result = ok(lines.length ? lines : ['Nothing changed.']);
    if (errors.length) { result.stderr = `${errors.join('\n')}\n`; result.exitCode = 1; }
    return result;
  }

  async function stages({ args, sessionId }) {
    const parsed = parseFlags(args, { all: 'bool', json: 'bool' });
    if (parsed.error) return fail(parsed.error);
    const { sessions } = await snapshot();
    const { list } = scopeOf(sessions, sessionId, parsed.flags.all);
    const inScope = new Set(list.map(idOf));
    const counts = new Map();
    for (const [id, entry] of entries) {
      if (!entry.stage || !inScope.has(id)) continue;
      const key = `${entry.stage.level}\u0000${entry.stage.label}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rows = [...counts].map(([key, count]) => {
      const [level, label] = key.split('\u0000');
      return { label, level, count };
    }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (parsed.flags.json) return ok(JSON.stringify(rows));
    return ok(rows.length ? rows.map((r) => `${r.label} (${r.level}) ×${r.count}`) : 'No stages in use yet.');
  }

  async function list({ args, sessionId }) {
    const parsed = parseFlags(args, { all: 'bool', json: 'bool' });
    if (parsed.error) return fail(parsed.error);
    const { sessions } = await snapshot();
    const t = now();
    const rows = scopeOf(sessions, sessionId, parsed.flags.all).list.map((session) => {
      const entry = entries.get(idOf(session)) || {};
      return {
        id: idOf(session), name: session.name || '', live: session.live !== false,
        questions: entry.status?.questions || 0, blocked: Boolean(entry.status?.blocked), done: Boolean(entry.status?.done),
        stage: entry.stage ? { label: entry.stage.label, level: entry.stage.level, by: entry.stage.byName || null, ageMs: t - entry.stage.at } : null,
      };
    });
    if (parsed.flags.json) return ok(JSON.stringify(rows));
    return ok(rows.map((r) => {
      const bits = [];
      if (r.stage) bits.push(`stage: ${r.stage.label} (${r.stage.level}, ${age(t, t - r.stage.ageMs)})`);
      if (r.blocked) bits.push('blocked');
      if (r.questions) bits.push(plural(r.questions, 'open question'));
      if (r.done) bits.push('done');
      return `${r.name || r.id.slice(0, 8)}${r.live ? '' : ' (stopped)'} — ${bits.join(' · ') || 'no status'}`;
    }));
  }

  // ── start ───────────────────────────────────────────────────────────────────
  async function start() {
    load();
    for (const id of [...entries.keys()]) {
      if (!(await api.getSession(id).catch(() => null))) entries.delete(id);
    }
    for (const id of entries.keys()) publish(id, { actions: false });
    api.refreshActions();
    save();
    // Tooltips carry ages, so refresh them now and then; unchanged badges are not sent again.
    ageTimer = setInterval(() => { for (const id of entries.keys()) publish(id, { actions: false }); }, 60000);
    ageTimer.unref?.();
  }

  function stop() {
    clearInterval(ageTimer);
    saveNow();
  }

  return { entries, start, stop, onFinal, onUserTurn, onClosed, publish, touch, forget, commands: { report, questions, stage, stages, list } };
}

async function activate(api) {
  if (typeof api.setSessionBadge !== 'function' || typeof api.registerAction !== 'function') {
    api.log('this CliDeck has no server-side badges (needs 2.4 or newer); the status plugin does nothing.');
    return;
  }
  const status = createStatus(api);
  for (const [name, handler] of Object.entries(status.commands)) api.registerCommand(name, handler);
  api.onEvent('agent.final', (event) => status.onFinal(event));
  api.onEvent('turn.user', (event) => status.onUserTurn(event));
  api.onEvent('session.closed', (event) => status.onClosed(event));
  api.onShutdown(() => status.stop());

  api.registerAction({
    id: 'questions', label: 'Show open questions', icon: '?', placements: ['session.menu'],
    description: 'The open questions this session recorded for you.',
    when: (context) => Boolean(status.entries.get(context.session.id)?.questionList?.length),
    run: (context) => {
      const list = status.entries.get(context.session.id)?.questionList || [];
      api.toast('info', { id: 'status-questions', title: `Open questions · ${context.session.name || 'session'}`, body: list.map((q, i) => `${i + 1}. ${q}`).join('\n') });
    },
  });
  api.registerAction({
    id: 'clear', label: 'Clear status and stage', icon: '✕', placements: ['session.menu'],
    description: 'Remove this session\'s status badge, for example when it is out of date.',
    when: (context) => status.entries.has(context.session.id),
    run: (context) => {
      status.forget(context.session.id);
      api.toast('success', { id: 'status-clear', body: 'Cleared.' });
    },
  });
  await status.start();
}

module.exports = { activate, createStatus, parseStatusLine, badgeFor, resolveTarget, parseFlags, age };
