/** Non-secret local readiness failures. Never contain remote/credential error text. */
export type CloudAccessReason = 'checking' | 'no-active-vault' | 'ambiguous-active-vault' | 'roster-error' | 'status-error' | 'policy-error' | 'vault-changed'
export function cloudAccessMessage(reason: CloudAccessReason, chinese: boolean): string {
  const copy:Record<CloudAccessReason,[string,string]>={
    checking:['正在检查当前密码库状态和访问权限…','Checking the current vault status and access policy…'],
    'no-active-vault':['未能识别当前密码库：密码库列表没有当前库标记。请刷新；持续出现时属于插件身份识别错误，不是 GitHub 故障。','The vault list has no current-vault marker. Refresh; if this persists, the plugin could not identify the current vault. This is not a GitHub connection failure.'],
    'ambiguous-active-vault':['密码库身份冲突：列表标记了多个当前库。为避免同步到错误的库，已停止云同步。','The vault list marks more than one current vault. Cloud sync is stopped to avoid using the wrong vault.'],
    'roster-error':['无法读取密码库列表。请重试本机状态检查；尚未连接云端。','The local vault list could not be read. Retry the local status check; no cloud connection was attempted.'],
    'status-error':['无法读取当前密码库的解锁状态。请重试；尚未连接云端。','The current vault lock status could not be read. Retry; no cloud connection was attempted.'],
    'policy-error':['无法读取当前密码库的访问权限。请重试；在确认权限前不会同步。','The current vault access policy could not be read. Retry; sync is blocked until access is confirmed.'],
    'vault-changed':['当前密码库已改变，正在重新检查。旧密码库的检查结果已作废。','The current vault changed. Rechecking it; previous-vault results were discarded.'],
  }
  return copy[reason][chinese?0:1]
}
