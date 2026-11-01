/** Incremental Responses translation with authoritative terminal reconciliation. */
import type { ResponseStreamEvent, ResponseOutputItem } from 'openai/resources/responses/responses'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { blockOf, nativeItem, replay, type NativeItem } from './messages.ts'
import { invalid, providerError } from './errors.ts'

interface Entry { index: number; item: ResponseOutputItem; block: ContentBlock; complete?: NativeItem; closed: boolean }

/** Translate one stream; incomplete streams and failures never produce replay metadata. */
export class Translator {
  private readonly entries = new Map<number, Entry>()
  private done = false

  constructor(private readonly model: string, private readonly scope: string) {}

  private start(outputIndex: number, item: ResponseOutputItem): StreamChunk[] {
    if (this.entries.has(outputIndex)) return []
    let block: ContentBlock
    switch (item.type) {
      case 'message': block = { type: 'text', text: '' }; break
      case 'reasoning': block = { type: 'reasoning', text: '' }; break
      case 'function_call':
        if (item.namespace !== undefined && item.namespace !== 'dsh') invalid('OpenAI returned an unknown tool namespace.')
        block = { type: 'tool-call', id: ToolCallId(item.call_id), name: item.name, arguments: '' }; break
      default: invalid('OpenAI returned an unsupported output item.')
    }
    const index = this.entries.size
    this.entries.set(outputIndex, { index, item, block, closed: false })
    return [{ type: 'block-start', index, blockType: block.type }]
  }

  private complete(outputIndex: number, item: ResponseOutputItem): StreamChunk[] {
    const chunks = this.start(outputIndex, item)
    const entry = this.entries.get(outputIndex)!
    const native = nativeItem(item), block = blockOf(native)
    if (entry.item.id !== undefined && item.id !== undefined && entry.item.id !== item.id) invalid('OpenAI changed a streamed item identity.')
    if (block.type !== entry.block.type) invalid('OpenAI changed a streamed output item type.')
    if (entry.closed) {
      if (JSON.stringify(entry.block) !== JSON.stringify(block)) invalid('OpenAI returned conflicting completed output.')
      entry.complete = native
      return chunks
    }
    entry.complete = native
    entry.block = block
    entry.closed = true
    chunks.push({ type: 'block-end', index: entry.index, block })
    return chunks
  }

  /** Consume a parsed SDK event and return ordered DSH chunks. */
  push(event: ResponseStreamEvent): StreamChunk[] {
    if (this.done) return []
    switch (event.type) {
      case 'response.output_item.added': return this.start(event.output_index, event.item)
      case 'response.output_item.done': return this.complete(event.output_index, event.item)
      case 'response.output_text.delta': case 'response.refusal.delta': case 'response.reasoning_summary_text.delta':
      case 'response.function_call_arguments.delta': {
        const entry = this.entries.get(event.output_index)
        if (!entry || entry.closed) invalid('OpenAI sent a delta without a matching open item.')
        if (event.type === 'response.function_call_arguments.delta') {
          if (entry.block.type !== 'tool-call') invalid('OpenAI sent tool arguments for another item type.')
          entry.block.arguments += event.delta
          return [{ type: 'tool-call-delta', index: entry.index, id: entry.block.id, name: entry.block.name, argumentsDelta: event.delta }]
        }
        if (entry.block.type !== 'text' && entry.block.type !== 'reasoning') invalid('OpenAI sent text for a tool call.')
        entry.block.text += event.delta
        return [{ type: entry.block.type === 'text' ? 'text-delta' : 'reasoning-delta', index: entry.index, text: event.delta }]
      }
      case 'response.completed': {
        const chunks: StreamChunk[] = []
        for (const [position, item] of event.response.output.entries()) {
          const match = [...this.entries.entries()].find(([, entry]) => item.id !== undefined && entry.item.id === item.id)
          chunks.push(...this.complete(match?.[0] ?? position, item))
        }
        if ([...this.entries.values()].some(entry => !entry.complete)) invalid('OpenAI completed a response with unfinished items.')
        const items = [...this.entries.values()].map(e => e.complete!)
        if (!items.length) invalid('OpenAI completed a response without output.')
        this.done = true
        const usage = event.response.usage
        if (usage) chunks.push({ type: 'usage', usage: {
          inputTokens: usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0),
          outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
          cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        } })
        chunks.push({ type: 'finish', reason: { kind: items.some(i => i.type === 'function_call') ? 'tool-calls' : 'stop' }, replayState: replay(items, this.model, this.scope) })
        return chunks
      }
      case 'response.failed':
        this.done = true
        return [...this.close(), { type: 'finish', reason: { kind: 'error', failure: providerError(event.response.error?.code ?? '').failure } }]
      case 'response.incomplete':
        this.done = true
        return [...this.close(), { type: 'finish', reason: event.response.incomplete_details?.reason === 'max_output_tokens'
          ? { kind: 'max-tokens' } : { kind: 'error', failure: providerError('').failure } }]
      case 'error': throw providerError(event.code ?? '')
      default: return [] // Responses also emits progress and content-part notifications.
    }
  }

  /** Close visible partial output on cancellation or transport failure. */
  close(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    for (const entry of this.entries.values()) {
      if (!entry.closed) { entry.closed = true; chunks.push({ type: 'block-end', index: entry.index, block: entry.block }) }
    }
    return chunks
  }

  /** EOF without an authoritative terminal response is a failed request. */
  finish(): void { if (!this.done) invalid('The ChatGPT stream ended before a terminal response. The request may have consumed plan usage.') }
}
