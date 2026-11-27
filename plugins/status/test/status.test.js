'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createStatus, parseStatusLine, badgeFor, resolveTarget, parseFlags } = require('../server');

const SESSIONS = [
  { sessionId: 'aaaaaaaa-1', name: 'Coordinator', cwd: '/w/a', projectId: 'p1', live: true },
  { sessionId: 'bbbbbbbb-2', name: 'TICKET-1', cwd: '/w/a', projectId: 'p1', live: true },
  { sessionId: 'cccccccc-3', name: 'TICKET-2', cwd: '/w/a', projectId: 'p1', live: false },
  { sessionId: 'dddddddd-4', name: 'TICKET-1', cwd: '/w/b', projectId: 'p2', live: true },
  { sessionId: 'eeeeeeee-5', name: 'Other', cwd: '/w/c', projectId: 'p2', live: true },
];
const PROJECTS = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }];

function fakeApi(dataDir, sessions = SESSIONS) {
  const badges = new Map();
  return {
    dataDir, badges, logs: [], refreshed: 0,
    log(...v) { this.logs.push(v.join(' ')); },
    setSessionBadge(id, badge) { if (badge) badges.set(id, badge); else badges.delete(id); },
    refreshActions() { this.refreshed++; },
    getSessions: async () => sessions,
    getSession: async (id) => sessions.find((s) => s.sessionId === id) || null,
    getProjects: async () => PROJECTS,
  };
}

function setup(t, options) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = fakeApi(dir, options?.sessions);
  let clock = 1_000_000;
  const status = createStatus(api, { now: () => clock });
  t.after(() => status.stop());
  return { dir, api, status, tick: (ms) => { clock += ms; }, cmd: (name, args, sessionId = 'aaaaaaaa-1') => status.commands[name]({ args, stdin: '', sessionId }) };
}

test('the status line is parsed forgivingly, taking the last one', () => {
  assert.equal(parseStatusLine('no line here'), null);
  assert.deepEqual(parseStatusLine('done.\n[status: questions=2 blocked=no done=no]'), { questions: 2, blocked: false, done: false });
  assert.deepEqual(parseStatusLine('[status: questions 3 · blocked · done]'), { questions: 3, blocked: true, done: true });
  assert.deepEqual(parseStatusLine('[STATUS: q=1, blocked=yes]'), { questions: 1, blocked: true, done: false });
  assert.deepEqual(parseStatusLine('[status: questions=5] then later [status: questions=0 done=yes]'), { questions: 0, blocked: false, done: true });
  assert.deepEqual(parseStatusLine('[status: questions=500]'), { questions: 99, blocked: false, done: false });
  assert.deepEqual(parseStatusLine('[status: done=false blocked=0]'), { questions: 0, blocked: false, done: false });
});

test('the badge shows the most attention-worthy thing and keeps the rest in the tooltip', () => {
  const at = 1_000_000, now = at + 5 * 60_000;
  const stage = (level, label = 'waiting for CI', icon = '') => ({ label, level, icon, by: 'x', byName: 'Coordinator', at });
  assert.equal(badgeFor(undefined, now), null);
  assert.equal(badgeFor({ status: { questions: 0, blocked: false, done: false, at } }, now), null);

  const blocked = badgeFor({ status: { questions: 3, blocked: true, done: false, at }, stage: stage('you') }, now);
  assert.equal(blocked.label, 'Blocked · ?3');
  assert.equal(blocked.icon, '⛔');
  assert.match(blocked.title, /3 open questions \(reported 5m ago\)/);
  assert.match(blocked.title, /Stage: waiting for CI \(needs you; set by Coordinator 5m ago\)/);

  assert.equal(badgeFor({ stage: stage('you', 'ready to close', '🧹'), status: { questions: 2, at } }, now).label, 'ready to close · ?2');
  assert.equal(badgeFor({ stage: stage('you', 'ready to close', '🧹') }, now).icon, '🧹');
  assert.equal(badgeFor({ status: { questions: 2, at }, stage: stage('waiting') }, now).label, '2 open questions');
  assert.equal(badgeFor({ status: { questions: 1, at } }, now).label, '1 open question');
  assert.equal(badgeFor({ status: { questions: 3, at } }, now).icon, '?3', 'the count rides in the glyph, so the sidebar shows it');
  assert.equal(badgeFor({ status: { questions: 9, at } }, now).icon, '?9');
  assert.equal(badgeFor({ status: { questions: 12, at } }, now).icon, '9+', 'a glyph holds two characters');
  assert.equal(badgeFor({ stage: stage('waiting'), status: { done: true, at } }, now).label, 'waiting for CI · done');
  assert.equal(badgeFor({ status: { done: true, at }, stage: stage('active', 'implementing') }, now).label, 'Done');
  const active = badgeFor({ stage: stage('active', 'implementing') }, now);
  assert.deepEqual([active.label, active.icon], ['implementing', '⚙']);

  const long = badgeFor({ stage: stage('you', 'draft, waiting for you to move it to waiting for review'), status: { questions: 12, at } }, now);
  assert.ok([...long.label].length <= 32, long.label);
  assert.match(long.label, /… · \?12$/);
});

test('flags can appear anywhere and unknown flags are rejected', () => {
  assert.deepEqual(parseFlags(['label', '--you', 's1', '--icon=🧹'], { you: 'bool', icon: 'value' }),
    { flags: { you: true, icon: '🧹' }, rest: ['label', 's1'] });
  assert.deepEqual(parseFlags(['--icon', 'x', 'a'], { icon: 'value' }).flags, { icon: 'x' });
  assert.match(parseFlags(['--nope'], { you: 'bool' }).error, /Unknown option/);
  assert.match(parseFlags(['--icon'], { icon: 'value' }).error, /needs a value/);
  assert.deepEqual(parseFlags(['--', '--you'], { you: 'bool' }).rest, ['--you']);
});

test('targets resolve by id, project-local name, @project/name or id prefix, and refuse ambiguity', () => {
  const caller = SESSIONS[0];
  const r = (value) => resolveTarget(value, SESSIONS, PROJECTS, caller);
  assert.equal(r('bbbbbbbb-2').session.sessionId, 'bbbbbbbb-2');
  assert.equal(r('ticket-1').session.sessionId, 'bbbbbbbb-2', 'the caller\'s own project wins a name clash');
  assert.equal(r('@Beta/TICKET-1').session.sessionId, 'dddddddd-4');
  assert.equal(r('Other').session.sessionId, 'eeeeeeee-5', 'a name unique elsewhere still resolves');
  assert.equal(r('cccccc').session.sessionId, 'cccccccc-3', 'unique id prefix');
  assert.match(r('nobody').error, /No session/);
  assert.match(r('@Gamma/x').error, /No project/);
  assert.match(resolveTarget('TICKET-1', SESSIONS, PROJECTS, undefined).error, /matches 2 sessions/);
});

test('an end-of-turn line sets the badge, and a new prompt clears blocked and done but keeps questions', async (t) => {
  const { status, api } = setup(t);
  status.onFinal({ sessionId: 'bbbbbbbb-2', text: 'Need input.\n[status: questions=2 blocked=yes done=no]' });
  assert.equal(api.badges.get('bbbbbbbb-2').label, 'Blocked · ?2');
  status.onUserTurn({ sessionId: 'bbbbbbbb-2' });
  assert.equal(api.badges.get('bbbbbbbb-2').label, '2 open questions');
  status.onFinal({ sessionId: 'bbbbbbbb-2', text: 'No status line this time.' });
  assert.equal(api.badges.get('bbbbbbbb-2').label, '2 open questions', 'a missing line keeps the last status');
  status.onFinal({ sessionId: 'bbbbbbbb-2', text: '[status: questions=0 done=yes]' });
  assert.equal(api.badges.get('bbbbbbbb-2').label, 'Done');
  assert.equal(api.badges.get('bbbbbbbb-2').icon, '✅');
  status.onUserTurn({ sessionId: 'bbbbbbbb-2' });
  assert.equal(api.badges.has('bbbbbbbb-2'), false, 'a new assignment makes the session not done');
});

test('report and questions are for the caller only, and a changed count drops a stale list', async (t) => {
  const { status, api, cmd } = setup(t);
  assert.match((await cmd('report', ['--questions', '2', '--blocked'], 'bbbbbbbb-2')).stdout, /2 open questions, blocked/);
  assert.equal(api.badges.get('bbbbbbbb-2').label, 'Blocked · ?2');
  assert.equal(api.badges.has('aaaaaaaa-1'), false);
  assert.equal((await cmd('report', ['--bogus'], 'bbbbbbbb-2')).exitCode, 1);
  assert.equal((await cmd('report', ['--questions', 'x'], 'bbbbbbbb-2')).exitCode, 1);

  await cmd('questions', ['Ship on Friday?', 'Rename the flag?'], 'bbbbbbbb-2');
  assert.deepEqual(status.entries.get('bbbbbbbb-2').questionList, ['Ship on Friday?', 'Rename the flag?']);
  assert.match((await cmd('questions', [], 'bbbbbbbb-2')).stdout, /1\. Ship on Friday\?\n2\. Rename the flag\?/);
  status.onFinal({ sessionId: 'bbbbbbbb-2', text: '[status: questions=3]' });
  assert.equal(status.entries.get('bbbbbbbb-2').questionList, undefined, 'the list no longer matches the count');
  await cmd('questions', ['--clear'], 'bbbbbbbb-2');
  assert.equal(api.badges.has('bbbbbbbb-2'), false);
});

test('a coordinator can stage several sessions at once with free-form labels and an optional icon', async (t) => {
  const { status, api, cmd } = setup(t);
  const result = await cmd('stage', ['ready to close', '--you', '--icon', '🧹', 'TICKET-1', 'TICKET-2']);
  assert.equal(result.exitCode, 0);
  assert.equal(api.badges.get('bbbbbbbb-2').label, 'ready to close');
  assert.equal(api.badges.get('bbbbbbbb-2').icon, '🧹');
  assert.equal(api.badges.get('cccccccc-3').label, 'ready to close', 'a stopped session can be marked too');
  assert.equal(api.badges.has('dddddddd-4'), false, 'the other project\'s TICKET-1 is untouched');
  assert.match(api.badges.get('bbbbbbbb-2').title, /set by Coordinator/);

  const mixed = await cmd('stage', ['waiting for CI', '--waiting', 'TICKET-1', 'nobody']);
  assert.equal(mixed.exitCode, 1, 'an unresolved target is reported');
  assert.match(mixed.stderr, /No session "nobody"/);
  assert.equal(api.badges.get('bbbbbbbb-2').label, 'waiting for CI', 'the others still applied');

  const self = await cmd('stage', ['implementing', '--active'], 'bbbbbbbb-2');
  assert.equal(self.exitCode, 0);
  assert.equal(status.entries.get('bbbbbbbb-2').stage.label, 'implementing');

  assert.match((await cmd('stage', ['x'])).stderr, /Say who needs to act/);
  assert.match((await cmd('stage', ['x', '--you', '--waiting'])).stderr, /Choose one/);
  assert.match((await cmd('stage', ['x', '--you', '--icon', 'abc'])).stderr, /--icon/);
  assert.equal((await cmd('stage', ['--clear', 'TICKET-1'])).exitCode, 0);
  assert.equal(status.entries.get('bbbbbbbb-2'), undefined);
});

test('stages and list report on the caller\'s project, and --all widens it', async (t) => {
  const { cmd } = setup(t);
  await cmd('stage', ['waiting for CI', '--waiting', 'TICKET-1', 'TICKET-2']);
  await cmd('stage', ['waiting for CI', '--waiting', '@Beta/Other']);
  await cmd('stage', ['draft', '--you', '@Beta/TICKET-1']);
  assert.deepEqual(JSON.parse((await cmd('stages', ['--json'])).stdout), [{ label: 'waiting for CI', level: 'waiting', count: 2 }]);
  assert.deepEqual(JSON.parse((await cmd('stages', ['--all', '--json'])).stdout).map((r) => [r.label, r.count]), [['waiting for CI', 3], ['draft', 1]]);
  const rows = JSON.parse((await cmd('list', ['--json'])).stdout);
  assert.deepEqual(rows.map((r) => r.name), ['Coordinator', 'TICKET-1', 'TICKET-2']);
  assert.equal(rows[1].stage.label, 'waiting for CI');
  assert.match((await cmd('list', [])).stdout, /TICKET-2 \(stopped\) — stage: waiting for CI \(waiting, just now\)/);
});

test('state survives a restart, drops deleted sessions, and ages refresh the tooltip', async (t) => {
  const first = setup(t);
  await first.cmd('stage', ['waiting for review', '--waiting', 'TICKET-1']);
  await first.cmd('report', ['--questions', '1'], 'eeeeeeee-5');
  first.status.stop();

  const api = fakeApi(first.dir, SESSIONS.filter((s) => s.sessionId !== 'eeeeeeee-5'));
  let clock = 1_000_000 + 3 * 3_600_000;
  const second = createStatus(api, { now: () => clock });
  t.after(() => second.stop());
  await second.start();
  assert.equal(api.badges.get('bbbbbbbb-2').label, 'waiting for review');
  assert.match(api.badges.get('bbbbbbbb-2').title, /3h ago/);
  assert.equal(second.entries.has('eeeeeeee-5'), false, 'a deleted session\'s state is dropped');

  await second.onClosed({ sessionId: 'bbbbbbbb-2' });
  assert.equal(second.entries.has('bbbbbbbb-2'), true, 'a stopped session keeps its stage');
});

test('forget removes a session\'s badge', async (t) => {
  const { status, api, cmd } = setup(t);
  await cmd('stage', ['x', '--you', 'TICKET-1']);
  assert.ok(api.badges.has('bbbbbbbb-2'));
  status.forget('bbbbbbbb-2');
  assert.equal(api.badges.has('bbbbbbbb-2'), false);
});
