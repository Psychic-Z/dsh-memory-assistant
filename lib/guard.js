/**
 * 凭据 / 敏感信息闸门（2026-11-17，借鉴 memfuse 的 guard.js）
 *
 * 为什么要有：记忆是扩散性最强的东西——它会被检索出来注入上下文、写进日志、
 * 导出成文件。凭据一旦写进记忆，等于复制到上面每一个地方，**而且你不会知道**。
 *
 * 策略（与 memfuse 一致的部分）：
 *   - 显式写入：**拒绝**，只报「命中了哪一类」，**不回显命中内容**
 *   - 自动抽取：**替换成占位符**，不整卡丢弃（丢整卡会连带丢掉同一段里其他信息）
 *
 * 宁可误拒一条，也不要静默泄露一次。
 */

const PATTERNS = [
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI 风格密钥', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub Token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['Bearer Token', /\bBearer\s+[A-Za-z0-9._-]{20,}/i],
  ['连接串内含口令', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{3,}@/i],
  ['内网 IP', /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/],
  ['疑似口令赋值', /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}/i],
]

const PLACEHOLDER = '[已隐去：疑似凭据]'

/** 检查一段文本，返回命中的类别名（不回显内容） */
export function scan(text) {
  const s = String(text || '')
  const hits = []
  for (const [label, re] of PATTERNS) {
    if (re.test(s)) hits.push(label)
  }
  return hits
}

/** 显式写入用：有命中就不许写 */
export function checkWrite(text) {
  const hits = scan(text)
  return hits.length ? { ok: false, hits } : { ok: true, hits: [] }
}

/**
 * 自动抽取用：把凭据替换成占位符，保留同段其他内容。
 * 返回 { text, redacted: 类别数组 }。
 */
export function redact(text) {
  let s = String(text || '')
  const redacted = []
  for (const [label, re] of PATTERNS) {
    if (re.test(s)) {
      redacted.push(label)
      s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), PLACEHOLDER)
    }
  }
  return { text: s, redacted }
}

/** 卡片的可扫描文本 */
export function cardText(card) {
  return [
    card.title,
    card.one_line,
    ...(card.outline || []),
    ...(card.keywords || []),
    ...(card.topics || []),
    card.pointer?.quote,
    card.pointer?.u,
  ]
    .filter(Boolean)
    .join(' ')
}

export const CREDENTIAL_PLACEHOLDER = PLACEHOLDER
export const CREDENTIAL_PATTERN_COUNT = PATTERNS.length
