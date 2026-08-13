import { Context, Schema, h } from 'koishi'

export const name = 'mars-images'
export const inject = ['database']

export interface Config {
  windowDays: number
  threshold: number
  notify: boolean
  marsMessage: string
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
  marsMessage: Schema.string()
    .default('{at} 火星了！这张图 {time} 由 {user} 发过（你已 {count} 次）')
    .description('火星提示语。占位符:{at}=@对方 {user}=原发送者 {time}=原发送时间 {count}=对方累计火星次数'),
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
    const imgs = elements.filter((e) => e.type === 'image' || e.type === 'img')
    if (!imgs.length) {
      // 有非文本元素却没识别到图片时,打印元素类型辅助排查
      if (elements.some((e) => e.type !== 'text')) {
        logger.info(`未识别到图片,元素类型: ${elements.map((e) => e.type).join(',')}`)
      }
      return
    }
    logger.info(`收到 ${imgs.length} 张图片, gid=${gid}`)

    for (const img of imgs) {
      const buf = await extractImage(ctx, img, logger)
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
  })

  async function processImage(session: any, gid: string, hash: string) {
    const now = Date.now()
    const windowMs = config.windowDays * 24 * 3600 * 1000
    const cutoff = now - windowMs

    // 清理窗口外旧记录
    await db.remove('mars_image', { gid, time: { $lt: cutoff } })

    const rows = (await db.get('mars_image', { gid, time: { $gt: cutoff } })) as MarsImageRow[]
    logger.info(`窗口内已有 ${rows.length} 张图片`)

    let match: MarsImageRow | null = null
    let bestDist = Infinity
    for (const r of rows) {
      const dist = hammingDistance(hash, r.hash)
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist
        match = r
      }
    }

    if (match) {
      logger.info(`命中重复,原发送者 ${match.userName},汉明距离 ${bestDist}`)
      const entry = await incMars(gid, session.userId, session.username)
      if (config.notify) {
        const msg = renderMars(config.marsMessage, {
          at: h('at', { id: session.userId }),
          user: match.userName,
          time: formatTime(match.time),
          count: entry.count,
        })
        await session.send(msg)
      }
    } else {
      logger.info('未命中,存入新图片记录')
      await db.create('mars_image', {
        gid,
        hash,
        userId: session.userId,
        userName: session.username || session.userId,
        time: now,
      })
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

async function extractImage(ctx: Context, img: any, logger: any): Promise<Buffer | null> {
  const a = img.attrs || {}
  const url = a.url || a.src || a.file
  logger.info(`图片 attrs: ${JSON.stringify(a)}`)
  if (!url) return null
  if (url.startsWith('base64://')) return Buffer.from(url.slice(9), 'base64')
  if (!/^https?:\/\//.test(url)) {
    logger.warn(`图片 url 非 http/base64,无法下载: ${String(url).slice(0, 120)}`)
    return null
  }
  try {
    const data = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 15000 })
    const buf = toBuffer(data)
    if (!buf) logger.warn('下载结果转 Buffer 失败')
    else logger.info(`图片下载成功, ${buf.length} 字节`)
    return buf
  } catch (e) {
    logger.warn(`图片下载异常: ${String(url).slice(0, 120)}`, e)
    return null
  }
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

function renderMars(tpl: string, vars: { at: any; user: string; time: string; count: number }): any {
  const text = tpl.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (k === 'at') return `<at id="${vars.at.attrs.id}"/>`
    if (k === 'user') return vars.user
    if (k === 'time') return vars.time
    if (k === 'count') return String(vars.count)
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
