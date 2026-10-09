import { expect, test, type Request } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_WEEKS,
  allocCell,
  capButton,
  capacityFrom,
  cellText,
  deferred,
  editor,
  editorHint,
  editorInput,
  expectCell,
  expectWeeks,
  isCapacityGet,
  isPatch,
  openEditor,
  openRange,
  overCounts,
  routeApi,
  settle,
  sleep,
  summaryCounts,
} from './helpers'

const DEE = { id: 4, name: 'Dee Okafor' }
const DEE_AT_50 = JSON.stringify({ id: 4, name: 'Dee Okafor', weeklyHours: 50 })

test('save failure (500) leaves the grid untouched; Retry applies the confirmed value without refetching', async ({
  page,
}) => {
  const gets: Request[] = []
  page.on('request', (req) => {
    if (isCapacityGet(req)) gets.push(req)
  })
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  const before = await summaryCounts(page)
  // React StrictMode (dev) mounts twice, so the initial load may be 2 GETs (the
  // first aborted). What matters is that the save adds none.
  const getsAfterLoad = gets.length
  expect(getsAfterLoad).toBeGreaterThanOrEqual(1)

  let patchMode: 'fail' | 'ok' = 'fail'
  const patches: string[] = []
  await routeApi(page, async (route, req) => {
    if (!isPatch(req, DEE.id)) return false
    patches.push(req.postData() ?? '')
    if (patchMode === 'fail') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"could not update person"}' })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: DEE_AT_50 })
    }
    return true
  })

  await openEditor(page, DEE.name)
  await editorInput(page, DEE.name).fill('50')
  await editor(page).getByRole('button', { name: 'Save' }).click()

  await expect(editorHint(page)).toHaveText('Not saved. could not update person')
  await expect(editor(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(editorInput(page, DEE.name)).toHaveValue('50')
  // Nothing in the grid moved.
  await expect(capButton(page, DEE.name)).toHaveText('40h')
  await expectCell(page, DEE.name, 1, '45 +5', 'over')
  await expect.poll(() => overCounts(page)).toEqual(['39 over', '15 over', 'none over'])
  expect(await summaryCounts(page)).toEqual(before)
  expect(patches).toEqual([JSON.stringify({ weeklyHours: 50 })])

  patchMode = 'ok'
  await editor(page).getByRole('button', { name: 'Retry', exact: true }).click()

  await expect(editor(page)).toHaveCount(0)
  await expect(capButton(page, DEE.name)).toHaveText('50h')
  await expectCell(page, DEE.name, 1, '45', 'under')
  await expectCell(page, DEE.name, 2, '40', 'under')
  await expect.poll(() => overCounts(page)).toEqual(['39 over', '14 over', 'none over'])
  expect(await summaryCounts(page)).toEqual({ over: before.over - 1, total: before.total })
  expect(patches).toHaveLength(2)

  await sleep(300)
  expect(gets.length).toBe(getsAfterLoad)
})

test('save network abort says the save could not be confirmed (it may have been stored)', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await routeApi(page, async (route, req) => {
    if (!isPatch(req)) return false
    await route.abort('connectionreset')
    return true
  })

  await openEditor(page, DEE.name)
  await editorInput(page, DEE.name).fill('50')
  await editorInput(page, DEE.name).press('Enter')

  await expect(editorHint(page)).toHaveText(
    /^Couldn't confirm the save, so it may or may not have been stored\. Retrying is safe\. \(Couldn't reach the server/,
  )
  await expect(editorHint(page)).not.toContainText('Not saved')
  await expect(editor(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(capButton(page, DEE.name)).toHaveText('40h')
  await expectCell(page, DEE.name, 1, '45 +5', 'over')
})

test('validation: empty and out-of-range input show a message and send no PATCH', async ({ page }) => {
  const patches: Request[] = []
  page.on('request', (req) => {
    if (isPatch(req)) patches.push(req)
  })
  // Belt and braces: never let a PATCH reach the real database from this test.
  await routeApi(page, async (route, req) => {
    if (!isPatch(req)) return false
    await route.fulfill({ status: 200, contentType: 'application/json', body: DEE_AT_50 })
    return true
  })
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)
  await openEditor(page, DEE.name)
  const input = editorInput(page, DEE.name)

  await input.fill('')
  await input.press('Enter')
  await expect(editorHint(page)).toHaveText('Enter the weekly hours.')

  await input.fill('169')
  await input.press('Enter')
  await expect(editorHint(page)).toHaveText('Weekly hours must be between 0 and 168.')

  await input.fill('169')
  await editor(page).getByRole('button', { name: /^(Save|Retry)$/ }).click()
  await expect(editorHint(page)).toHaveText('Weekly hours must be between 0 and 168.')

  await sleep(300)
  expect(patches).toHaveLength(0)
  await expect(capButton(page, DEE.name)).toHaveText('40h')
})

test('a load sent before a save was confirmed does not undo the save', async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  let lateDelivered = false
  await routeApi(page, async (route, req) => {
    if (isPatch(req, DEE.id)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: DEE_AT_50 })
      return true
    }
    if (isCapacityGet(req) && capacityFrom(req) === '2026-01-05') {
      const response = await route.fetch()
      const json = await response.json()
      const dee = json.people.find((p: { id: number }) => p.id === DEE.id)
      dee.weeklyHours = 40
      await sleep(1500)
      await settle(() => route.fulfill({ response, json }))
      lateDelivered = true
      return true
    }
    return false
  })

  await page.getByRole('button', { name: 'Next week' }).click()
  await expect(page.locator('.scroller')).toHaveClass(/\bstale\b/)

  await openEditor(page, DEE.name)
  await editorInput(page, DEE.name).fill('50')
  await editorInput(page, DEE.name).press('Enter')
  await expect(capButton(page, DEE.name)).toHaveText('50h')
  expect(lateDelivered).toBe(false) // the save really did land before the load

  await expectWeeks(page, ['5 Jan', '12 Jan', '19 Jan'])
  await expect.poll(() => lateDelivered).toBe(true)
  await sleep(300)
  await expect(capButton(page, DEE.name)).toHaveText('50h')
  // 5 Jan is now the first column: 45 of 50 is under, not over.
  await expectCell(page, DEE.name, 0, '45', 'under')
  expect(await cellText(allocCell(page, DEE.name, 0))).not.toContain('+')
})

test("while a save is in flight, other people's capacity buttons are disabled", async ({ page }) => {
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  const hold = deferred()
  let patchSeen = false
  await routeApi(page, async (route, req) => {
    if (!isPatch(req, DEE.id)) return false
    patchSeen = true
    await hold.promise
    await settle(() => route.fulfill({ status: 200, contentType: 'application/json', body: DEE_AT_50 }))
    return true
  })

  try {
    await openEditor(page, DEE.name)
    await editorInput(page, DEE.name).fill('50')
    await editorInput(page, DEE.name).press('Enter')
    await expect.poll(() => patchSeen).toBe(true)
    await expect(editor(page).getByRole('button', { name: 'Saving…' })).toBeVisible()

    await expect(capButton(page, 'Bo Lindqvist')).toBeDisabled()
    await expect(capButton(page, 'Ana Ferreira')).toBeDisabled()
  } finally {
    hold.release()
  }

  await expect(capButton(page, DEE.name)).toHaveText('50h')
  await expect(capButton(page, 'Bo Lindqvist')).toBeEnabled()
})
