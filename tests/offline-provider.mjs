/** Keyless provider fixture loaded only into the verification subprocess. */
import { appendFileSync } from 'node:fs'

const original = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (!href.startsWith('https://api.openai.com/v1/')) return original(url, init)
  const headers = new Headers(init?.headers)
  if (headers.get('authorization') !== 'Bearer offline-access') throw new Error('Smoke request did not use the fixture connection')
  if (!headers.get('user-agent')?.includes('deepseek-harness')) throw new Error('Missing DSH attribution')
  if (href.endsWith('/models')) return Response.json({ models: [{ slug: 'offline-model', display_name: 'Offline model', visibility: 'list', context_window: 128000 }] })
  if (!href.endsWith('/responses')) throw new Error('Unexpected provider endpoint')
  const body = JSON.parse(String(init?.body))
  const tools = body.tools?.flatMap(namespace => namespace.tools ?? []) ?? []
  const hasTodo = tools.some(tool => tool.name === 'todo_write')
  const toolResult = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'offline-call')
  if (hasTodo) appendFileSync(process.env.CODEX_PLAN_TEST_REQUESTS, JSON.stringify({
    store: body.store, stream: body.stream, toolsNamespaced: body.tools.every(tool => tool.type === 'namespace'),
    toolResultSeen: Boolean(toolResult),
    encryptedReplaySeen: body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'offline-encrypted'),
  }) + '\n')
  const output = hasTodo && !toolResult
    ? [{ type: 'reasoning', id: 'offline-reasoning', summary: [], encrypted_content: 'offline-encrypted' }, { type: 'function_call', id: 'offline-tool', call_id: 'offline-call', name: 'todo_write', namespace: 'dsh', arguments: JSON.stringify({ todos: [{ content: 'Verify ChatGPT plan', status: 'completed' }] }) }]
    : [{ type: 'message', id: 'offline-message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'CODEX_PLAN_OK', annotations: [] }] }]
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
