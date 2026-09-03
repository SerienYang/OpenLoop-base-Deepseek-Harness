# Openloop API 密钥遮罩与更新入口设计

## 背景

Openloop 将 API 密钥明文限制在 macOS 原生安全 Sheet 和 Keychain 内。主
WebView 只接收凭据引用及 `configured`、`source`、`writable` 状态。

当前模型设置存在两个体验问题：

1. 已配置的密钥没有稳定的遮罩表示，用户无法直观看出该提供方已有密钥。
2. Host 已返回 `credentialRef` 时，pi-ai 编辑器仍只检查已脱敏的
   `apiKeyEnv`。由于 Openloop 设置接口会移除该字段，火山方舟 Agent Plan
   无法渲染“添加/更新 API 密钥”控件。

## 已确认方案

采用方案 A“凭据条”。

提供方编辑卡顶部显示一行凭据状态：

```text
API 密钥    **** **** **** ****    [更新]
            ● 已安全保存到 macOS 钥匙串
```

- 遮罩为固定 UI 常量，不来自真实密钥。
- 遮罩不反映真实长度，也不显示任何前缀或后四位。
- 已配置时显示“更新”；未配置时显示“添加”。
- Keychain 中已配置且可写时保留删除入口。
- 不增加显示、复制或回填密钥的能力。

## 状态

### 读取中

- 显示“正在读取凭据状态”。
- 更新和删除操作不可用。

### 已配置

- Keychain 来源显示固定遮罩 `**** **** **** ****`。
- Keychain 来源显示“已安全保存到 macOS 钥匙串”。
- Keychain 来源可写时显示“更新”和“删除”。
- 环境变量或旧凭据文件返回 `configured: true` 时，显示对应的
  “由环境变量提供（只读）”或“由旧凭据文件提供（只读）”，不得显示
  “尚未配置”。
- 只读来源不显示遮罩和修改操作，避免把不可由当前控件管理的来源误认为
  Keychain 凭据。

### 未配置

- 不显示伪造遮罩，显示“尚未配置 API 密钥”。
- 可写时显示“添加 API 密钥”。

### 读取或更新失败

- 保留最后一次成功状态。
- 显示现有本地化错误和重试入口。
- 错误文本不得包含凭据引用或密钥内容。

## 更新流程

1. 用户在提供方编辑卡点击“更新 API 密钥”。
2. 主 WebView 只发送 Host 已批准的凭据引用。
3. macOS 原生安全 Sheet 接收新密钥并写入 Keychain。
4. Sheet 返回 `saved` 或 `cancelled`，不返回密钥。
5. 保存成功后刷新 Models 快照与凭据状态。
6. 页面继续显示同一固定遮罩，并标记密钥已安全保存。

取消操作不改变当前状态。更新失败时保留旧状态并允许重试。

## 代码调整

### ProviderEditor

pi-ai 凭据控件的渲染条件应接受两种已注册来源：

1. Host 在 provider 目录中返回的 `credentialRef`。
2. 非 Openloop 产品中仍可见的 profile `apiKeyEnv`。

判断逻辑应等价于：

```ts
props.credentialRef !== undefined
  || stringAt(fallback, 'apiKeyEnv') !== undefined
```

这只修正渲染条件，不放宽设置字段读取策略。

### CredentialControl

- 已配置状态新增固定遮罩。
- 继续使用现有 `describeCredential`、
  `openCredentialReplacement` 和 `unsetCredential` Host facade。
- 不新增远程方法，不读取密钥值。
- 更新按钮继续打开现有原生安全 Sheet。

## 安全边界

- 主 WebView 不得接收真实密钥、密钥长度或任何密钥片段。
- Host 批准的 `credentialRef` 可以作为不透明路由标识存在于客户端内存并
  发送回 Host，但不得渲染到 DOM、日志、错误文本或可复制内容。
- 不显示后四位，不提供眼睛图标、复制按钮或“显示密钥”操作。
- `apiKeyEnv`、`baseURL` 和其他受限字段继续由 Host 设置策略过滤。
- Keychain 服务名、账户命名和凭据迁移逻辑保持不变。
- 不修改 CI、安全策略或浏览器 Remote allowlist。

## 测试

### 组件回归

1. pi-ai namespace 的 `apiKeyEnv` 已脱敏，但 provider 条目带
   `credentialRef` 时，Host 凭据控件必须渲染。
2. 已配置状态显示固定遮罩、Keychain 来源和“更新 API 密钥”。
3. 未配置状态不显示遮罩，显示“添加 API 密钥”。
4. 页面中不存在 password input、可见凭据引用或密钥片段；测试同时确认
   DOM 文本不包含 `credentialRef`。
5. 更新成功后状态刷新，遮罩保持固定。
6. 取消或失败不清空最后一次成功状态。
7. 环境变量和旧凭据文件来源显示为已提供但只读，不显示 Keychain 遮罩或
   更新、删除操作。

### 桌面集成

1. 组装后的浏览器集成场景用确定性的 Keychain 状态验证固定遮罩和更新入口。
2. 真实 Tauri 场景打开火山方舟 Agent Plan 编辑卡，点击当前可用的添加或
   更新入口，并验证它触发附着在 Openloop 主窗口上的原生凭据 Sheet。
3. 两类场景都验证主 WebView 中不出现明文；真实 Tauri 场景不预置或覆盖
   开发者系统钥匙串中的现有测试凭据。

## 验收标准

- 用户能在模型设置中明确判断某个提供方是否已有 API 密钥。
- 用户能从同一位置添加、更新或删除可写 Keychain 凭据。
- 火山方舟 Agent Plan 在 `apiKeyEnv` 被 Host 脱敏时仍显示凭据控件。
- 页面显示的遮罩始终为 `**** **** **** ****`。
- 主 WebView、日志和错误中不出现任何密钥值或密钥片段。
