/** Copy dictionaries for the Openloop shell credential control. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  credentialReading: 'Reading credential status…',
  credentialConfigured: 'API key is securely stored',
  credentialMissing: 'API key is not configured',
  sourceKeychain: 'macOS Keychain · saved value is never shown',
  sourceEnvironment: 'Environment variable',
  sourceLegacyFile: 'Legacy credential file',
  sourceHost: 'Managed by the Openloop Host',
  sourceManaged: 'Managed credential source',
  replaceOpening: 'Opening…',
  replace: 'Replace API key',
  add: 'Add API key',
  deleteBusy: 'Deleting…',
  delete: 'Delete API key',
  initialReadFailed: 'Unable to read API key status. Try again.',
  refreshFailed: 'Unable to refresh API key status. Try again.',
  replaceFailed: 'Unable to update the API key. Try again.',
  deleteFailed: 'Unable to delete the API key. Try again.',
  retry: 'Retry',
}

/** The openloop.shell namespace key union. */
export type ShellKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in ShellKey]: string } = {
  credentialReading: '正在读取凭据状态…',
  credentialConfigured: 'API 密钥已安全保存',
  credentialMissing: '尚未配置 API 密钥',
  sourceKeychain: 'macOS 钥匙串 · 不显示已保存内容',
  sourceEnvironment: '环境变量',
  sourceLegacyFile: '旧版凭据文件',
  sourceHost: '由 Openloop Host 管理',
  sourceManaged: '受管凭据来源',
  replaceOpening: '正在打开…',
  replace: '替换 API 密钥',
  add: '添加 API 密钥',
  deleteBusy: '正在删除…',
  delete: '删除 API 密钥',
  initialReadFailed: '无法读取 API 密钥状态，请重试。',
  refreshFailed: '无法刷新 API 密钥状态，请重试。',
  replaceFailed: '无法更新 API 密钥，请重试。',
  deleteFailed: '无法删除 API 密钥，请重试。',
  retry: '重试',
}
