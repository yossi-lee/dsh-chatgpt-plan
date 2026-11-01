/** Account controls contributed to the existing Models settings page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ChangeEvent } from 'react'
import { contribution } from './remote.ts'
import { en, zh, type Key } from './locales.ts'
import type { AccountStatus } from '../types.ts'

interface Result<T> { ok: boolean; value?: T; error?: { message: string } }
interface Remote {
  status(): Promise<Result<AccountStatus>>
  begin(): Promise<Result<AccountStatus>>
  submit(value: string): Promise<Result<AccountStatus>>
  cancel(): Promise<Result<AccountStatus>>
  logout(): Promise<Result<AccountStatus>>
}
interface Operations { call(method: 'status' | 'begin' | 'cancel' | 'logout'): Promise<AccountStatus>; submit(value: string): Promise<AccountStatus> }
interface Props { operations: Operations; t(key: Key): string }
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'codex-plan': Key } }

export const inject = ['slots', 'locale', 'remote']

/** Register one settings section and mount its Remote methods with the plugin lifetime. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('codex-plan', { en, zh }))
  const mounted = ctx.remote.$mount(contribution())
  // Handle mount rejection immediately, even when the Models page has not opened.
  void mounted.catch(error => ctx.logger.warn('ChatGPT plan UI could not mount its Remote methods', error))
  const remote = async (): Promise<Remote> => {
    await mounted
    const value = ctx.get('remote.codexPlan') as Remote | undefined
    if (!value) throw new Error('ChatGPT plan Remote service is unavailable')
    return value
  }
  const unwrap = (result: Result<AccountStatus>): AccountStatus => {
    if (!result.ok || result.value === undefined) throw new Error('ChatGPT plan request failed')
    return result.value
  }
  const operations: Operations = {
    call: async method => unwrap(await (await remote())[method]()),
    submit: async value => unwrap(await (await remote()).submit(value)),
  }
  const t = ctx.locale.bind('codex-plan')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'codex-plan', locale: 'codex-plan',
    inject: () => ({ operations, t }),
  }, AccountCard))
}

/** Display account facts; credentials stay exclusively on the Host. */
export function AccountCard({ operations, t }: Props) {
  const [status, setStatus] = useState<AccountStatus>({ connected: false, pending: false })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [callback, setCallback] = useState('')
  useEffect(() => {
    let live = true
    const load = () => operations.call('status').then(value => { if (live) { setStatus(value); setFailed(false) } }, () => { if (live) setFailed(true) })
    void load()
    const timer = setInterval(() => { void load() }, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [operations])
  const act = async (operation: () => Promise<AccountStatus>) => {
    setBusy(true)
    try { setStatus(await operation()); setFailed(false) }
    catch (error) { void error; setFailed(true) }
    finally { setBusy(false) }
  }
  return <section aria-label={t('title')}>
    <h3>{t('title')}</h3>
    <p>{status.connected ? t('connected') : t('signedOut')}{status.email ? ` (${status.email})` : ''}</p>
    <p>{t('notice')}</p>
    {failed && <p role="alert">{t('failed')}</p>}
    {status.error && <p role="alert">{t(status.error === 'signIn' ? 'signInError' : status.error)}</p>}
    {status.revocationUnconfirmed && <p role="status">{t('revoke')}</p>}
    {status.pending ? <>
      <p role="status">{t('waiting')}</p>
      {status.authorizationUrl && <p><a href={status.authorizationUrl} target="_blank" rel="noreferrer">{t('open')}</a></p>}
      <label>{t('callback')}<Input value={callback} onChange={(event: ChangeEvent<HTMLInputElement>) => setCallback(event.target.value)} /></label>
      <Button disabled={busy || !callback} onClick={() => { void act(() => operations.submit(callback)); setCallback('') }}>{t('submit')}</Button>
      <Button disabled={busy} onClick={() => void act(() => operations.call('cancel'))}>{t('cancel')}</Button>
    </> : <Button variant={status.connected ? 'outline' : 'primary'} disabled={busy} onClick={() => void act(() => operations.call(status.connected ? 'logout' : 'begin'))}>{t(status.connected ? 'signOut' : 'signIn')}</Button>}
    <Button disabled={busy} onClick={() => void act(() => operations.call('status'))}>{t('refresh')}</Button>
    <p><a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">{t('usage')}</a></p>
  </section>
}
