# End-to-end tests

Real-browser (Chromium) tests for the capacity grid, driven by Playwright. Faults
(slow, failed, aborted, out-of-order and malformed responses) are injected with
`page.route('**/api/**', …)`, so they are deterministic.

## Run

```bash
make up                      # from the repo root; the suite expects web on :3000
cd e2e
npm install
npx playwright install chromium   # only if the browser is not cached yet
npx playwright test               # add --reporter=list for a plain log
```

Tests run serially (one worker). All saves are mocked except one round trip on
Cem Aydin (id 3), which restores his weekly hours to 20 afterwards.
