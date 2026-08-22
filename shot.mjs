import { webkit, devices } from 'playwright'

const base = process.argv[2] || 'https://audit-five-psi.vercel.app'
const out = '/private/tmp/claude-501/-Users-clarencegomis-Downloads-project/d3da9c56-ff31-40a9-a2b8-7c70b3ab184a/scratchpad'
const suffix = process.argv[3] || 'avant'
const browser = await webkit.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro'] })
const page = await context.newPage()

await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.screenshot({ path: `${out}/m-${suffix}-1-connexion.png` })
await page.fill('#loginEmail', 'diagnostic.temporaire@nira-ia.com')
await page.fill('#loginPassword', 'DiagnosticRelay2026!')
await page.click('#loginForm button[type="submit"]')
await page.waitForTimeout(5000)
await page.screenshot({ path: `${out}/m-${suffix}-2-dashboard.png` })

await page.goto(base + '/workspace.html?project=perfectserve', { waitUntil: 'networkidle' })
await page.waitForTimeout(6000)
await page.screenshot({ path: `${out}/m-${suffix}-3-mission.png` })
await page.click('[data-view="interviews"]'); await page.waitForTimeout(900)
await page.screenshot({ path: `${out}/m-${suffix}-4-entretiens.png` })
await page.click('[data-view="assistant"]'); await page.waitForTimeout(900)
await page.screenshot({ path: `${out}/m-${suffix}-5-assistant.png` })
await page.click('[data-view="map"]'); await page.waitForTimeout(900)
await page.screenshot({ path: `${out}/m-${suffix}-6-carto.png` })
await page.click('[data-view="calendar"]'); await page.waitForTimeout(1200)
await page.screenshot({ path: `${out}/m-${suffix}-7-agenda.png` })

const debord = await page.evaluate(`JSON.stringify({
  largeurEcran: window.innerWidth,
  largeurDocument: document.documentElement.scrollWidth,
  debordement: document.documentElement.scrollWidth - window.innerWidth
})`)
console.log('débordement horizontal :', debord)
await browser.close()
