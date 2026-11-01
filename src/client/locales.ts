/** Account-card copy owned by this plugin. */
export const en = {
  title: 'ChatGPT plan', signIn: 'Continue with ChatGPT', signOut: 'Sign out', cancel: 'Cancel sign-in',
  open: 'Open ChatGPT authorization', submit: 'Submit callback', callback: 'Full callback URL',
  connected: 'Using your ChatGPT plan', signedOut: 'Sign in to use your ChatGPT plan in DSH.',
  usage: 'Manage usage', refresh: 'Refresh status', waiting: 'Waiting for ChatGPT authorization…',
  failed: 'Could not reach the ChatGPT plan service. Restart DSH and try again.',
  revoke: 'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT settings.',
  notice: 'Eligible requests use your existing plan allowance. Review app limits and credits in ChatGPT settings.',
  consent: 'Plan usage was not authorized. Sign in again and allow this app to use your plan.',
  identity: 'ChatGPT identity verification failed. Sign in again.',
  signInError: 'ChatGPT sign-in failed. Check your connection and try again.',
}
export type Key = keyof typeof en
export const zh: Record<Key, string> = {
  title: 'ChatGPT plan', signIn: '使用 ChatGPT 继续', signOut: '退出登录', cancel: '取消登录',
  open: '打开 ChatGPT 授权页面', submit: '提交回调', callback: '完整回调 URL',
  connected: '正在使用你的 ChatGPT 订阅', signedOut: '登录后即可在 DSH 中使用你的 ChatGPT 订阅。',
  usage: '管理用量', refresh: '刷新状态', waiting: '等待 ChatGPT 授权…',
  failed: '无法连接 ChatGPT plan 服务，请重启 DSH 后重试。',
  revoke: '本地已退出，但未确认远端撤销成功；请在 ChatGPT 设置中断开此应用。',
  notice: '符合条件的请求使用已有订阅额度。请在 ChatGPT 设置中查看应用限额和点数使用设置。',
  consent: '尚未授权使用订阅额度，请重新登录并允许此应用使用订阅。',
  identity: 'ChatGPT 身份验证失败，请重新登录。',
  signInError: 'ChatGPT 登录失败，请检查网络后重试。',
}
