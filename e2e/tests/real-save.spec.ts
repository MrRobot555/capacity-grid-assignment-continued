import { expect, test } from '@playwright/test'
import {
  FIXTURE,
  FIXTURE_WEEKS,
  capButton,
  editor,
  editorInput,
  expectCell,
  isPatch,
  openEditor,
  openRange,
} from './helpers'

// The one unmocked save: it writes to the real database, so it always puts
// Cem Aydin back to his seeded 20h, pass or fail.
const CEM = { id: 3, name: 'Cem Aydin', seeded: 20 }

async function cemHours(request: import('@playwright/test').APIRequestContext): Promise<number> {
  const res = await request.get(`/api/capacity?from=${FIXTURE.from}&to=${FIXTURE.to}`)
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { people: { id: number; weeklyHours: number }[] }
  return body.people.find((p) => p.id === CEM.id)!.weeklyHours
}

test.afterEach(async ({ request }) => {
  const res = await request.patch(`/api/people/${CEM.id}`, { data: { weeklyHours: CEM.seeded } })
  expect(res.status(), 'restoring Cem Aydin to 20h').toBe(200)
})

test('real save round trip: Cem Aydin 20h → 24h reaches the database', async ({ page, request }) => {
  expect(await cemHours(request)).toBe(CEM.seeded)
  await openRange(page, FIXTURE.from, FIXTURE.to, FIXTURE_WEEKS)

  await openEditor(page, CEM.name)
  await editorInput(page, CEM.name).fill('24')
  const [patchResponse] = await Promise.all([
    page.waitForResponse((res) => isPatch(res.request(), CEM.id)),
    editor(page).getByRole('button', { name: 'Save' }).click(),
  ])
  expect(patchResponse.status()).toBe(200)
  expect(await patchResponse.json()).toEqual({ id: CEM.id, name: CEM.name, weeklyHours: 24 })

  await expect(editor(page)).toHaveCount(0)
  await expect(capButton(page, CEM.name)).toHaveText('24h')
  await expectCell(page, CEM.name, 1, '4', 'under')
  await expectCell(page, CEM.name, 2, '12', 'under')

  expect(await cemHours(request)).toBe(24)

  // A fresh load of the page shows the stored value too.
  await page.reload()
  await expect(capButton(page, CEM.name)).toHaveText('24h')
})
