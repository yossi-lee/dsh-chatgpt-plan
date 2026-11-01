/** Install into a disposable profile using DSH's supported launcher. */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const checkout = resolve(process.argv[2] ?? '../dsh')
const plugin = process.cwd()
const installSource = process.argv.find(value => value.endsWith('.tgz'))
const home = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-plan-install-'))
const profile = 'codex-plan-smoke'
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
env.DSH_HOME = home
const run = args => execFileSync('pnpm', ['dsh', ...args], { cwd: checkout, env, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  run(['plugin', '--profile', profile, 'add', installSource === undefined ? plugin : resolve(installSource)])
  const manifest = JSON.parse(await readFile(join(home, `profiles/${profile}/package.json`), 'utf8'))
  if (!manifest.dsh.profile.bundles.includes('dsh-chatgpt-plan')) throw new Error('DSH did not activate the plugin bundle')
  const composed = run(['--profile', profile, '--dump-config'])
  if (!composed.includes('dsh-chatgpt-plan')) throw new Error('DSH did not compose the plugin row')
  console.log('PASS: actual dsh plugin add, profile bundle activation and composed configuration')
  const sessionProfile = 'codex-plan-session'
  run(['--profile', sessionProfile, '--from-default-profile', 'headless', '--dump-config'])
  run(['plugin', '--profile', sessionProfile, 'add', installSource === undefined ? plugin : resolve(installSource)])
  await writeFile(join(home, `profiles/${sessionProfile}/cordis.patch.yml`), '- id: agent-default-model\n  config:\n    provider: codex-plan\n    model: offline-model\n')
  await writeFile(join(home, '.credentials.yaml'), JSON.stringify({ version: 1, records: {
    'codex-plan/connection': { kind: 'grant', payload: { version: 1, hostId: `urn:uuid:${randomUUID()}`,
      registration: { clientId: 'offline-client', subject: 'offline-user' },
      connection: { clientId: 'offline-client', subject: 'offline-user', epoch: randomUUID(), accessToken: 'offline-access', refreshToken: 'offline-refresh', idToken: 'offline-id', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] },
    } },
  } }), { mode: 0o600 })
  env.NODE_OPTIONS = `--import ${pathToFileURL(join(plugin, 'tests/offline-provider.mjs')).href}`
  env.CODEX_PLAN_TEST_REQUESTS = join(home, 'requests.jsonl')
  const eventsOf = output => output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  const events = eventsOf(run(['--profile', sessionProfile, '--json', 'CODEX_PLAN_SMOKE']))
  assert.equal(events.find(event => event.type === 'final')?.text, 'CODEX_PLAN_OK')
  const sessionId = events.find(event => event.type === 'session')?.sessionId
  assert.ok(sessionId)
  const resumed = eventsOf(run(['--profile', sessionProfile, '--session-id', sessionId, '--json', 'CODEX_PLAN_RESUME']))
  assert.equal(resumed.find(event => event.type === 'final')?.text, 'CODEX_PLAN_OK')
  const requests = (await readFile(env.CODEX_PLAN_TEST_REQUESTS, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(requests, JSON.parse(await readFile(join(plugin, 'tests/session.expected.json'), 'utf8')))
  console.log('PASS: keyless headless Session, todo tool execution, process restart/resume, encrypted replay and recorded request snapshot')
  if (process.argv.includes('--keep')) console.log('Smoke home:', home)
} finally {
  if (!process.argv.includes('--keep')) await rm(home, { recursive: true, force: true })
}
