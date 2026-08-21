import { Context, Schema, h } from 'koishi'

export const name = 'mars-images'
export const inject = ['database']

export interface Config {
  windowDays: number
  threshold: number
  notify: boolean
  minImageBytes: number
  minImageWidth: number
  minImageHeight: number
  marsMessage: string
  forwardMessage: string
  forwardMaxImages: number
  repeatWindowSeconds: number
  repeatLimit: number
  cooldownSeconds: number
  statsCommand: string
  statsHeader: string
  statsEmpty: string
  statsRow: string
}

export const Config: Schema<Config> = Schema.object({
  windowDays: Schema.number()
    .min(1).max(7).step(1).default(7)
    .description('图片记录窗口(天),范围 1-7'),
  threshold: Schema.number()
    .min(0).max(100).step(1).default(90)
    .description('重复判定相似度阈值(%)'),
  notify: Schema.boolean()
    .default(true)
    .description('火星时是否发提示;关闭后仍正常记录次数'),
  minImageBytes: Schema.number()
    .min(0).max(50 * 1024).step(1).default(0)
    .description('图片最小体积(KB),宽高不达标时检查;设为 0 不限制'),
  minImageWidth: Schema.number()
    .min(1).max(10000).step(1).default(360)
    .description('图片最小宽度(像素),必须大于 0'),
  minImageHeight: Schema.number()
    .min(1).max(10000).step(1).default(360)
    .description('图片最小高度(像素),必须大于 0'),
  marsMessage: Schema.string()
    .default('{at} 火星了！这张图 {time} 由 {user} 发过（你已 {count} 次）')
    .description('火星提示语。占位符:{at}=@对方 {user}=原发送者 {time}=原发送时间 {count}=对方累计火星次数'),
  forwardMessage: Schema.string()
    .default('{at} 火星了！这个转发卡片里的 {n} 张图都发过，最早 {time} 由 {user} 发的（你已 {count} 次）')
    .description('转发卡片火星提示语。占位符:{at}=@对方 {n}=卡片内图片数 {user}=最早发送者 {time}=最早发送时间 {count}=对方累计火星次数'),
  forwardMaxImages: Schema.number()
    .min(1).max(100).step(1).default(30)
    .description('转发卡片最多检测多少张图片,超出部分忽略'),
  repeatWindowSeconds: Schema.number()
    .min(0).max(3600).step(1).default(60)
    .description('复读规避窗口(秒);设为 0 取消规避'),
  repeatLimit: Schema.number()
    .min(3).max(100).step(1).default(3)
    .description('复读规避阈值:同一图片在窗口内被同一人发送达到此次数(含本次)后不计火星;必须大于 2'),
  cooldownSeconds: Schema.number()
    .min(0).max(3600).step(1).default(60)
    .description('火星冷却(秒);同人刚触发火星后在冷却期内再次触发不计火星;设为 0 取消'),
  statsCommand: Schema.string()
    .default('火星统计')
    .description('发送此文本(完全相等)触发统计'),
  statsHeader: Schema.string()
    .default('🔥 火星次数统计：')
    .description('统计标题'),
  statsEmpty: Schema.string()
    .default('还没有人火星过')
    .description('无人火星时的提示'),
  statsRow: Schema.string()
    .default('{user}：{count} 次')
    .description('统计每行。占位符:{user}=昵称 {count}=次数'),
})

interface MarsImageRow {
  id?: number
  gid: string
  hash: string
  userId: string
  userName: string
  time: number
}

interface MarsCountRow {
  id?: number
  gid: string
  userId: string
  name: string
  count: number
}

const HASH_BITS = 64

export function apply(ctx: Context, config: Config) {
  const model = ctx.model as any
  model.extend('mars_image', {
    id: 'unsigned',
    gid: 'string',
    hash: 'string',
    userId: 'string',
    userName: 'string',
    time: 'unsigned',
  }, { autoInc: true })

  model.extend('mars_count', {
    id: 'unsigned',
    gid: 'string',
    userId: 'string',
    name: 'string',
    count: 'unsigned',
  }, { autoInc: true })

  const db = ctx.database as any
  const logger = ctx.logger('mars-images')
  // 阈值(%) -> 允许的最大汉明距离。相似度 = (64 - dist) / 64
  const maxDist = Math.floor((HASH_BITS * (100 - config.threshold)) / 100)

  // 复读规避:key = gid|userId|hash,值为窗口内各次发送时间戳
  const repeatSends = new Map<string, number[]>()
  // 火星冷却:key = gid|userId,值为上次记火星时间戳
  const lastMarsTime = new Map<string, number>()

  function recordRepeatSend(gid: string, userId: string, hash: string, now = Date.now()) {
    const key = `${gid}|${userId}|${hash}`
    const arr = repeatSends.get(key) ?? []
    arr.push(now)
    repeatSends.set(key, arr)
  }

  // 同人同图在窗口内已发送达到 repeatLimit 次(含本次)即视为复读
  function isRepeatSpam(gid: string, userId: string, hash: string, now = Date.now()): boolean {
    if (config.repeatWindowSeconds <= 0) return false
    const key = `${gid}|${userId}|${hash}`
    const arr = repeatSends.get(key) ?? []
    const cutoff = now - config.repeatWindowSeconds * 1000
    const recent = arr.filter((t) => t >= cutoff)
    return recent.length >= config.repeatLimit
  }

  function isCooldown(gid: string, userId: string, now = Date.now()): boolean {
    if (config.cooldownSeconds <= 0) return false
    const last = lastMarsTime.get(`${gid}|${userId}`)
    return !!last && now - last < config.cooldownSeconds * 1000
  }

  function markMars(gid: string, userId: string, now = Date.now()) {
    lastMarsTime.set(`${gid}|${userId}`, now)
  }

  ctx.on('message', async (session) => {
    // 忽略机器人自己的消息,避免自触发
    if (session.userId === session.bot.selfId) return
    const gid = session.gid || session.cid
    const text = (session.content ?? '').trim()

    // 统计指令:文本完全匹配
    if (text && text === config.statsCommand) {
      await sendStats(session, gid)
      return
    }

    const elements = session.elements ?? []
    const imgs = elements.filter((e) => (e.type === 'image' || e.type === 'img') && !isNativeEmoji(e))
    const ignoredEmojiCount = elements.filter((e) => isNativeEmoji(e)).length
    if (ignoredEmojiCount) logger.info(`忽略 ${ignoredEmojiCount} 个原生表情`)
    const forwards = elements.filter((e) => e.type === 'forward')

    if (!imgs.length && !forwards.length) {
      // 有非文本元素却没识别到图片时,打印元素类型辅助排查
      if (elements.some((e) => e.type !== 'text')) {
        logger.info(`未识别到图片,元素类型: ${elements.map((e) => e.type).join(',')}`)
      }
      return
    }

    if (imgs.length) {
      logger.info(`收到 ${imgs.length} 张图片, gid=${gid}`)
      for (const img of imgs) {
        const buf = await extractImage(ctx, img, logger, config)
        if (!buf) {
          logger.warn('图片解析失败,跳过')
          continue
        }
        try {
          const hash = await dHash(buf)
          logger.info(`图片 dHash=${hash}`)
          await processImage(session, gid, hash)
        } catch (e) {
          logger.warn('图片哈希计算失败', e)
        }
      }
    }

    for (const fwd of forwards) {
      const id = fwd.attrs?.id ?? fwd.attrs?.resId
      if (!id) {
        logger.warn('转发卡片缺少 id,跳过')
        continue
      }
      await handleForwardCard(session, gid, String(id))
    }
  })

  async function getWindowRows(gid: string): Promise<MarsImageRow[]> {
    const cutoff = Date.now() - config.windowDays * 24 * 3600 * 1000
    // 清理窗口外旧记录
    await db.remove('mars_image', { gid, time: { $lt: cutoff } })
    const rows = (await db.get('mars_image', { gid, time: { $gt: cutoff } })) as MarsImageRow[]
    logger.info(`窗口内已有 ${rows.length} 张图片`)
    return rows
  }

  function findMatch(hash: string, rows: MarsImageRow[]): { match: MarsImageRow | null; dist: number } {
    let match: MarsImageRow | null = null
    let bestDist = Infinity
    for (const r of rows) {
      const dist = hammingDistance(hash, r.hash)
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist
        match = r
      }
    }
    return { match, dist: bestDist }
  }

  async function saveImage(gid: string, session: any, hash: string, time: number) {
    await db.create('mars_image', {
      gid,
      hash,
      userId: session.userId,
      userName: session.username || session.userId,
      time,
    })
  }

  // 记火星前检查冷却;在冷却期内不计火星,也不发提示
  async function notifyMars(session: any, gid: string, match: MarsImageRow, tpl: string, extra: Record<string, string> = {}) {
    if (isCooldown(gid, session.userId)) {
      logger.info(`火星冷却中,不计入火星`)
      return
    }
    markMars(gid, session.userId)
    const entry = await incMars(gid, session.userId, session.username)
    if (!config.notify) return
    const msg = renderMars(tpl, {
      at: h('at', { id: session.userId }),
      user: match.userName,
      time: formatTime(match.time),
      count: entry.count,
      ...extra,
    })
    await session.send(msg)
  }

  async function processImage(session: any, gid: string, hash: string) {
    recordRepeatSend(gid, session.userId, hash)
    const rows = await getWindowRows(gid)
    const { match, dist } = findMatch(hash, rows)

    if (match) {
      // 复读规避:同人短时间内反复发同一张图,达到阈值后不再计火星
      if (isRepeatSpam(gid, session.userId, hash)) {
        logger.info(`同一图片复读达到 ${config.repeatLimit} 次,不计入火星`)
        return
      }
      logger.info(`命中重复,原发送者 ${match.userName},汉明距离 ${dist}`)
      await notifyMars(session, gid, match, config.marsMessage)
    } else {
      logger.info('未命中,存入新图片记录')
      await saveImage(gid, session, hash, Date.now())
    }
  }

  // 转发卡片:卡片内全部图片都命中重复才算一次火星;否则不算,并把其中的新图片存档
  async function handleForwardCard(session: any, gid: string, id: string) {
    const internal = (session.bot as any)?.internal
    if (typeof internal?.getForwardMsg !== 'function') {
      logger.warn('当前适配器不支持 getForwardMsg,跳过转发卡片检测')
      return
    }

    const segs = await collectForwardImages(internal, id, 0, new Set<string>(), logger)
    if (!segs.length) {
      logger.info(`转发卡片 ${id} 内未找到图片`)
      return
    }
    const limited = segs.slice(0, config.forwardMaxImages)
    if (segs.length > limited.length) {
      logger.info(`转发卡片图片数 ${segs.length} 超过上限 ${config.forwardMaxImages},只检测前 ${limited.length} 张`)
    }
    logger.info(`转发卡片 ${id} 提取到 ${limited.length} 张图片`)

    const hashes: string[] = []
    for (const attrs of limited) {
      const buf = await extractImage(ctx, { attrs }, logger, config)
      if (!buf) {
        logger.warn('转发卡片内图片解析失败,视为未命中')
        continue
      }
      try {
        hashes.push(await dHash(buf))
      } catch (e) {
        logger.warn('转发卡片内图片哈希计算失败', e)
      }
    }
    // 有图片下载/哈希失败时无法确认"全部命中",直接放弃本次判定
    if (hashes.length !== limited.length) {
      logger.warn(`仅成功处理 ${hashes.length}/${limited.length} 张,跳过本次转发卡片判定`)
      return
    }

    const rows = await getWindowRows(gid)
    const results = hashes.map((hash) => ({ hash, ...findMatch(hash, rows) }))
    const matched = results.filter((r) => r.match)

    if (matched.length === results.length) {
      logger.info(`转发卡片 ${results.length} 张图片全部命中重复,记 1 次火星`)
      const earliest = matched.reduce((a, b) => (a.match!.time <= b.match!.time ? a : b))
      await notifyMars(session, gid, earliest.match!, config.forwardMessage, { n: String(results.length) })
    } else {
      logger.info(`转发卡片命中 ${matched.length}/${results.length} 张,不算火星,存档新图片`)
      const now = Date.now()
      for (const r of results) {
        if (!r.match) await saveImage(gid, session, r.hash, now)
      }
    }
  }

  async function incMars(gid: string, uid: string, name: string): Promise<{ count: number; name: string }> {
    const rows = (await db.get('mars_count', { gid, userId: uid })) as MarsCountRow[]
    if (!rows.length) {
      const finalName = name || uid
      await db.create('mars_count', { gid, userId: uid, name: finalName, count: 1 })
      return { count: 1, name: finalName }
    }
    const row = rows[0]
    const count = row.count + 1
    const finalName = name || row.name
    await db.set('mars_count', { id: row.id }, { count, name: finalName })
    return { count, name: finalName }
  }

  async function sendStats(session: any, gid: string) {
    const rows = (await db.get('mars_count', { gid })) as MarsCountRow[]
    if (!rows.length) {
      await session.send(config.statsEmpty)
      return
    }
    rows.sort((a, b) => b.count - a.count)
    const lines = rows.map((e) => renderText(config.statsRow, { user: e.name || e.userId, count: String(e.count) }))
    await session.send(config.statsHeader + '\n' + lines.join('\n'))
  }
}

async function extractImage(ctx: Context, img: any, logger: any, config?: Config): Promise<Buffer | null> {
  const a = img.attrs || {}
  const url = a.url || a.src || a.file
  logger.info(`图片 attrs: ${JSON.stringify(a)}`)
  if (!url) return null
  if (url.startsWith('base64://')) {
    const buf = Buffer.from(url.slice(9), 'base64')
    return (await validateImage(buf, config, logger)) ? buf : null
  }
  if (!/^https?:\/\//.test(url)) {
    logger.warn(`图片 url 非 http/base64,无法下载: ${String(url).slice(0, 120)}`)
    return null
  }
  try {
    const data = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 15000 })
    const buf = toBuffer(data)
    if (!buf) logger.warn('下载结果转 Buffer 失败')
    else logger.info(`图片下载成功, ${buf.length} 字节`)
    if (!buf) return null
    return (await validateImage(buf, config, logger)) ? buf : null
  } catch (e) {
    logger.warn(`图片下载异常: ${String(url).slice(0, 120)}`, e)
    return null
  }
}

function isNativeEmoji(element: any): boolean {
  return ['face', 'mface', 'marketface', 'sticker', 'emoji'].includes(element?.type)
}

async function validateImage(buf: Buffer, config: Config | undefined, logger: any): Promise<boolean> {
  if (!config) return true
  try {
    const Jimp = await loadJimp()
    const img = await Jimp.read(buf)
    const width = img.bitmap.width
    const height = img.bitmap.height
    logger.info(`图片信息: ${buf.length} 字节, ${width}x${height}`)

    const dimensionsTooSmall = width < config.minImageWidth && height < config.minImageHeight
    if (dimensionsTooSmall) {
      logger.info(`图片宽高 ${width}x${height} 均低于最低 ${config.minImageWidth}x${config.minImageHeight},跳过火星检测`)
      return false
    }

    const minBytes = config.minImageBytes * 1024
    if (minBytes > 0 && buf.length < minBytes) {
      logger.info(`图片体积 ${formatBytes(buf.length)} 低于 ${config.minImageBytes} KB,跳过火星检测`)
      return false
    }
    return true
  } catch (e) {
    logger.warn('图片尺寸读取失败,跳过', e)
    return false
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

// 合并转发嵌套层数上限,防止套娃卡片打爆递归
const FORWARD_MAX_DEPTH = 6

// 递归展开合并转发卡片,收集其中全部图片消息段的 data(含 url/file)
async function collectForwardImages(
  internal: any,
  id: string,
  depth: number,
  seen: Set<string>,
  logger: any,
): Promise<any[]> {
  if (depth > FORWARD_MAX_DEPTH || seen.has(id)) return []
  seen.add(id)

  let messages: any
  try {
    messages = await internal.getForwardMsg(id)
  } catch (e) {
    logger.warn(`获取转发卡片 ${id} 内容失败`, e)
    return []
  }
  if (!Array.isArray(messages)) {
    logger.warn(`转发卡片 ${id} 返回结构异常: ${JSON.stringify(messages).slice(0, 200)}`)
    return []
  }

  // 诊断:打印展开结构和原始内容,便于排查抓取不到图片的问题
  logger.info(`转发卡片 ${id} 展开 ${messages.length} 条`)
  for (const msg of messages.slice(0, 3)) {
    logger.info(`  转发消息原始: ${JSON.stringify(msg?.message ?? msg?.content ?? msg).slice(0, 300)}`)
  }

  const out: any[] = []
  for (const msg of messages) {
    // go-cqhttp 用 content,NapCat/LLOneBot 用 message;取非空的那个
    out.push(...(await collectSegmentImages(internal, pickSegments(msg), depth, seen, logger)))
  }
  return out
}

// 兼容不同适配器对转发内单条消息的字段差异,取有内容的那个
function pickSegments(msg: any): any {
  const c = msg?.content
  const m = msg?.message
  if (Array.isArray(m) && m.length) return m
  if (Array.isArray(c) && c.length) return c
  if (typeof m === 'string' && m.trim()) return m
  if (typeof c === 'string' && c.trim()) return c
  return m ?? c
}

async function collectSegmentImages(
  internal: any,
  content: any,
  depth: number,
  seen: Set<string>,
  logger: any,
): Promise<any[]> {
  const out: any[] = []
  for (const seg of parseSegments(content)) {
    if (seg.type === 'image') {
      out.push(seg.data || {})
      continue
    }
    if (seg.type !== 'forward' && seg.type !== 'node') continue
    // 部分实现直接内联嵌套内容,无需再请求
    const inline = seg.data?.content ?? seg.data?.message
    if (inline) {
      out.push(...(await collectSegmentImages(internal, inline, depth + 1, seen, logger)))
      continue
    }
    // 嵌套卡片按 id 展开;兼容 id / res_id / resId 三种字段
    const rid = seg.data?.id ?? seg.data?.res_id ?? seg.data?.resId
    if (rid) {
      out.push(...(await collectForwardImages(internal, String(rid), depth + 1, seen, logger)))
    }
  }
  return out
}

// content 可能是 CQ 码字符串(go-cqhttp)、消息段数组(NapCat 等)或 JSON 编码的数组字符串
function parseSegments(content: any): Array<{ type: string; data: any }> {
  if (Array.isArray(content)) {
    const segs: Array<{ type: string; data: any }> = []
    for (const s of content) {
      if (!s || typeof s !== 'object') continue
      // 标准消息段 {type,data}
      if (s.type) {
        segs.push({ type: s.type, data: s.data ?? {} })
        continue
      }
      // 原始消息对象(嵌套卡片的 content/getForwardMsg 返回):取其 message/content 字段当 node 递归
      const inner = s.message ?? s.content
      if (inner) segs.push({ type: 'node', data: { content: inner } })
    }
    return segs
  }
  if (typeof content !== 'string') return []

  // 部分实现把 content 序列化成 JSON 数组字符串
  if (content.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) return parseSegments(parsed)
    } catch {
      // 不是合法 JSON,走 CQ 码解析
    }
  }

  const segs: Array<{ type: string; data: any }> = []
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^,\]]*)*)\]/g
  let cap: RegExpExecArray | null
  while ((cap = pattern.exec(content))) {
    const data: Record<string, string> = {}
    for (const pair of cap[2].split(',')) {
      if (!pair) continue
      const i = pair.indexOf('=')
      if (i < 0) continue
      data[pair.slice(0, i)] = unescapeCQ(pair.slice(i + 1))
    }
    segs.push({ type: cap[1], data })
  }
  return segs
}

function unescapeCQ(s: string): string {
  return s
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

function toBuffer(data: any): Buffer | null {
  if (data && typeof data === 'object' && 'data' in data) data = data.data
  if (Buffer.isBuffer(data)) return data
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'binary')
  return null
}

async function loadJimp(): Promise<any> {
  // jimp 0.22 是 CJS(module.exports=Jimp 且带 .default 自引用),1.x 是 ESM。
  // 兼容 default 导出 / 命名 Jimp 导出 / babel 双重包装。
  const mod: any = await import('jimp')
  let Jimp = mod.default ?? mod.Jimp ?? mod
  if (Jimp && typeof Jimp.read !== 'function' && Jimp.default) Jimp = Jimp.default
  return Jimp
}

async function dHash(buf: Buffer): Promise<string> {
  const Jimp = await loadJimp()
  const img = await Jimp.read(buf)
  const data: any = img.bitmap.data
  const w: number = img.bitmap.width
  const h: number = img.bitmap.height

  // 纯 JS 缩放到 9x8 并转灰度,不依赖 jimp 的 grayscale/resize(各版本 API 不一致)
  const gray = new Float64Array(9 * 8)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / 9))
      const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / 8))
      const i = (sy * w + sx) * 4
      gray[y * 9 + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
  }

  let bits = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? '1' : '0'
    }
  }
  return bits
}

function hammingDistance(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

function renderMars(tpl: string, vars: { at: any; user: string; time: string; count: number; [k: string]: any }): any {
  const text = tpl.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (k === 'at') return `<at id="${vars.at.attrs.id}"/>`
    if (k in vars) return String(vars[k])
    return m
  })
  return h.parse(text)
}

function renderText(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)
}

function formatTime(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}
