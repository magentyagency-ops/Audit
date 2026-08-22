import { webkit } from 'playwright'
const base = process.argv[2]
const out = '/private/tmp/claude-501/-Users-clarencegomis-Downloads-project/d3da9c56-ff31-40a9-a2b8-7c70b3ab184a/scratchpad'
const browser = await webkit.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.fill('#loginEmail', 'diagnostic.temporaire@nira-ia.com')
await page.fill('#loginPassword', 'DiagnosticRelay2026!')
await page.click('#loginForm button[type="submit"]')
await page.waitForTimeout(4500)
await page.screenshot({ path: `${out}/pc-dashboard.png` })
console.log('bureau — barre du haut :', await page.evaluate(`JSON.stringify({
  hauteurBarre: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
  disposition: getComputedStyle(document.querySelector('.topbar')).display,
  actions: getComputedStyle(document.querySelector('.topbar-actions')).display + ' gap ' + getComputedStyle(document.querySelector('.topbar-actions')).gap,
  compteVisible: getComputedStyle(document.querySelector('.account-id')).display
})`))
await page.goto(base + '/workspace.html?project=perfectserve', { waitUntil: 'networkidle' })
await page.waitForTimeout(5000)
await page.screenshot({ path: `${out}/pc-mission.png` })
console.log('bureau — mission :', await page.evaluate(`JSON.stringify({
  hauteurBarre: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
  disposition: getComputedStyle(document.querySelector('.topbar')).display,
  navDefilante: getComputedStyle(document.querySelector('.nav')).overflowX,
  libellesNav: getComputedStyle(document.querySelector('.nav-btn span')).display
})`))
await browser.close()
