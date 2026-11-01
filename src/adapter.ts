/** Account-bound DSH model adapter over public Responses API. */
import OpenAI from 'openai'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PlanAuth, Connection } from './auth.ts'
import { RESOURCE } from './auth.ts'
import type { Options } from './types.ts'
import { Work } from './work.ts'
import { providerError } from './errors.ts'
import { effortSchema, requestBody } from './messages.ts'
import { Translator } from './stream.ts'

export const PROVIDER = 'codex-plan'
const modelSchema = z.object({
  slug: z.string().min(1), display_name: z.string().optional(), visibility: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string().min(1), description: z.string().optional() })).optional(),
})
const catalogSchema = z.object({ models: z.array(modelSchema) })
type Model = z.infer<typeof modelSchema>

/** Capture one authorization generation for request isolation and history replay. */
function scopeOf(connection: Connection): string {
  return createHash('sha256').update(JSON.stringify([connection.clientId, connection.subject, connection.epoch])).digest('hex')
}

/** One adapter instance, with requests retained until their stream readers close. */
export class PlanAdapter extends LlmAdapter {
  readonly work = new Work()
  private accountController = new AbortController()
  constructor(private readonly auth: PlanAuth, private readonly options: Options, private readonly fetcher: typeof fetch = fetch) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT plan' } }
  override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }

  private async captured(signal?: AbortSignal): Promise<Connection> {
    this.work.signal(signal).throwIfAborted()
    const connection = await this.auth.connection()
    if (!connection) throw providerError('', 401)
    return connection
  }

  private async catalog(connection: Connection, signal?: AbortSignal): Promise<Model[]> {
    return this.work.run(async lifetime => {
      const bounded = AbortSignal.any([lifetime, this.accountController.signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
      const token = await this.auth.usable(connection.epoch, bounded)
      const response = await this.fetcher(`${RESOURCE}/models`, { signal: bounded, redirect: 'error', headers: { ...attributionHeaders(), authorization: `Bearer ${token.accessToken}` } })
      if (!response.ok) {
        if (response.status === 401) await this.auth.invalidate(connection.epoch)
        throw providerError('', response.status)
      }
      const value = catalogSchema.safeParse(await response.json())
      if (!value.success) throw new LlmError('ChatGPT returned an invalid model catalog.', 'CODEX_PLAN_INVALID_DATA')
      return value.data.models.filter(m => m.visibility === undefined || m.visibility === 'list')
    }, signal)
  }

  override async listModels(provider: string) {
    const connection = await this.auth.connection()
    if (!connection) return []
    return (await this.catalog(connection)).map(m => ({ provider, id: m.slug, name: m.display_name ?? m.slug, inputModalities: ['text'] as const }))
  }

  private async describe(provider: string, model: string, connection: Connection, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const item = (await this.catalog(connection, signal)).find(m => m.slug === model)
    if (!item) throw new LlmError('The selected model is absent from this ChatGPT account catalog. Refresh the model selection.', 'CODEX_PLAN_MODEL_UNAVAILABLE')
    const capacity = (Object.hasOwn(this.options.modelContextWindows, model) ? this.options.modelContextWindows[model] : undefined) ?? item.context_window
    const efforts = item.supported_reasoning_levels?.filter(level => effortSchema.safeParse(level.effort).success)
    return {
      provider, id: model, name: item.display_name ?? model, inputModalities: ['text'], systemPromptUpdate: 'in-history',
      ...capacity === undefined ? {} : { context: { contextWindow: capacity } },
      ...!efforts?.length ? {} : { reasoning: { efforts: efforts.map(e => ({ id: ReasoningEffortId(e.effort), name: e.effort, ...e.description === undefined ? {} : { description: e.description } })) } },
    }
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.describe(provider, model, await this.captured(signal), signal)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = await this.captured(signal)
    const info = await this.describe(provider, model, connection, signal)
    return { model: info, stream: options => this.bound(options, connection, info) }
  }

  /** Cancel this instance's account-bound traffic when credentials are withdrawn. */
  cancelRequests(): void {
    this.accountController.abort(new Error('ChatGPT connection changed'))
    this.accountController = new AbortController()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }

  private async *bound(options: GenerateOptions, captured: Connection, info: LlmResolvedModelInfo): AsyncIterable<StreamChunk> {
    if (options.reasoningEffort !== undefined && !info.reasoning?.efforts.some(e => e.id === options.reasoningEffort)) throw new LlmError('The selected reasoning effort is unavailable for this model.', 'UNSUPPORTED_REASONING_EFFORT')
    const caller = this.work.signal(options.signal)
    const signal = AbortSignal.any([caller, this.accountController.signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
    let release!: () => void
    const settled = new Promise<void>(resolve => { release = resolve })
    const tracked = this.work.run(async () => settled, signal)
    const translator = new Translator(options.model, scopeOf(captured))
    let stream: Awaited<ReturnType<OpenAI['responses']['create']>> | undefined
    try {
      const token = await this.auth.usable(captured.epoch, signal)
      const client = new OpenAI({ apiKey: token.accessToken, baseURL: RESOURCE, organization: null, project: null, maxRetries: 0, logLevel: 'off', fetch: this.fetcher, fetchOptions: { redirect: 'error' }, defaultHeaders: attributionHeaders() })
      const response = await client.responses.create(requestBody(options, scopeOf(captured)), { signal })
      stream = response
      for await (const event of response) for (const chunk of translator.push(event)) yield chunk
      translator.finish()
    } catch (error) {
      yield* translator.close()
      if (error instanceof LlmError) throw error
      if (signal.aborted) throw new LlmError('The ChatGPT request was cancelled or timed out; plan usage may have occurred.', 'CODEX_PLAN_CANCELLED')
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401) await this.auth.invalidate(captured.epoch)
        throw providerError(typeof error.code === 'string' ? error.code : '', error.status)
      }
      throw new LlmError('The ChatGPT connection ended unexpectedly; plan usage may have occurred.', 'CODEX_PLAN_TRANSPORT')
    } finally {
      if (stream && 'controller' in stream) stream.controller.abort()
      release()
      await Promise.allSettled([tracked])
    }
  }
}
