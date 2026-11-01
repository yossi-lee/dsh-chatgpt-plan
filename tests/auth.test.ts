import { afterEach, expect, it } from 'vitest'
import { PlanAuth, KEY } from '../src/auth.ts'
import { fixture, options } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())) })
async function setup() { const f = await fixture(); cleanups.push(f.cleanup); return f }

it('persists a stable host and reuses the issued client registration after logout', async () => {
  const f = await setup()
  const first = await f.login()
  expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(first.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
  expect((await f.auth.connection())?.subject).toBe('user-1')
  expect(await f.auth.logout(new AbortController().signal)).toBe(true)
  expect(await f.auth.connection()).toBeUndefined()
  const second = await f.login()
  expect(second.searchParams.get('client_id')).toBe('oaiapp_test')
  expect(second.searchParams.get('ext_agent_host_id')).toBe(first.searchParams.get('ext_agent_host_id'))
  expect(second.searchParams.has('agent_name_hint')).toBe(false)
})

it.each(['missing-scope', 'bad-signature', 'wrong-nonce', 'wrong-audience'] as const)('rejects %s before storing a connection', async mode => {
  const f = await setup(); f.setMode(mode)
  await expect(f.login()).rejects.toThrow()
  expect(await f.auth.connection()).toBeUndefined()
})

it('serializes concurrent refreshes from two auth instances using the actual DSH store', async () => {
  const f = await setup(); await f.login()
  const original = (await f.auth.connection())!
  f.advance(3500000)
  const other = new PlanAuth(f.ctx.credentials, options, f.network)
  const signal = new AbortController().signal
  const [a, b] = await Promise.all([f.auth.usable(original.epoch, signal), other.usable(original.epoch, signal)])
  expect(f.refreshes()).toBe(1)
  expect(a.refreshToken).toBe('refresh-1')
  expect(b.refreshToken).toBe(a.refreshToken)
})

it('does not let a request bound to an old login adopt another connection', async () => {
  const f = await setup(); await f.login()
  const old = (await f.auth.connection())!
  await f.auth.logout(new AbortController().signal)
  await f.login()
  await expect(f.auth.usable(old.epoch, new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_PLAN_SIGN_IN_REQUIRED' })
})

it('clears unusable rotating tokens when a refresh has an unknown outcome', async () => {
  const f = await setup(); await f.login()
  const connection = (await f.auth.connection())!
  f.advance(3500000)
  const auth = new PlanAuth(f.ctx.credentials, options, { ...f.network, fetch: async () => { throw new Error('network lost') } })
  await expect(auth.usable(connection.epoch, new AbortController().signal)).rejects.toThrow('network lost')
  expect(await f.auth.connection()).toBeUndefined()
  expect(await f.ctx.credentials.describeRecord(KEY)).toMatchObject({ configured: true })
})

it('reports unconfirmed remote revocation while removing local tokens', async () => {
  const f = await setup(); await f.login()
  const auth = new PlanAuth(f.ctx.credentials, options, { ...f.network, fetch: async () => { throw new Error('offline') } })
  expect(await auth.logout(new AbortController().signal)).toBe(false)
  expect(await f.auth.connection()).toBeUndefined()
})

it.each(['iso', 'seconds'])('honors an earliest-refresh time encoded as %s', async format => {
  const f = await setup()
  const earliest = Date.now() + 4000000
  f.setEarliest(format === 'iso' ? new Date(earliest).toISOString() : earliest / 1000)
  await f.login()
  const connection = (await f.auth.connection())!
  f.advance(3500000)
  await f.auth.usable(connection.epoch, new AbortController().signal)
  expect(f.refreshes()).toBe(0)
  f.advance(200000)
  await expect(f.auth.usable(connection.epoch, new AbortController().signal)).rejects.toMatchObject({ code: 'CODEX_PLAN_REFRESH_NOT_READY' })
  expect(f.refreshes()).toBe(0)
  expect(await f.auth.connection()).toBeDefined()
})
