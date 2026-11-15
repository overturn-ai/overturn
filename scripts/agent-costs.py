#!/usr/bin/env python3
"""Weekly cost of the agent workflows, as a markdown table on stdout.

Reads the agent-cost record each agent run leaves on its run page.
Needs the gh CLI and GH_TOKEN. DAYS sets the window (default 7).
"""
import json
import os
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone

WORKFLOWS = ['overnight-loop.yml', 'sentry-fix.yml', 'ci-fix.yml', 'friday-review.yml']
AGENT_BRANCHES = ('agent/', 'fix/sentry-', 'fix/ci')
DAYS = int(os.environ.get('DAYS', '7'))
since = (datetime.now(timezone.utc) - timedelta(days=DAYS)).strftime('%Y-%m-%d')


def gh(*args):
    r = subprocess.run(['gh', *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ''


rows, top = [], []
for wf in WORKFLOWS:
    runs = json.loads(gh('run', 'list', '--workflow', wf, '--created', '>=' + since, '--limit', '500', '--json', 'databaseId,url') or '[]')
    cost, recorded, turns = 0.0, 0, 0
    for run in runs:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['gh', 'run', 'download', str(run['databaseId']), '-n', 'agent-cost', '-D', tmp], capture_output=True)
            path = os.path.join(tmp, 'agent-cost.json')
            if not os.path.exists(path):
                continue
            try:
                with open(path) as f:
                    rec = json.load(f)
            except ValueError:
                continue
        try:
            c = float(rec.get('cost_usd') or 0)
            t = int(rec.get('turns') or 0)
        except (TypeError, ValueError, AttributeError):
            continue
        cost += c
        recorded += 1
        turns += t
        top.append((c, wf, run['url']))
    rows.append((wf, len(runs), recorded, cost, turns))

prs = json.loads(gh('pr', 'list', '--state', 'all', '--search', 'created:>=' + since, '--limit', '200', '--json', 'headRefName,mergedAt') or '[]')
agent = [p for p in prs if p['headRefName'].startswith(AGENT_BRANCHES)]
merged = [p for p in agent if p.get('mergedAt')]
total = sum(r[3] for r in rows)

print('## Agent cost, last %d days (since %s)' % (DAYS, since))
print()
print('| job | runs | runs that used the model | cost | per run | turns |')
print('|---|---|---|---|---|---|')
for wf, n, rec, cost, turns in rows:
    per = ('$%.2f' % (cost / rec)) if rec else '-'
    print('| %s | %d | %d | $%.2f | %s | %d |' % (wf.replace('.yml', ''), n, rec, cost, per, turns))
print('| **total** | | | **$%.2f** | | |' % total)
print()
per_pr = ('$%.2f' % (total / len(merged))) if merged else 'nothing merged yet'
print('Agent PRs opened: %d. Merged: %d. Cost per merged PR: %s.' % (len(agent), len(merged), per_pr))
if top:
    print()
    print('Most expensive runs:')
    for c, wf, url in sorted(top, reverse=True)[:5]:
        print('- $%.2f %s %s' % (c, wf.replace('.yml', ''), url))
if not any(r[2] for r in rows):
    print()
    print('No cost records yet. They start with the first agent run after this change.')

with open(os.environ.get('TOTAL_FILE', '/tmp/agent-cost-total.txt'), 'w') as f:
    f.write('%.2f' % total)
