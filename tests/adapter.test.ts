import { afterEach, expect, it } from 'vitest'
import { BlockAssembler, createMessage, createUserMessage, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PlanAdapter } from '../src/adapter.ts'
import { requestBody } from '../src/messages.ts'
import { collect, deferred, fixture, message, options, textEvents, wireFetch } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())) })
async function setup() { const f = await fixture(); cleanups.push(f.cleanup); await f.login(); return f }

it('uses public API, streams text, and preserves disjoint cache accounting', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const adapter = new PlanAdapter(f.auth, options, wireFetch(textEvents, requests))
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'codex-plan', model: 'test-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })] })) assembler.push(chunk)
  expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hello' }])
  expect(assembler.finish).toEqual({ kind: 'stop' })
  expect(assembler.usage).toMatchObject({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 2 })
  expect(requests[0]).toMatchObject({ authorization: 'Bearer access-0', body: { model: 'test-model', stream: true, store: false } })
  await adapter.work.close()
})

it('round-trips encrypted reasoning and namespaced calls through actual DSH JSON restore', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const native = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo', namespace: 'dsh', arguments: '{"text":"hi"}' },
  ]
  const adapter = new PlanAdapter(f.auth, options, wireFetch([{ type: 'response.completed', response: { output: native } }], requests))
  const assembler = new BlockAssembler()
  const request = { provider: 'codex-plan', model: 'test-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'echo' }], source: { kind: 'user' } })], tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object' } }] }
  for await (const chunk of adapter.stream(request)) assembler.push(chunk)
  expect(assembler.finish).toEqual({ kind: 'tool-calls' })
  const assistant = JSON.parse(JSON.stringify(assembler.message({ provider: 'codex-plan', model: 'test-model', replayState: assembler.replayState })))
  await collect(adapter.stream({ ...request, messages: [...request.messages, assistant, createMessage({ role: 'tool', content: [{ type: 'text', text: 'hi' }], source: { kind: 'tool', callId: ToolCallId('call_1') }, toolCallId: ToolCallId('call_1') })] }))
  expect(requests[1]?.body).toMatchObject({ input: [expect.anything(), ...native, { type: 'function_call_output', call_id: 'call_1', output: 'hi' }], tools: [{ type: 'namespace', name: 'dsh' }] })
  await adapter.work.close()
})

it('does not replay encrypted state after visible message edits or a model change', () => {
  const assistant = createMessage({ role: 'assistant', content: [{ type: 'text', text: 'edited' }], source: { kind: 'model', provider: 'codex-plan', model: 'test-model', replayState: { response: { kind: 'codex-plan', version: 1, scope: 'scope', model: 'test-model', count: 1 }, blocks: [{ hash: 'stale', item: message }] } } })
  expect(requestBody({ provider: 'codex-plan', model: 'test-model', messages: [assistant] }, 'scope').input).toEqual([{ type: 'message', id: assistant.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'edited', annotations: [] }] }])
})

it('serializes the SDK-supported max reasoning effort without rewriting it', () => {
  expect(requestBody({ provider: 'codex-plan', model: 'test-model', messages: [], reasoningEffort: ReasoningEffortId('max') }, 'scope').reasoning).toEqual({ effort: 'max' })
})

it('keeps catalog models when a server adds an effort outside the installed SDK', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, async () => Response.json({ models: [{
    slug: 'test-model', display_name: 'Test model', visibility: 'list', context_window: 128000,
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }, { effort: 'ultra' }, { effort: 'future-effort' }],
  }] }))
  expect(await adapter.listModels('codex-plan')).toMatchObject([{ id: 'test-model' }])
  expect((await adapter.resolveModel('codex-plan', 'test-model')).reasoning?.efforts.map(e => e.id)).toEqual(['high', 'max'])
  await expect(collect(adapter.stream({ provider: 'codex-plan', model: 'test-model', messages: [], reasoningEffort: ReasoningEffortId('ultra') }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  await adapter.work.close()
})

it('reports a midstream plan limit without success or replay data', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, wireFetch([...textEvents.slice(0, 2), { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }], []))
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'codex-plan', model: 'test-model', messages: [] })) assembler.push(chunk)
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'CODEX_PLAN_LIMIT' } })
  expect(assembler.replayState).toBeUndefined()
  await adapter.work.close()
})

it('rejects a truncated stream and unsupported controls', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, wireFetch(textEvents.slice(0, 2), []))
  await expect(collect(adapter.stream({ provider: 'codex-plan', model: 'test-model', messages: [] }))).rejects.toThrow('terminal')
  expect(() => requestBody({ provider: 'codex-plan', model: 'test-model', messages: [], maxTokens: 10 }, 'scope')).toThrow('do not support')
  await adapter.work.close()
})

it('aborts network traffic and awaits its settlement on plugin disposal', async () => {
  const f = await setup(), entered = deferred<void>()
  let settled = false
  const adapter = new PlanAdapter(f.auth, options, async (url, init) => {
    if (String(url).endsWith('/models')) return wireFetch([], [])(url, init)
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { settled = true; reject(init.signal!.reason) }, { once: true })
      entered.resolve()
    })
  })
  const result = collect(adapter.stream({ provider: 'codex-plan', model: 'test-model', messages: [] }))
  const observed = result.catch(error => error)
  await entered.promise
  await adapter.work.close()
  expect(settled).toBe(true)
  expect(await observed).toMatchObject({ code: 'CODEX_PLAN_CANCELLED' })
})

it('rejects a response that contradicts already completed visible output', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, wireFetch([...textEvents.slice(0, 4), { type: 'response.completed', response: { output: [{ ...message, content: [{ type: 'output_text', text: 'different', annotations: [] }] }] } }], []))
  await expect(collect(adapter.stream({ provider: 'codex-plan', model: 'test-model', messages: [] }))).rejects.toThrow('conflicting')
  await adapter.work.close()
})

it('retires an API-rejected session without falling back to ambient API keys', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, async () => new Response('{}', { status: 401 }))
  await expect(adapter.listModels('codex-plan')).rejects.toMatchObject({ code: 'CODEX_PLAN_SIGN_IN_REQUIRED' })
  expect(await f.auth.connection()).toBeUndefined()
  await adapter.work.close()
})
