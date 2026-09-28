#!/usr/bin/env node
'use strict';
// Claude Code PermissionRequest hook for claude-autoapprove.
// argv[2] is the plugin's signal directory. The hook is inert outside CliDeck sessions and for sessions
// without a signal file, so it adds no prompts or latency when auto-approve is off.
const { appendFileSync, existsSync, readFileSync } = require('fs');
const { join } = require('path');

const signalDir = process.argv[2] || '';
const clideckId = process.env.CLIDECK_SESSION_ID || '';
if (!signalDir || !clideckId || !/^[A-Za-z0-9_-]+$/.test(clideckId)) process.exit(0);

const signalFile = join(signalDir, clideckId);
const SUPERVISED_GATES = new Set(['ExitPlanMode', 'AskUserQuestion']);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  if (!existsSync(signalFile)) process.exit(0);

  let hook = {};
  try { hook = JSON.parse(stdin); } catch {}
  const toolName = hook.tool_name || hook.toolName || '';

  let mode = 'supervised';
  try { mode = readFileSync(signalFile, 'utf8').trim() || 'supervised'; } catch {}

  // Supervised mode leaves plan approval and direct questions interactive.
  if (mode === 'supervised' && SUPERVISED_GATES.has(toolName)) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  }));

  // One byte per approval; the plugin reads the file size as the count.
  try { appendFileSync(`${signalFile}.approved`, '.'); } catch {}
});
process.stdin.resume();
