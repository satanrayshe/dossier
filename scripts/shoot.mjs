import { chromium } from 'playwright'
const npub = process.argv[2] ?? 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
const tag = process.argv[3] ?? 'a'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))
await page.goto('http://localhost:4173/')
await page.screenshot({ path: `shots/${tag}-landing.png` })
await page.fill('#subject', npub)
await page.click('button[type=submit]')
await page.waitForSelector('text=File complete', { timeout: 120000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `shots/${tag}-cover.png` })
await page.screenshot({ path: `shots/${tag}-full.png`, fullPage: true })
for (const id of ['time', 'messages', 'money', 'social', 'relays', 'burn']) {
  await page.locator('#' + id).scrollIntoViewIfNeeded()
  await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), id)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `shots/${tag}-${id}.png` })
}
console.log('errors:', errors.slice(0, 10))
await browser.close()
