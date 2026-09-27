import { chromium } from 'playwright'
const BASE = 'https://satanrayshe.github.io/dossier/'
const browser = await chromium.launch()
const errors = []
async function file(npub, shots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(BASE)
  await page.fill('#subject', npub)
  await page.click('button[type=submit]')
  await page.waitForSelector('text=File complete', { timeout: 150000 })
  await page.waitForTimeout(800)
  for (const [name, sel] of shots) {
    await page.evaluate((sel) => { const el = document.querySelector(sel); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 12) }, sel)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `shots/final-${name}.png` })
  }
  await page.close()
}
// landing + cover image + logo
const p = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await p.goto(BASE)
await p.waitForTimeout(500)
await p.screenshot({ path: 'shots/final-landing.png' })
await p.setViewportSize({ width: 512, height: 512 })
await p.setContent(`<body style="margin:0;background:#f2eee4">${await (await fetch(BASE + 'favicon.svg')).text()}</body>`)
await p.evaluate(() => { const s = document.querySelector('svg'); s.setAttribute('width', '512'); s.setAttribute('height', '512') })
await p.screenshot({ path: 'shots/logo.png' })
await p.close()
await file('npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', [['cover', '.file-head'], ['money', '#money'], ['social', '#social .panel']])
await file('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', [['time', '#time'], ['messages', '#messages'], ['relays', '#relays']])
console.log('errors', errors)
await browser.close()
