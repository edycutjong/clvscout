# `web/` — CLV Scout proof surface

The single, dependency-free HTML proof page. No build step, no framework, no
bundler — one self-contained [`index.html`](index.html) that the Express app in
[`../api/`](../api) serves at `GET /` and that drives the real API over `fetch`.

> **One file, zero dependencies.** Fonts, CSS, and JS are all inlined (the
> Space Grotesk face is a `data:` URI), so the page ships as a static artifact
> and renders the CLV reveal by calling the live `/api/*` routes — nothing on it
> is mocked.

**[↩ Root README](../README.md)** · **[🛰️ API](../api/README.md)**

## 📦 What's here

| File | What it is |
|---|---|
| [`index.html`](index.html) | The whole proof surface — inlined CSS/JS/font, ~138 KB. Four narrative panels (audit-the-tout, WON-but-graded-C, the UNGRADED refusal, "what a grade means") plus a live calibration table. On load it `POST`s `/api/calibration` (free) to render the grade→outcome truth table; a button fires `POST /api/demo/run` (free) to trigger a **server-side** real x402 round-trip and show the settled receipt. |

## 🚀 Run it

The page has no server of its own — the Express API serves it as static content.

```bash
# from the repo root
npm run api                        # boots the API + serves web/ on :4021
```

Then open **[http://localhost:4021/](http://localhost:4021/)**. There is no
`web:*` script and no separate dev server; `express.static` mounts this
directory in [`../api/server.ts`](../api/server.ts). You can also open
`index.html` directly in a browser, but the `fetch` calls will fail without the
API running behind it.

## ⚙️ Environment

None. The page reads no config and holds no secrets — all keys, RPC, and the
x402 rail live in the API. It only knows the same-origin `/api/*` paths.

## 🧪 Notes

- **Why the demo pays server-side.** Browsers can't sign EIP-3009, so the paid
  routes (`/api/grade` **$0.01**, `/api/audit` **$0.20**) aren't called from the
  page directly. The `/api/demo/run` button asks the server to run a genuine
  x402 round-trip (probe → 402 → sign → pay → 200) with a throwaway key on
  X Layer (`eip155:196`) and renders the resulting receipt.
- **What it demonstrates.** The tout with a flattering record collapsing to a
  red **Sharp Score**, a *won* bet still graded a mediocre **C** on closing-line
  value, the engine **refusing to grade** a bet it can't verify, and the live
  calibration table proving the grades track real ROI.
- **Caveat.** The visible payment proof depends on the API being reachable at
  the same origin; the calibration table and demo receipt come straight from the
  settled ledger, not canned JSON.
</content>
</invoke>
