import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Splices each page's body into one shared frame at boot.
 *
 * Every page used to carry its own copy of the `<head>`, the icon sprite and a
 * 返回 button, and only the dashboard had the sidebar -- so navigating anywhere
 * threw the frame away and handed back a bare document. The frame is the
 * application; the page is the part that differs.
 *
 * Done on the server rather than by injecting the sidebar from JavaScript: the
 * frame is then present in the first byte of HTML, so it cannot flash in after
 * paint, and it stays ordinary markup in an ordinary file instead of a string
 * inside a script.
 *
 * Deliberately *not* a single-page app swapping `<main>` over fetch. The board
 * holds an EventSource and the dashboard two intervals; client-side routing
 * would make tearing those down on every navigation a correctness requirement,
 * and leaking one is invisible until the tab has been open an hour. A full
 * document load costs milliseconds here and has no such failure mode.
 */

export interface PageDef {
  /** Fragment filename under `public/pages`. */
  file: string
  title: string
  /** Page-specific stylesheets, in addition to the shared `style.css`. */
  css: string[]
  /** Page-specific module, if the page needs one beyond the shell. */
  script: string | null
  /**
   * Extra class on `<main class="content">`.
   *
   * The board sets `content-flush` because it supplies its own full-bleed
   * padding and a sticky header, which the standard content padding would
   * inset and break.
   */
  contentClass: string
}

export const PAGES: Record<string, PageDef> = {
  // Titles carry the product name, not the repository name: "Oh! dsh" is the
  // brand (ohdsh.com), and `ohdsh` is its technical spelling wherever `!` is
  // not a legal character -- package name, CLI, cookie prefix.
  // `wide` buys these a roomier column than the old home page's reading width:
  // a month of daily bars and a cron's full prompt both need it.
  spend: { file: 'spend.html', title: '花费 · Oh! dsh', css: ['spend.css'], script: 'spend.js', contentClass: 'wide' },
  crons: {
    file: 'crons.html',
    title: '定时任务 · Oh! dsh',
    css: ['spend.css', 'crons.css'],
    script: 'crons.js',
    contentClass: 'wide',
  },
  // The other half of archiving: without a place to see what was archived, a
  // soft delete is indistinguishable from a real one.
  archive: {
    file: 'archive.html',
    title: '已归档 · Oh! dsh',
    css: [],
    script: 'archive.js',
    contentClass: 'wide',
  },
  board: {
    file: 'board.html',
    title: '大盘 · Oh! dsh',
    css: ['board.css'],
    script: 'board.js',
    contentClass: 'content-flush',
  },
  // `content-flush` for the same reason as the board, plus one of its own: the
  // composer is pinned to the bottom of the column, so the page owns its full
  // height and cannot be inset by the standard content padding.
  chat: {
    file: 'chat.html',
    title: '对话 · Oh! dsh',
    css: ['chat.css'],
    script: 'chat.js',
    contentClass: 'content-flush',
  },
  // 蜂群 Q4：节点（fleet）总览——侧栏只留汇总与异常，完整列表在这里。
  nodes: {
    file: 'nodes.html',
    title: '节点 · Oh! dsh',
    css: [],
    script: 'nodes.js',
    contentClass: 'wide',
  },
  // 蜂群 P5.2：技能清单（v1 只读——文件即真相 + 版本对照）。
  skills: {
    file: 'skills.html',
    title: '技能 · Oh! dsh',
    css: [],
    script: 'skills.js',
    contentClass: 'wide',
  },
}

const PLACEHOLDERS = ['{{TITLE}}', '{{HEAD}}', '{{CONTENT_CLASS}}', '{{CONTENT}}', '{{SCRIPT}}'] as const

/**
 * Content hash for every `/assets/...` URL in a page.
 *
 * Without it a stylesheet change is invisible until the browser decides to ask
 * again, and "I changed the CSS but the page did not" is indistinguishable from
 * "my CSS is wrong" -- which cost a real debugging session. Hashing the contents
 * rather than stamping the boot time means the URL only moves when the file
 * actually did, so an unchanged asset stays cached across restarts.
 *
 * This rewrites the whole rendered page, so the layout's own hardcoded
 * `style.css` and `shell.js` are covered by the same pass as the per-page ones.
 * What it cannot reach is one module importing another (`shell.js` importing
 * `./ui.js`), which is why /assets is also served must-revalidate.
 */
const ASSET_URL = /\/assets\/([A-Za-z0-9._-]+\.(?:css|js))/g

const stampAssets = (html: string, publicDir: string): string => {
  const versions = new Map<string, string>()
  return html.replace(ASSET_URL, (whole, file: string) => {
    let version = versions.get(file)
    if (version === undefined) {
      try {
        version = createHash('sha1').update(readFileSync(join(publicDir, 'assets', file))).digest('hex').slice(0, 8)
      } catch {
        // A reference to a file that is not there is a broken page either way;
        // leaving it unversioned keeps the error about the 404, not about this.
        version = ''
      }
      versions.set(file, version)
    }
    return version === '' ? whole : `${whole}?v=${version}`
  })
}

/**
 * Sent with every /assets response.
 *
 * Lives here rather than inline at the registration because that inline version
 * called `res.setHeader` -- @fastify/static hands `setHeaders` a FastifyReply,
 * not a raw ServerResponse, so the server crashed on the first stylesheet
 * request. Nothing caught it: no test had ever fetched an asset. Now this is a
 * named function a test can call.
 *
 * `no-cache` is "keep it, but ask before using it", not "do not keep it": the
 * answer is a 304, not a re-download.
 */
export const assetCacheHeaders = (reply: { header: (name: string, value: string) => unknown }): void => {
  reply.header('cache-control', 'no-cache')
}

const render = (layout: string, def: PageDef, fragment: string): string => {
  const head = def.css.map((href) => `<link rel="stylesheet" href="/assets/${href}" />`).join('\n    ')
  const script = def.script === null ? '' : `<script src="/assets/${def.script}" type="module"></script>`
  return layout
    .replace('{{TITLE}}', def.title)
    .replace('{{HEAD}}', head)
    .replace('{{CONTENT_CLASS}}', def.contentClass)
    // Last, and via a function: a fragment containing `$&` or `$1` would
    // otherwise be interpreted as a replacement pattern and silently mangled.
    .replace('{{CONTENT}}', () => fragment)
    .replace('{{SCRIPT}}', script)
}

/**
 * Builds every page once.
 *
 * Rendering at boot rather than per request means a missing fragment or a
 * renamed placeholder fails at startup with a clear message, instead of serving
 * a broken page to whoever happens to open it first.
 */
export const buildPages = (publicDir: string): Map<string, string> => {
  const layout = readFileSync(join(publicDir, 'layout.html'), 'utf8')
  for (const token of PLACEHOLDERS) {
    if (!layout.includes(token)) throw new Error(`layout.html is missing the ${token} placeholder`)
  }

  const out = new Map<string, string>()
  for (const [name, def] of Object.entries(PAGES)) {
    const fragment = readFileSync(join(publicDir, 'pages', def.file), 'utf8')
    const html = stampAssets(render(layout, def, fragment), publicDir)
    // Catches a typo'd placeholder that would otherwise reach the browser as
    // literal braces on the page.
    const leftover = html.match(/\{\{[A-Z_]+\}\}/)
    if (leftover !== null) throw new Error(`page "${name}" still contains ${leftover[0]} after rendering`)
    out.set(name, html)
  }
  return out
}
