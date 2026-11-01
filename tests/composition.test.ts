/** Exercise the published package entry through the actual Cordis Loader. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { PlanController } from '../src/controller.ts'
import { contribution } from '../src/client/remote.ts'
import { KEY } from '../src/auth.ts'
import { fixture, textEvents, wireFetch } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals() })

it('loads a real cordis.yml, serves a model request, and removes all registrations on unload', async () => {
  const f = await fixture(); cleanup.push(f.cleanup); await f.login()
  const directory = await mkdtemp(join(tmpdir(), 'codex-plan-loader-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'cordis.yml')
  await writeFile(path, `- id: llm\n  name: '@deepseek-ai/dsh-llm'\n- id: credentials\n  name: '@deepseek-ai/dsh-credentials-local'\n  config:\n    path: ${JSON.stringify(join(directory, 'credentials.yaml'))}\n    watch: false\n- id: authorization\n  name: '@deepseek-ai/dsh-authorization'\n- id: codex-plan\n  name: dsh-chatgpt-plan\n  config:\n    callbackPort: 0\n`)
  const requests: { body: unknown; authorization: string | null }[] = []
  vi.stubGlobal('fetch', wireFetch(textEvents, requests))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const unsupported = (): never => { throw new Error('Unexpected module-loader operation') }
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), import: specifier => import(specifier), register: unsupported, getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  expect(ctx.llm.listProviders()).toContainEqual({ id: 'codex-plan', name: 'ChatGPT plan' })
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'codex-plan')!
  expect(ctx.authorization.describe(KEY)?.methods).toEqual([{ id: 'oauth', label: 'Continue with ChatGPT' }])
  const saved = await f.ctx.credentials.readRecord(KEY)
  await ctx.credentials.modifyRecord(KEY, async () => saved)
  const controller = ctx.get('codexPlanController') as PlanController
  expect(remoteMethods(controller).map(method => method.method)).toEqual(contribution().descriptors.map(d => d.method))
  expect(JSON.stringify(await controller.status())).not.toMatch(/access-0|refresh-0|idToken/)
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'codex-plan', model: 'test-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })] })) assembler.push(chunk)
  expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hello' }])
  expect(assembler.finish).toEqual({ kind: 'stop' })
  expect(requests).toHaveLength(1)
  await entry.fiber?.dispose()
  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.authorization.describe(KEY)).toBeUndefined()
  expect(ctx.get('codexPlanController')).toBeUndefined()
})
