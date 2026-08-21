export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f3f2ec">
  <title>Probat — documentation with evidence</title>
  <link rel="icon" href="/ui/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/ui/app.css">
  <script src="/ui/app.js" defer></script>
</head>
<body>
  <a class="skip" href="#workspace">Skip to workspace</a>
  <header class="topbar">
    <a class="brand" href="/ui/" aria-label="Probat home"><img class="mark" src="/ui/icon.svg" alt="" width="28" height="28"><span>probat</span></a>
    <nav aria-label="Primary"><a href="#workspace">Workspace</a><a href="#method">Method</a><a href="https://github.com/dexarxbt/Probat">Source</a></nav>
    <div class="system" id="system" aria-live="polite"><i></i><span id="system-label">Checking Kane</span></div>
  </header>

  <main>
    <section class="hero" aria-labelledby="hero-title">
      <p class="kicker reveal">README <b>→</b> browser <b>→</b> receipt</p>
      <h1 id="hero-title" class="reveal d1">Documentation,<br><em>with evidence.</em></h1>
      <div class="hero-foot reveal d2">
        <p>Turn exact product claims into constrained Kane runs and source-bound receipts—without hiding blocked attempts or rewriting history.</p>
        <div><button class="button dark" type="button" data-create>New audit <span>↗</span></button><button class="button ghost" type="button" data-refresh>Refresh</button></div>
      </div>
    </section>

    <section class="metrics" aria-label="Workspace totals">
      <div><strong id="m-audits">—</strong><span>Audits</span></div>
      <div><strong id="m-verified">—</strong><span>Verified claims</span></div>
      <div><strong id="m-receipts">—</strong><span>Receipts</span></div>
      <div><strong id="m-blocked">—</strong><span>Blocked attempts</span></div>
    </section>

    <section class="workspace" id="workspace" aria-labelledby="workspace-title">
      <header class="section-head">
        <div><span class="index">01 / Workspace</span><h2 id="workspace-title">Proof console</h2></div>
        <div class="head-actions"><button class="round" type="button" data-refresh aria-label="Refresh audits">↻</button><button class="button light" type="button" data-create>New audit</button></div>
      </header>
      <div class="console">
        <aside class="rail" aria-label="Audits"><div class="rail-head"><span>Local audits</span><span id="audit-count">0</span></div><div id="audit-list" class="audit-list"><i class="skeleton"></i><i class="skeleton"></i></div></aside>
        <section id="stage" class="stage" aria-live="polite"></section>
      </div>
    </section>

    <section class="method" id="method" aria-labelledby="method-title">
      <header class="section-head inverted">
        <div><span class="index">02 / Method</span><h2 id="method-title">A verdict is the end<br>of a chain.</h2></div>
        <p>Each layer removes a different ambiguity. A receipt exists only when every binding agrees.</p>
      </header>
      <div class="method-grid">
        <article><span>01</span><h3>Cite</h3><p>Preserve the exact README quotation, line range, and source hash.</p></article>
        <article><span>02</span><h3>Constrain</h3><p>Compile supported prose into a typed plan, never an open-ended agent prompt.</p></article>
        <article><span>03</span><h3>Observe</h3><p>Bind the target origin and revision to a same-origin deployment manifest and independently hashed entrypoint.</p></article>
        <article><span>04</span><h3>Run</h3><p>Execute immutable test bytes through Kane with shell interpolation disabled.</p></article>
        <article><span>05</span><h3>Receipt</h3><p>Append coherent terminal evidence while preserving every prior attempt.</p></article>
      </div>
    </section>
  </main>

  <footer><a class="brand" href="/ui/"><img class="mark" src="/ui/icon.svg" alt="" width="28" height="28"><span>probat</span></a><p>Local-first proof for claims people ship.</p><div><span>TypeScript / Fastify / Kane</span><span>v1.0.0</span></div></footer>

  <dialog id="create-dialog">
    <form id="create-form" class="dialog-frame">
      <header><div><span class="index">New proof chain</span><h2>Ingest a README</h2></div><button class="close" type="button" data-close aria-label="Close">×</button></header>
      <p class="intro">Point Probat at a workspace Markdown file or public GitHub README and an observable browser target.</p>
      <label class="field"><span>Project name</span><input name="project" required maxlength="100" autocomplete="off" placeholder="product-docs"></label>
      <label class="field"><span>README source</span><input name="readme" required maxlength="2048" autocomplete="off" value="fixtures/example/README.md"></label>
      <div class="field-row"><label class="field"><span>Target URL</span><input name="targetUrl" type="url" required value="http://127.0.0.1:4321"></label><label class="field"><span>Deployment revision</span><input name="targetRevision" value="probat-demo-v1"></label></div>
      <div class="note"><b>i</b><p>The target must serve strict JSON at <code>/.well-known/probat-manifest.json</code> declaring this revision and a root-relative same-origin HTML entrypoint.</p></div>
      <div class="dialog-actions"><button class="button ghost" type="button" data-close>Cancel</button><button class="button dark" type="submit">Create audit <span>↗</span></button></div>
    </form>
  </dialog>

  <dialog id="review-dialog">
    <form id="review-form" class="dialog-frame compact">
      <header><div><span class="index">Claim decision</span><h2>Record the boundary</h2></div><button class="close" type="button" data-close aria-label="Close">×</button></header>
      <blockquote id="review-quote"></blockquote><input id="review-decision" name="decision" type="hidden">
      <label class="field"><span>Reason</span><textarea name="reason" required maxlength="1000" rows="4" placeholder="Why this statement should not run as browser proof"></textarea></label>
      <div class="dialog-actions"><button class="button ghost" type="button" data-close>Cancel</button><button class="button dark" type="submit">Save decision</button></div>
    </form>
  </dialog>

  <dialog id="receipt-dialog" class="receipt-dialog"><div class="dialog-frame receipt-frame"><header><div><span class="index">Immutable record</span><h2>Proof receipt</h2></div><button class="close" type="button" data-close aria-label="Close">×</button></header><div id="receipt-content"></div></div></dialog>
  <div id="operation-status" class="operation-status" role="status" aria-live="polite" hidden></div>
  <div id="busy" class="busy" aria-hidden="true"><i></i></div><div id="toast" class="toast" role="status" aria-live="polite"></div>
</body>
</html>`;

export function renderUiHtml(defaultTargetUrl = 'http://127.0.0.1:4321'): string {
  const target = new URL(defaultTargetUrl);
  if (
    (target.protocol !== 'http:' && target.protocol !== 'https:') ||
    target.username ||
    target.password
  ) {
    throw new Error('The UI default target must be a credential-free HTTP(S) URL.');
  }
  const escapedTarget = target.toString().replace(/[&"<>]/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '"': return '&quot;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      default: return character;
    }
  });
  return UI_HTML.replace(
    'value="http://127.0.0.1:4321"',
    `value="${escapedTarget}"`,
  );
}

export const UI_ICON = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="probat-logo-title probat-logo-description">
  <title id="probat-logo-title">Probat</title>
  <desc id="probat-logo-description">A geometric P with a verified proof point.</desc>
  <path d="M16 10h38c19.5 0 32 11.8 32 29.5S73.5 69 54 69H35v17H16V10Zm19 17v25h18c9.3 0 15-4.7 15-12.5S62.3 27 53 27H35Z" fill="#171714" stroke="#f3f2ec" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="53" cy="39.5" r="8.5" fill="#d8ff65" stroke="#171714" stroke-width="2"/>
  <path d="m49 39.5 2.7 2.7 5.6-6.3" fill="none" stroke="#171714" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
