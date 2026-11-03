// ClearCart live demo, browser theater view: the Lakeshore frames.
//
// Serves one self-contained page and streams a real live demo run
// (demo/run-demo-live.ts, agents on muse-spark-1.3 through the Meta
// Model API) to the browser over server-sent events, line by line. The
// page stages the run as the five approved frames (see
// ../FRAME_MAP.md): cold open on the denial, Maya shopping Lakeshore
// Cannabis Club, the gate approving, the gate denying, and the bypass
// shutter. The merchant is real: the storefront photo, the logo, the
// menu, and the product packshots are Lakeshore Cannabis Club's own
// (served from ../lakeshore-assets/); the logo composited in the page
// is the store's real logo file, not a rendering. Buyers and
// transactions are simulated, payment is a sandbox stub. The raw
// stream is kept verbatim in the engineer view. The theater is a
// presentation layer only; the run itself is untouched.
//
// Run it:  npm run demo:web        (http://127.0.0.1:8901, PORT overrides)
//
// Evidence protection: the canonical dress-rehearsal evidence lives in
// ~/workspace/hackathon-meta-2026/evidence/live-run-2026-11-03 and a copy
// is committed to GitHub. The live runner accepts a CLEARCART_EVIDENCE_DIR
// override, so every web run writes its own evidence to a fresh
// timestamped directory under evidence/web-runs/ instead. The canonical
// directory is never opened for writing by this server.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(repoRoot, "..", "lakeshore-assets");
const port = Number(process.env.PORT ?? 8901);
const webRunsRoot = join(homedir(), "workspace/hackathon-meta-2026/evidence/web-runs");

let activeRun: ChildProcess | null = null;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClearCart Live Demo: Lakeshore Cannabis Club</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0B1115; color: #F4F1E9; }
  main { max-width: 1280px; margin: 0 auto; padding: 18px 16px 48px; }
  .topbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
  .logoplaque { background: #0A1A2F; border: 1px solid #C9A227; border-radius: 10px; padding: 6px 10px; line-height: 0; }
  .logoplaque img { height: 44px; width: auto; }
  .titleblock h1 { font-size: 26px; margin: 0; letter-spacing: 0.01em; }
  .titleblock h1 span { color: #22AD85; font-size: 15px; font-weight: 600; letter-spacing: 0.04em; }
  .titleblock .sub { color: #9fb0c0; font-size: 13px; margin-top: 2px; }
  .livebadge { display: inline-block; border: 1px solid #C9A227; background: #1d1807; color: #e8c95a; border-radius: 999px; padding: 4px 11px; font-size: 12px; margin-top: 6px; }
  .livebadge .dot { color: #FF4048; }
  .stages { display: flex; gap: 8px; margin-left: auto; }
  .stage { border: 1px solid #2c3642; border-radius: 10px; padding: 7px 11px; background: #10161d; transition: background 0.25s, border-color 0.25s; }
  .stage .name { font-weight: 700; letter-spacing: 0.08em; font-size: 12px; }
  .stage .cap { color: #7d8ea0; font-size: 11px; margin-top: 2px; }
  .stage.active { background: #0e2a20; border-color: #22AD85; }
  .controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
  button { background: #22AD85; color: #06130d; border: 0; border-radius: 8px; padding: 11px 20px; font-size: 15px; font-weight: 700; cursor: pointer; }
  button:disabled { background: #44505c; color: #c9d4e0; cursor: wait; }
  #status { font-weight: 600; font-size: 14px; }
  #status.pass { color: #22AD85; }
  #status.fail { color: #FF4048; }
  .engtoggle { color: #9fb0c0; font-size: 13px; cursor: pointer; }
  .hudline { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; color: #9fb0c0; margin-bottom: 12px; }
  .hudline b { color: #F4F1E9; }

  #stage { position: relative; border-radius: 16px; overflow: hidden; border: 1px solid #2c3642; background: #06090c; aspect-ratio: 16 / 9; min-height: 540px; transition: filter 0.5s ease; }
  #stage.cut { filter: brightness(0); }
  #stage.dim { filter: brightness(0.55); }
  #store-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }
  #stage[data-frame="f2"] #store-photo, #stage[data-frame="f3"] #store-photo, #stage[data-frame="f4"] #store-photo { opacity: 0.62; }
  #stage[data-frame="f1"] #store-photo { opacity: 0.75; }
  .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 42%, rgba(6,9,12,0.08) 0%, rgba(6,9,12,0.55) 62%, rgba(6,9,12,0.92) 100%); pointer-events: none; }
  .layer { position: absolute; transition: opacity 0.6s ease, transform 0.6s ease; }

  /* Gate: a brushed-steel checkpoint arch */
  .layer-gate { left: 50%; top: 44%; transform: translate(-50%, -50%); width: 300px; text-align: center; z-index: 4; }
  .gatearch { border: 5px solid #74828C; border-bottom-width: 14px; border-radius: 120px 120px 14px 14px; background: linear-gradient(180deg, rgba(20,28,36,0.92), rgba(10,15,20,0.94)); padding: 20px 16px 14px; box-shadow: 0 0 44px rgba(0,0,0,0.6), inset 0 0 26px rgba(116,130,140,0.25); }
  .gatearch .gtitle { font-weight: 800; letter-spacing: 0.14em; font-size: 13px; color: #cfd8de; }
  .gatearch .gsub { color: #8fa0ae; font-size: 11px; margin-top: 3px; letter-spacing: 0.06em; }
  .gatelight { height: 8px; border-radius: 999px; background: #39434f; margin: 12px 6px 4px; transition: background 0.4s, box-shadow 0.4s; }
  .layer-gate.ok .gatelight { background: #22AD85; box-shadow: 0 0 18px #22AD85; }
  .layer-gate.bad .gatelight { background: #FF4048; box-shadow: 0 0 18px #FF4048; }
  .stamp { display: inline-block; margin-top: 14px; font-weight: 900; font-size: 30px; letter-spacing: 0.1em; border: 4px solid; border-radius: 10px; padding: 7px 18px; opacity: 0; background: rgba(6,9,12,0.85); transform: rotate(-11deg); }
  .stamp.approve { color: #22AD85; border-color: #22AD85; }
  .stamp.deny { color: #FF4048; border-color: #FF4048; }
  .stamp.shown { opacity: 1; }
  .stamp.slam { animation: slam 0.45s ease-out forwards; }
  .stamp.slamhard { animation: slam 0.28s ease-out forwards; }
  @keyframes slam { 0% { opacity: 0; transform: scale(2.4) rotate(-18deg); } 60% { opacity: 1; transform: scale(0.94) rotate(-9deg); } 100% { opacity: 1; transform: scale(1) rotate(-11deg); } }
  .shake { animation: shake 0.5s ease; }
  @keyframes shake { 0%, 100% { transform: translate(-50%, -50%); } 20% { transform: translate(calc(-50% - 7px), -50%); } 40% { transform: translate(calc(-50% + 6px), -50%); } 60% { transform: translate(calc(-50% - 4px), -50%); } 80% { transform: translate(calc(-50% + 3px), -50%); } }

  /* Receipt: warm ivory paper under the gate */
  .receipt { width: 300px; margin: 14px auto 0; border-radius: 4px; background: #F4F1E9; color: #23272e; padding: 12px 14px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.55; text-align: left; transform-origin: top center; position: relative; box-shadow: 0 12px 30px rgba(0,0,0,0.5); }
  .receipt.unfurl { animation: unfurl 0.6s ease-out; }
  @keyframes unfurl { 0% { transform: scaleY(0.15); opacity: 0; } 100% { transform: scaleY(1); opacity: 1; } }
  .receipt .rhead { display: flex; align-items: center; gap: 9px; border-bottom: 1px dashed #9a937e; padding-bottom: 7px; margin-bottom: 7px; }
  .receipt .rhead img { width: 34px; height: 34px; border-radius: 50%; }
  .receipt .rhead .rname { font-family: Inter, system-ui, sans-serif; font-weight: 800; letter-spacing: 0.05em; font-size: 12px; color: #0A1A2F; }
  .receipt .rhead .rsub { font-family: Inter, system-ui, sans-serif; font-size: 10px; color: #6b6350; letter-spacing: 0.08em; }
  .receipt .ok-dec { color: #177245; font-weight: 700; }
  .receipt .bad-dec { color: #b62324; font-weight: 700; }
  .receipt .rpcode { display: none; margin-top: 8px; background: #0A1A2F; color: #F4F1E9; border: 1px solid #C9A227; border-radius: 8px; padding: 6px 10px; text-align: center; font-family: Inter, system-ui, sans-serif; }
  .receipt .rpcode.show { display: block; }
  .receipt .rpcode .plabel { font-size: 10px; letter-spacing: 0.14em; color: #e8c95a; }
  .receipt .rpcode .pcode { font-size: 22px; font-weight: 900; letter-spacing: 0.16em; }
  .receipt .usedmark { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: 30px; font-weight: 900; letter-spacing: 0.22em; color: rgba(182, 35, 36, 0.55); transform: rotate(-14deg); }
  .receipt.used { filter: sepia(0.55) brightness(0.92); }
  .receipt.used .usedmark { display: flex; }
  .receipt.used .sig { text-decoration: line-through; }

  /* Meters */
  .layer-meter { left: 50%; bottom: 118px; transform: translateX(-50%); width: 340px; background: rgba(10,17,23,0.82); border: 1px solid #2c3642; border-radius: 12px; padding: 11px 14px; z-index: 3; }
  .meter { margin-bottom: 9px; }
  .meter:last-child { margin-bottom: 0; }
  .meter .mlabel { font-size: 12px; color: #9fb0c0; margin-bottom: 4px; display: flex; justify-content: space-between; }
  .bar { height: 13px; border-radius: 999px; background: #0d1117; border: 1px solid #2c3642; overflow: hidden; }
  .bar .fill { height: 100%; width: 0%; background: #22AD85; border-radius: 999px; transition: width 0.9s ease; }
  .bar .fill.warn { background: #d29922; }
  .bar.over .fill { background: repeating-linear-gradient(45deg, #FF4048 0 10px, #b62324 10px 20px); }
  .bar.crack { animation: crackpulse 0.5s ease 2; }
  @keyframes crackpulse { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }

  /* Maya / shopper */
  .layer-maya { left: 22px; top: 22px; width: 342px; z-index: 3; }
  .person { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: #C9A227; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 17px; color: #0A1A2F; flex: none; }
  .person .pname { font-weight: 700; }
  .person .prole { color: #aebac4; font-size: 12px; }
  .bubble { border-radius: 12px; padding: 9px 11px; margin: 0 0 8px; font-size: 13px; line-height: 1.45; max-height: 240px; overflow-y: auto; }
  .bubble.maya { background: rgba(16,32,58,0.92); border: 1px solid #2d4a7a; }
  .bubble.agent { background: rgba(18,26,34,0.94); border: 1px solid #39434f; }
  .bubble .who { font-size: 11px; letter-spacing: 0.08em; color: #9fb0c0; font-weight: 700; margin-bottom: 4px; }
  .bubble .quote { color: #c9d4e0; font-style: italic; }
  .empty { color: #8fa0ae; font-size: 13px; }

  /* Store: menu cards and basket */
  .layer-store { right: 22px; top: 22px; width: 348px; z-index: 3; }
  .storecard { background: rgba(13,20,28,0.92); border: 1px solid #2c3642; border-radius: 12px; padding: 12px; }
  .menucard { display: flex; gap: 10px; border: 1px solid #2c3642; border-radius: 10px; background: rgba(10,15,20,0.9); padding: 8px; margin-bottom: 8px; font-size: 13px; align-items: center; animation: land 0.45s ease-out; }
  @keyframes land { 0% { transform: translateY(-14px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
  .menucard img { width: 46px; height: 46px; object-fit: cover; border-radius: 8px; flex: none; background: #fff; }
  .menucard .mname { font-weight: 600; line-height: 1.3; }
  .menucard .mdet { color: #8fa0ae; font-size: 12px; margin-top: 2px; }
  .menucard .mprice { margin-left: auto; font-weight: 700; color: #22AD85; white-space: nowrap; }
  .basket { border-top: 1px dashed #39434f; margin-top: 4px; padding-top: 10px; }
  .basket .bhead { display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 13px; margin-bottom: 6px; }
  .badge { font-size: 11px; border-radius: 999px; padding: 2px 9px; background: #4a1712; color: #ff9d94; display: none; }
  .badge.show { display: inline-block; }
  .bitem { display: flex; align-items: center; gap: 9px; font-size: 13px; padding: 4px 0; color: #dbe4ec; animation: land 0.45s ease-out; }
  .bitem img { width: 34px; height: 34px; object-fit: cover; border-radius: 7px; flex: none; background: #fff; }
  .bitem .bamt { margin-left: auto; white-space: nowrap; }
  .btotal { display: flex; justify-content: space-between; font-weight: 700; font-size: 15px; border-top: 1px solid #2c3642; margin-top: 6px; padding-top: 7px; }
  .stock { font-size: 11px; border-radius: 999px; padding: 1px 8px; background: #0e2a20; color: #7ee2a0; }
  .stock.out { background: #4a1712; color: #ff9d94; }

  /* Payment */
  .layer-pay { right: 22px; bottom: 118px; width: 348px; z-index: 4; }
  .paycard { position: relative; overflow: hidden; background: rgba(13,20,28,0.94); border: 1px solid #2c3642; border-radius: 12px; padding: 13px 14px; }
  .paycard h3 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.14em; color: #8fa0ae; }
  .paycard .paybody { color: #aebac4; font-size: 13px; line-height: 1.55; }
  .paycard.lit { border-color: #22AD85; }
  .pickup { display: none; margin-top: 11px; border: 1px dashed #C9A227; border-radius: 10px; padding: 10px 12px; background: rgba(29,24,7,0.9); text-align: center; }
  .pickup.show { display: block; }
  .pickup .plabel { font-size: 11px; letter-spacing: 0.14em; color: #e8c95a; }
  .pickup .pcode { font-size: 30px; font-weight: 900; letter-spacing: 0.16em; color: #F4F1E9; }
  .rogue { display: none; border: 1px dashed #FF4048; background: rgba(28,15,16,0.95); color: #ffb4ab; border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 10px; }
  .rogue.show { display: block; animation: slidein 0.7s ease-out; }
  @keyframes slidein { 0% { transform: translateX(46px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
  .shutter { position: absolute; inset: 0; background: repeating-linear-gradient(180deg, #3a3f46 0 16px, #26292f 16px 32px); transform: translateY(-104%); transition: transform 0.4s cubic-bezier(0.6, 0, 0.85, 0.4); z-index: 6; padding: 20px 16px; }
  .shutter.down { transform: translateY(0); }
  .shutter .stitle { color: #FF4048; font-family: ui-monospace, Menlo, monospace; font-weight: 900; letter-spacing: 0.04em; font-size: 17px; margin-top: 40px; text-shadow: 0 0 14px rgba(255,64,72,0.7); }
  .shutter .sline { color: #e6edf3; font-size: 12px; line-height: 1.5; margin-top: 8px; word-break: break-word; }

  /* Terminal card, Beat 4 coda */
  .layer-term { left: 50%; bottom: 118px; transform: translateX(-50%); width: 560px; max-width: 92%; z-index: 5; display: none; }
  .layer-term.show { display: block; }
  .termcard { background: rgba(6,9,12,0.96); border: 1px solid #2c3642; border-radius: 12px; padding: 13px 15px; position: relative; }
  .termcard h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.14em; color: #8fa0ae; }
  #terminal-body { font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.55; color: #9fd6a8; white-space: pre-wrap; word-break: break-word; max-height: 170px; overflow-y: auto; }
  .termcard .stamp { font-size: 17px; margin-top: 8px; }

  .checks { position: absolute; left: 22px; bottom: 118px; width: 330px; font-size: 12px; color: #7ee2a0; line-height: 1.55; z-index: 3; max-height: 180px; overflow-y: auto; }
  .checks .bad { color: #ff9d94; }

  #packet { position: absolute; width: 30px; height: 22px; border-radius: 5px; background: #C9A227; border: 1px solid #8a6d14; box-shadow: 0 2px 10px rgba(0,0,0,0.5); opacity: 0; z-index: 9; pointer-events: none; }

  #caption { position: absolute; left: 22px; right: 300px; bottom: 20px; z-index: 5; font-size: 21px; line-height: 1.4; font-weight: 600; text-shadow: 0 2px 10px rgba(0,0,0,0.85); }
  #caption .clabel { display: block; font-size: 11px; letter-spacing: 0.16em; color: #C9A227; font-weight: 700; margin-bottom: 4px; }
  .proofhud { position: absolute; right: 22px; bottom: 20px; z-index: 5; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; color: #aebac4; text-align: right; line-height: 1.7; background: rgba(6,9,12,0.55); border-radius: 8px; padding: 6px 10px; }
  .proofhud b { color: #F4F1E9; }

  /* Frame states: one focal point per frame */
  #stage[data-frame="f1"] .layer-maya, #stage[data-frame="f1"] .layer-store, #stage[data-frame="f1"] .layer-pay, #stage[data-frame="f1"] .layer-meter, #stage[data-frame="f1"] .checks { opacity: 0; pointer-events: none; }
  #stage[data-frame="f2"] .layer-gate, #stage[data-frame="f2"] .layer-pay { opacity: 0; pointer-events: none; }
  #stage[data-frame="f2"] .layer-gate { transform: translate(-50%, -50%) scale(0.85); }
  #stage[data-frame="f3"] .layer-maya, #stage[data-frame="f4"] .layer-maya { opacity: 0.35; }
  #stage[data-frame="f3"] .layer-store .menucard, #stage[data-frame="f4"] .layer-store .menucard { display: none; }
  #stage[data-frame="f3"] .layer-pay, #stage[data-frame="f4"] .layer-pay { opacity: 0; pointer-events: none; }
  #stage[data-frame="f5"] .layer-store, #stage[data-frame="f5"] .layer-maya { opacity: 0.3; }
  #stage[data-frame="f5"] .layer-gate { left: 30%; transform: translate(-50%, -50%) scale(0.8); }
  #stage[data-frame="f5"] .layer-meter, #stage[data-frame="f5"] .checks { opacity: 0; pointer-events: none; }
  #stage[data-frame="f6"] .layer-maya, #stage[data-frame="f6"] .layer-store, #stage[data-frame="f6"] .layer-pay, #stage[data-frame="f6"] .layer-meter, #stage[data-frame="f6"] .checks, #stage[data-frame="f6"] .layer-term { opacity: 0; pointer-events: none; }
  #stage[data-frame="f6"] .layer-gate .receipt { display: none; }

  #summary-bar { display: none; margin-top: 12px; border: 1px solid #22AD85; background: #0e2a20; border-radius: 10px; padding: 13px 16px; font-size: 15px; }
  #summary-bar.show { display: block; }
  #summary-bar a { color: #7ee2a0; }
  #log { display: none; background: #0b0f13; border: 1px solid #2c3642; border-radius: 10px; padding: 14px; height: 460px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; line-height: 1.5; margin-top: 12px; }
  #log.show { display: block; }
  @media (max-width: 980px) { #stage { aspect-ratio: auto; } .layer-maya, .layer-store { width: 300px; } #caption { right: 22px; bottom: 86px; } }
</style>
</head>
<body>
<main>
  <div class="topbar">
    <div class="logoplaque"><img src="/assets/logo.png" alt="Lakeshore Cannabis Club logo"></div>
    <div class="titleblock">
      <h1>ClearCart <span>by BakedBot AI</span></h1>
      <div class="sub">Lakeshore Cannabis Club, 1335 Lakeside Drive Unit 4, Romeoville, IL. Merchant agent on duty.</div>
      <div class="livebadge"><span class="dot">&#9679;</span> LIVE&nbsp; Live run: Muse Spark 1.3 via the Meta Model API. The menu, prices, and photos are Lakeshore's real published catalog. Buyers and transactions are simulated; payment is a sandbox stub.</div>
    </div>
    <div class="stages">
      <div class="stage" id="stage-model"><div class="name">MODEL</div><div class="cap">Agents talk and decide</div></div>
      <div class="stage" id="stage-tool"><div class="name">TOOL</div><div class="cap">Menu, cart, quote</div></div>
      <div class="stage" id="stage-gate"><div class="name">GATE</div><div class="cap">Decisions and receipts</div></div>
      <div class="stage" id="stage-payment"><div class="name">PAYMENT</div><div class="cap">Sandbox session, pickup code</div></div>
    </div>
  </div>
  <div class="hudline">
    <span>Beat <b id="hud-beat">not started</b></span>
    <span>Checks passed <b id="hud-checks">0</b></span>
    <span>Stage <b id="hud-stage">idle</b></span>
  </div>
  <div class="controls">
    <button id="run" type="button">Run live demo</button>
    <span id="status">Idle. A live run takes about three minutes.</span>
    <label class="engtoggle"><input type="checkbox" id="eng-toggle"> Engineer view (raw log)</label>
  </div>
  <section id="stage" data-frame="f1">
    <img id="store-photo" src="/assets/storefront.jpg" alt="Lakeshore Cannabis Club storefront, Romeoville IL">
    <div class="vignette"></div>
    <div class="layer layer-maya" id="panel-shopper">
      <div class="person"><div class="avatar">M</div><div><div class="pname">Maya</div><div class="prole">Shopper, using a buyer agent</div></div></div>
      <div id="chat"><p class="empty">Maya has not said anything yet.</p></div>
    </div>
    <div class="layer layer-store" id="panel-store">
      <div class="storecard">
        <div id="menu-cards"><p class="empty">The menu shows up here once Maya asks.</p></div>
        <div class="basket">
          <div class="bhead"><span id="basket-title">Basket</span><span class="badge" id="basket-badge">Blocked at the gate</span></div>
          <div id="basket-items"><p class="empty">Nothing in the basket yet.</p></div>
          <div class="btotal"><span>Total</span><span id="basket-total">$0</span></div>
        </div>
      </div>
    </div>
    <div class="layer layer-gate bad" id="panel-gate">
      <div class="gatearch">
        <div class="gtitle">CLEARCART GATE</div>
        <div class="gsub">COMPLIANCE CHECKPOINT, LAKESHORE CANNABIS CLUB</div>
        <div class="gatelight"></div>
        <div class="stamp deny shown" id="stamp-gate">DENIED</div>
      </div>
      <div id="receipt-slot"></div>
    </div>
    <div class="layer layer-meter" id="panel-meter">
      <div class="meter"><div class="mlabel"><span>Flower, daily limit</span><span id="meter-flower-label">0 g of 30 g</span></div><div class="bar" id="meter-flower-bar"><div class="fill" id="meter-flower-fill"></div></div></div>
      <div class="meter"><div class="mlabel"><span>Infused THC, daily limit</span><span id="meter-thc-label">0 mg of 500 mg</span></div><div class="bar" id="meter-thc-bar"><div class="fill" id="meter-thc-fill"></div></div></div>
    </div>
    <div class="checks" id="checks"></div>
    <div class="layer layer-pay" id="panel-payment">
      <div class="rogue" id="rogue-card"><b>Rogue agent</b><br>Trying to pay without asking the gate first.</div>
      <div class="paycard" id="paycard">
        <h3>PAYMENT RAIL</h3>
        <div class="paybody" id="payment-body">Locked. The payment rail only opens with a valid gate receipt, and it checks the signature itself.</div>
        <div class="shutter" id="shutter"><div class="stitle">GATE_RECEIPT_MISSING</div><div class="sline" id="shutter-line"></div></div>
      </div>
    </div>
    <div class="layer layer-term" id="terminal-card">
      <div class="termcard">
        <h3>SOMEONE ELSE'S AGENT, PLAIN API CALL</h3>
        <div id="terminal-body"></div>
        <div class="stamp approve" id="stamp-term">APPROVED</div>
      </div>
    </div>
    <div id="packet"></div>
    <div id="caption"><span class="clabel">CLEARCART, LIVE AT LAKESHORE CANNABIS CLUB</span><span id="caption-text">An AI agent just tried to buy cannabis. Watch what stops it.</span></div>
    <div class="proofhud">
      <div>Model <b>Muse Spark 1.3</b></div>
      <div>Model calls <b id="hud-calls">not started</b></div>
      <div>Tokens <b id="hud-tokens">not started</b></div>
    </div>
  </section>
  <div id="summary-bar"></div>
  <div id="log"></div>
</main>
<script>
  function el(id) { return document.getElementById(id); }
  var button = el('run'), statusEl = el('status'), logEl = el('log');
  var stageEl = el('stage');
  var stages = { model: el('stage-model'), tool: el('stage-tool'), gate: el('stage-gate'), payment: el('stage-payment') };
  var chatEl = el('chat'), menuEl = el('menu-cards'), basketItemsEl = el('basket-items'), basketTotalEl = el('basket-total'), basketTitleEl = el('basket-title'), basketBadgeEl = el('basket-badge');
  var flowerFill = el('meter-flower-fill'), flowerBar = el('meter-flower-bar'), flowerLabel = el('meter-flower-label');
  var thcFill = el('meter-thc-fill'), thcBar = el('meter-thc-bar'), thcLabel = el('meter-thc-label');
  var gatePanel = el('panel-gate'), gateStamp = el('stamp-gate'), receiptSlot = el('receipt-slot'), checksEl = el('checks');
  var payCard = el('paycard'), payBody = el('payment-body'), rogueEl = el('rogue-card'), shutterEl = el('shutter'), shutterLine = el('shutter-line');
  var captionText = el('caption-text'), termCard = el('terminal-card'), termBody = el('terminal-body'), termStamp = el('stamp-term');
  var summaryBar = el('summary-bar'), packetEl = el('packet'), wrapEl = el('stage');
  var hudBeat = el('hud-beat'), hudChecks = el('hud-checks'), hudCalls = el('hud-calls'), hudTokens = el('hud-tokens'), hudStage = el('hud-stage');

  // Lakeshore Cannabis Club's real published menu (Jane, harvested
  // 2026-11-03). The run decides which of these surface, and when; the
  // prices and packshots are the store's own.
  var PRODUCTS = [
    { key: 'citrus black grape', name: 'IC Collective Citrus Black Grape', price: 14.87, img: 'product-05.jpg', det: 'Rosin gummies, 5 pk, 100 mg THC' },
    { key: 'watermelon animal face', name: 'RYTHM Watermelon Animal Face', price: 11.15, img: 'product-08.jpg', det: 'Live rosin gummies, 100 mg THC' },
    { key: 'lemon bean', name: 'Cresco Lemon Bean', price: 28.11, img: 'product-01.png', det: 'Flower 3.5 g, 23.07% THC' },
    { key: 'lemon sorbet', name: 'Savvy Lemon Sorbet', price: 40.15, img: 'product-02.jpg', det: 'Infused flower 7 g' },
    { key: 'beaver cookies', name: '&Shine Beaver Cookies', price: 60.24, img: 'product-03.jpg', det: 'Flower 14 g, 23.41% THC' },
    { key: 'animal face', name: 'RYTHM Animal Face', price: 60.24, img: 'product-04.jpg', det: 'Flower 14 g, 29.97% THC' },
    { key: 'tangahhhrine', name: 'incredibles Sour Tangahhhrine + CBD', price: 8.92, img: 'product-06.jpg', det: 'Gummies, 100 mg THC + 200 mg CBD' },
    { key: 'lemon-fade', name: 'Daze Off Strawberry Lemon-fade', price: 8.92, img: 'product-07.jpg', det: 'Gummies, 100 mg THC' },
    { key: 'sunrise orange', name: "Uncle Arnie's Sunrise Orange", price: 8.92, img: 'product-09.jpg', det: 'Drink shot 2 oz, 100 mg THC' },
    { key: 'photosynthesis', name: 'Daze Off Photosynthesis', price: 20.07, img: 'product-10.jpg', det: 'Pre-rolls 7 x 0.5 g, 19.43% THC' },
    { key: 'durban poison', name: 'RYTHM Durban Poison', price: 14.87, img: 'product-11.jpg', det: 'Infused pre-roll 1 g' },
    { key: 'clementine', name: 'Savvy HYPHEN Clementine', price: 53.76, img: 'product-12.jpg', det: 'Disposable vape 3 g, 88.33% THC' },
    { key: 'pineapple express', name: 'RYTHM Pineapple Express', price: 35.84, img: 'product-13.jpg', det: 'Vape 1 g, 93.43% THC' },
    { key: 'florida oranges', name: 'Aeriz Florida Oranges', price: 25.09, img: 'product-14.jpg', det: 'FSHO extract 1 g, 17.69% THC' }
  ];
  function findProduct(text) {
    var lower = String(text || '').toLowerCase();
    for (var i = 0; i < PRODUCTS.length; i++) {
      if (lower.indexOf(PRODUCTS[i].key) >= 0) return PRODUCTS[i];
    }
    return null;
  }

  var CAPTIONS = {
    coldopen: 'An AI agent just tried to buy cannabis. Watch what stops it.',
    intro: 'This is a real run, happening now. Two agents talk, and every order has to pass one checkpoint.',
    shopping: 'Maya asked for citrus-forward under $100. Her buyer agent shops the live menu.',
    menu: "The store answers with its real menu: Lakeshore's own products, prices, and stock.",
    quote: "The agent builds the basket from Lakeshore's real menu. Still no money moving, just talk.",
    gate_check: 'Before any money moves, the order stops at the gate. The gate checks her ID and her daily limit, like a bouncer with a perfect memory.',
    approve: 'The gate checks the order, then approves it before payment.',
    payment: 'Paid on the sandbox rail, and only because the gate said yes first. The receipt is spent the moment it is used.',
    pickup: 'Order ready. Maya gets a pickup code, like a coat check ticket for her bag.',
    restock: 'Same store, same gate. A restock run tries to push past the daily limit.',
    deny: 'This order would break the daily limit. The gate denies it.',
    bypass_try: 'So the agent tries the side door: pay without asking the gate at all.',
    bypass: 'No gate receipt, no payment. The rail refuses the charge.',
    standalone: "The same gate, called by an agent we did not build, in a different category. It gets the same treatment.",
    finish: 'Four beats, one rule. Agents can shop anywhere. The gate decides what gets bought.'
  };
  function caption(key) { if (CAPTIONS[key]) captionText.textContent = CAPTIONS[key]; }
  function setFrame(f) { stageEl.setAttribute('data-frame', f); }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function md(s) {
    var t = esc(s);
    t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    t = t.replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
    return t;
  }
  function light(stage) {
    for (var key in stages) stages[key].classList.toggle('active', key === stage);
    hudStage.textContent = stage ? stage.toUpperCase() : 'idle';
  }
  function stageFor(line) {
    var s = line.toLowerCase();
    if (s.indexOf('payment') >= 0 || s.indexOf('pickup') >= 0 || s.indexOf('rail') >= 0) return 'payment';
    if (s.indexOf('gate') >= 0 || s.indexOf('receipt') >= 0 || s.indexOf('bypass') >= 0) return 'gate';
    if (s.indexOf('tool') >= 0 || s.indexOf('menu') >= 0 || s.indexOf('quote') >= 0) return 'tool';
    if (s.indexOf('buyer agent') >= 0 || s.indexOf('merchant') >= 0 || s.indexOf('shopper') >= 0) return 'model';
    return null;
  }

  var chatStarted = false;
  function addBubble(who, kind, text) {
    if (!chatStarted) { chatEl.innerHTML = ''; chatStarted = true; }
    var div = document.createElement('div');
    div.className = 'bubble ' + kind;
    var html = '<div class="who">' + who + '</div>';
    var lines = text.split('\\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.indexOf('> ') === 0) out.push('<span class="quote">' + md(ln.slice(2)) + '</span>');
      else if (/^\\s*[-*]\\s+/.test(ln)) out.push('&#8226; ' + md(ln.replace(/^\\s*[-*]\\s+/, '')));
      else out.push(md(ln));
    }
    div.innerHTML = html + out.join('<br>');
    chatEl.appendChild(div);
    div.scrollIntoView({ block: 'nearest' });
  }

  var menuSeen = {};
  function addMenuCard(product, stock) {
    if (!product || menuSeen[product.key]) return;
    menuSeen[product.key] = true;
    if (menuEl.querySelector('.empty')) menuEl.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'menucard';
    var stockHtml = '';
    if (stock === 0) stockHtml = ' <span class="stock out">out of stock</span>';
    else if (stock !== null && stock !== undefined) stockHtml = ' <span class="stock">' + stock + ' in stock</span>';
    div.innerHTML = '<img src="/assets/' + product.img + '" alt="">' +
      '<div><div class="mname">' + esc(product.name) + '</div><div class="mdet">' + esc(product.det) + stockHtml + '</div></div>' +
      '<div class="mprice">$' + product.price.toFixed(2) + '</div>';
    menuEl.appendChild(div);
  }
  function cleanName(n) {
    return n.replace(/\\*/g, '').replace(/\\x60/g, '').replace(/\\s*\\((?:[A-Z]{3}-\\d{3})\\)\\s*$/, '').trim();
  }
  function money(n) { return '$' + Number(n).toFixed(2); }
  function setBasket(items, total, title) {
    if (!items.length) return;
    basketTitleEl.textContent = title;
    basketItemsEl.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var row = document.createElement('div');
      row.className = 'bitem';
      var img = items[i].product ? '<img src="/assets/' + items[i].product.img + '" alt="">' : '';
      var nm = items[i].product ? items[i].product.name : items[i].name;
      row.innerHTML = img + '<span>' + items[i].qty + ' x ' + esc(nm) + '</span><span class="bamt">' + money(items[i].lineTotal) + '</span>';
      basketItemsEl.appendChild(row);
    }
    basketTotalEl.textContent = money(total);
  }

  function setMeter(flower, flowerLimit, thc, thcLimit) {
    flowerLabel.textContent = flower + ' g of ' + flowerLimit + ' g' + (flower > flowerLimit ? ', over the limit' : '');
    flowerFill.style.width = Math.min(100, flowerLimit ? (flower / flowerLimit) * 100 : 0) + '%';
    flowerBar.classList.toggle('over', flower > flowerLimit);
    flowerFill.classList.toggle('warn', flower <= flowerLimit && flower / flowerLimit > 0.7);
    thcLabel.textContent = thc + ' mg of ' + thcLimit + ' mg' + (thc > thcLimit ? ', over the limit' : '');
    thcFill.style.width = Math.min(100, thcLimit ? (thc / thcLimit) * 100 : 0) + '%';
    thcBar.classList.toggle('over', thc > thcLimit);
    thcFill.classList.toggle('warn', thc <= thcLimit && thc / thcLimit > 0.7);
  }

  function slamStamp(kind, text, hard) {
    gateStamp.textContent = text;
    gateStamp.className = 'stamp ' + kind;
    void gateStamp.offsetWidth;
    gateStamp.classList.add('shown');
    gateStamp.classList.add(hard ? 'slamhard' : 'slam');
  }
  var receiptCardEl = null, receiptPickupEl = null;
  function showReceipt(d) {
    receiptSlot.innerHTML = '';
    var ev = d.evaluated || {};
    var div = document.createElement('div');
    div.className = 'receipt unfurl';
    var totals = '';
    if (typeof ev.flower_equivalent_g_total === 'number') totals = ev.flower_equivalent_g_total + ' g flower, ' + ev.infused_thc_mg_total + ' mg infused THC';
    else if (typeof ev.items_total === 'number') totals = ev.items_total + ' items';
    var decCls = d.decision === 'APPROVE' ? 'ok-dec' : 'bad-dec';
    div.innerHTML = '<div class="rhead"><img src="/assets/logo-badge.png" alt=""><div><div class="rname">LAKESHORE CANNABIS CLUB</div><div class="rsub">CLEARCART GATE RECEIPT</div></div></div>' +
      'Decision: <span class="' + decCls + '">' + esc(String(d.decision || '')) + '</span><br>' +
      'Decision ID: ' + esc(String(d.decision_id || 'n/a')) + '<br>' +
      'Policy: ' + esc(String(d.policy_id || 'n/a')) + '<br>' +
      (totals ? 'Totals: ' + esc(totals) + '<br>' : '') +
      'Cart hash: ' + esc(String(d.cart_hash || '').slice(0, 12)) + '...<br>' +
      '<span class="sig">Signature: ' + esc(String(d.receipt_signature || '').slice(0, 16)) + '...</span>' +
      '<div class="rpcode" id="receipt-pickup"><div class="plabel">PICKUP CODE</div><div class="pcode"></div></div>' +
      '<div class="usedmark">USED</div>';
    receiptSlot.appendChild(div);
    receiptCardEl = div;
    receiptPickupEl = div.querySelector('#receipt-pickup');
  }
  function markReceiptUsed(code) {
    if (!receiptCardEl) return;
    receiptCardEl.classList.add('used');
    if (receiptPickupEl && code) {
      receiptPickupEl.querySelector('.pcode').textContent = code;
      receiptPickupEl.classList.add('show');
    }
  }

  function flyPacket(fromPanel, toPanel, done) {
    var wr = wrapEl.getBoundingClientRect();
    var a = fromPanel.getBoundingClientRect();
    var b = toPanel.getBoundingClientRect();
    packetEl.style.transition = 'none';
    packetEl.style.left = (a.left - wr.left + a.width / 2 - 15) + 'px';
    packetEl.style.top = (a.top - wr.top + 26) + 'px';
    packetEl.style.opacity = '1';
    void packetEl.offsetWidth;
    packetEl.style.transition = 'left 0.9s ease, top 0.9s ease, opacity 0.3s ease';
    packetEl.style.left = (b.left - wr.left + b.width / 2 - 15) + 'px';
    packetEl.style.top = (b.top - wr.top + 26) + 'px';
    setTimeout(function () { packetEl.style.opacity = '0'; if (done) done(); }, 950);
  }

  function addCheck(ok, label) {
    var div = document.createElement('div');
    if (!ok) div.className = 'bad';
    div.textContent = (ok ? '[ok] ' : '[FAIL] ') + label;
    checksEl.appendChild(div);
  }
  function termWrite(text) { termBody.textContent += text + '\\n'; termBody.scrollTop = termBody.scrollHeight; }

  var beat = 0, okCount = 0, failCount = 0, allPassed = false;
  var bubbleKind = null, bubbleBuf = [];
  var jsonBuf = null, jsonCtx = null, jsonDepth = 0;

  function braceDelta(line) {
    var d = 0;
    for (var i = 0; i < line.length; i++) {
      if (line.charAt(i) === '{') d++;
      else if (line.charAt(i) === '}') d--;
    }
    return d;
  }

  function isStructural(line) {
    return /^===/.test(line) || /^\\s*\\[(ok|FAIL)\\]/.test(line) ||
      line.indexOf('Gate receipt:') === 0 || line.indexOf('Gate response:') === 0 ||
      line.indexOf('Gate service') === 0 || line.indexOf('Payment:') === 0 ||
      line.indexOf('Order status:') === 0 || line.indexOf('Bypass attempt:') === 0 ||
      line.indexOf('Payment rail:') === 0 || line.indexOf('Equivalent call') === 0 ||
      /^curl\\s/.test(line) || line.indexOf('Shopper:') === 0 || /^Buyer agent/.test(line) ||
      line.indexOf('All four beats') === 0 || /beat check\\(s\\) FAILED/.test(line) ||
      line.indexOf('RUN ERROR') >= 0 || line.indexOf('EXIT_CODE') === 0;
  }

  function parseMenuAndBasket(text) {
    var lines = text.split('\\n');
    var i, m;
    // Menu cards: bold "Name - $price" lines, plus any real product a
    // bubble names (discovery summary, merchant answer, order recap).
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/\\*\\*([^*]+?)\\s+-\\s+\\$(\\d+(?:\\.\\d{2})?)\\*\\*/);
      if (m) addMenuCard(findProduct(m[1]), null);
    }
    var found = findProduct(text);
    if (found) {
      var stock = null;
      var st = text.match(/(\\d+) in stock/);
      if (st) stock = parseInt(st[1], 10);
      if (/out of stock/.test(text)) stock = 0;
      addMenuCard(found, stock);
      if (beat === 1) caption('menu');
    }

    var items = [], total = null;
    var comboRe = /(\\d+)x\\s+([^(]+?)\\s*\\((\\d+(?:\\.\\d{2})?)\\)/g, cm;
    var comboItems = [];
    while ((cm = comboRe.exec(text)) !== null) {
      var cp = findProduct(cm[2]);
      if (cp) comboItems.push({ qty: parseInt(cm[1], 10), name: cp.name, product: cp, lineTotal: parseInt(cm[1], 10) * cp.price });
    }
    if (comboItems.length) items = comboItems;
    else {
      var orderRe = /^(?:\\s*[-*]\\s*)?(\\d+)x\\s+(.+?)\\s*(?:\\(([A-Z]{3}-\\d{3})\\)\\s*)?(?:-\\s*\\$(\\d+(?:\\.\\d{2})?)\\s*(each)?)?(?:\\s*=\\s*\\$(\\d+(?:\\.\\d{2})?))?\\s*$/;
      for (i = 0; i < lines.length; i++) {
        var om = lines[i].match(orderRe);
        if (om) {
          var qty = parseInt(om[1], 10);
          var prod = findProduct(om[2]);
          var unit = om[4] ? parseFloat(om[4]) : (prod ? prod.price : 0);
          items.push({ qty: qty, name: cleanName(om[2]), product: prod, lineTotal: om[6] ? parseFloat(om[6]) : qty * unit });
        }
      }
    }
    var tm = text.match(/Total\\s*:?\\s*\\$(\\d+(?:\\.\\d{2})?)/);
    if (tm) total = parseFloat(tm[1]);
    if (items.length) {
      if (total === null) { total = 0; for (i = 0; i < items.length; i++) total += items[i].lineTotal; }
      setBasket(items, total, beat >= 3 ? 'Attempted basket' : 'Basket');
      for (i = 0; i < items.length; i++) if (items[i].product) addMenuCard(items[i].product, null);
      if (beat === 2) caption('quote');
    }
  }

  function flushBubble() {
    if (!bubbleKind) return;
    var text = bubbleBuf.join('\\n');
    bubbleKind = null; bubbleBuf = [];
    parseMenuAndBasket(text);
    addBubble('BUYER AGENT', 'agent', text);
  }

  function handleJson(d, ctx) {
    var ev = d.evaluated || {}, lim = ev.limits_applied || {};
    light('gate');
    if (ctx === 'response') {
      termWrite('Gate decision: ' + d.decision + ' (' + (d.decision_id || 'no id') + ')');
      if (typeof ev.items_total === 'number') termWrite('Checked ' + ev.items_total + ' items against a ' + (lim.items_per_day || '?') + ' item daily limit. Policy: ' + d.policy_id + '.');
      termStamp.className = 'stamp approve';
      void termStamp.offsetWidth;
      termStamp.classList.add('shown');
      termStamp.classList.add('slam');
      return;
    }
    if (typeof ev.flower_equivalent_g_total === 'number') {
      setMeter(ev.flower_equivalent_g_total, lim.flower_equivalent_g_per_day || 30, ev.infused_thc_mg_total || 0, lim.infused_thc_mg_per_day || 500);
    }
    if (d.decision === 'APPROVE') {
      setFrame('f3');
      gatePanel.classList.remove('bad');
      gatePanel.classList.add('ok');
      showReceipt(d);
      slamStamp('approve', 'APPROVED', false);
      caption('approve');
    } else if (d.decision === 'DENY') {
      setFrame('f4');
      gatePanel.classList.remove('ok');
      gatePanel.classList.add('bad');
      flowerBar.classList.add('crack');
      showReceipt(d);
      slamStamp('deny', 'DENIED', true);
      gatePanel.classList.remove('shake');
      void gatePanel.offsetWidth;
      gatePanel.classList.add('shake');
      basketBadgeEl.classList.add('show');
      payBody.textContent = 'Never opened for this order. No gate approval, no payment session.';
      caption('deny');
    }
  }

  function processLine(line) {
    logEl.textContent += line + '\\n';
    logEl.scrollTop = logEl.scrollHeight;

    if (jsonBuf) {
      jsonBuf.push(line);
      jsonDepth += braceDelta(line);
      if (jsonDepth <= 0) {
        var txt = jsonBuf.join('\\n'), ctx = jsonCtx;
        jsonBuf = null; jsonCtx = null; jsonDepth = 0;
        try { handleJson(JSON.parse(txt), ctx); } catch (e) { /* unparseable receipt: the raw log above still shows it */ }
      }
      return;
    }
    if (line.trim() === '{' && jsonCtx) { jsonBuf = [line]; jsonDepth = braceDelta(line); return; }

    if (bubbleKind) {
      if (isStructural(line)) flushBubble();
      else { bubbleBuf.push(line); return; }
    }

    var bm = line.match(/^===\\s+BEAT\\s+(\\d+)/);
    if (bm) {
      beat = parseInt(bm[1], 10);
      hudBeat.textContent = beat + ' of 4';
      if (beat === 1) { setFrame('f2'); caption('shopping'); }
      if (beat === 3) {
        receiptSlot.innerHTML = ''; receiptCardEl = null; receiptPickupEl = null;
        gateStamp.className = 'stamp';
        gatePanel.classList.remove('ok'); gatePanel.classList.add('bad');
        caption('restock');
      }
      if (beat === 4) { termCard.classList.add('show'); caption('standalone'); }
      return;
    }
    if (line.indexOf('Shopper:') === 0) {
      addBubble('MAYA', 'maya', line.slice('Shopper:'.length).trim());
      if (beat === 1) caption('shopping');
      light('model');
      return;
    }
    if (/^Buyer agent/.test(line)) {
      bubbleKind = 'agent';
      bubbleBuf = [line.replace(/^Buyer agent[^:]*:\\s*/, '')];
      light('model');
      return;
    }
    if (line.indexOf('Gate receipt:') === 0) {
      jsonCtx = 'receipt';
      caption('gate_check');
      light('gate');
      flyPacket(el('panel-store'), gatePanel, null);
      return;
    }
    if (line.indexOf('Gate response:') === 0) { jsonCtx = 'response'; termWrite('Gate response:'); light('gate'); return; }
    var ck = line.match(/^\\s*\\[(ok|FAIL)\\]\\s*(.*)$/);
    if (ck) {
      if (ck[1] === 'ok') okCount++; else failCount++;
      hudChecks.textContent = okCount + ' of ' + (okCount + failCount);
      addCheck(ck[1] === 'ok', ck[2]);
      return;
    }
    if (line.indexOf('Payment: sandbox rail confirmed') === 0) {
      var sm = line.match(/session\\s+(\\S+?)\\./);
      payCard.classList.add('lit');
      payBody.textContent = 'Sandbox payment confirmed' + (sm ? ', session ' + sm[1] : '') + '. Paid only after the gate approved.';
      caption('payment');
      light('payment');
      return;
    }
    if (line.indexOf('Order status:') === 0) {
      var pm = line.match(/Pickup code:\\s*([A-Z0-9-]+)/);
      markReceiptUsed(pm ? pm[1] : null);
      caption('pickup');
      light('payment');
      return;
    }
    if (line.indexOf('Bypass attempt:') === 0) {
      setFrame('f5');
      rogueEl.classList.add('show');
      caption('bypass_try');
      light('payment');
      return;
    }
    if (line.indexOf('Payment rail: REJECTED') === 0) {
      shutterLine.textContent = line;
      shutterEl.classList.add('down');
      stageEl.classList.add('dim');
      caption('bypass');
      light('payment');
      return;
    }
    if (line.indexOf('Equivalent call from any agent') === 0) {
      termCard.classList.add('show');
      termWrite('Equivalent call from any agent, in any framework:');
      return;
    }
    if (/^curl\\s/.test(line)) {
      termWrite(line.length > 240 ? line.slice(0, 240) + ' ...' : line);
      return;
    }
    if (line.indexOf('All four beats produced the expected outputs.') === 0) {
      allPassed = true;
      setTimeout(function () { setFrame('f6'); gatePanel.classList.remove('bad'); gatePanel.classList.add('ok'); gateStamp.className = 'stamp'; }, 1600);
      caption('finish');
      return;
    }
    if (/beat check\\(s\\) FAILED/.test(line)) { allPassed = false; return; }
    if (line.indexOf('ClearCart Protocol + ClearCart Gate') === 0) { caption('intro'); return; }
    var st = stageFor(line);
    if (st) light(st);
  }

  function resetTheater() {
    beat = 0; okCount = 0; failCount = 0; allPassed = false;
    bubbleKind = null; bubbleBuf = []; jsonBuf = null; jsonCtx = null; jsonDepth = 0;
    chatStarted = false;
    chatEl.innerHTML = '<p class="empty">Maya has not said anything yet.</p>';
    menuSeen = {};
    menuEl.innerHTML = '<p class="empty">The menu shows up here once Maya asks.</p>';
    basketItemsEl.innerHTML = '<p class="empty">Nothing in the basket yet.</p>';
    basketTotalEl.textContent = '$0';
    basketTitleEl.textContent = 'Basket';
    basketBadgeEl.classList.remove('show');
    setMeter(0, 30, 0, 500);
    flowerBar.classList.remove('crack');
    gatePanel.classList.remove('ok', 'bad', 'shake');
    gateStamp.className = 'stamp';
    gateStamp.textContent = '';
    receiptSlot.innerHTML = ''; receiptCardEl = null; receiptPickupEl = null;
    checksEl.innerHTML = '';
    payCard.classList.remove('lit');
    payBody.textContent = 'Locked. The payment rail only opens with a valid gate receipt, and it checks the signature itself.';
    rogueEl.classList.remove('show');
    shutterEl.classList.remove('down');
    stageEl.classList.remove('dim');
    termCard.classList.remove('show');
    termBody.textContent = '';
    termStamp.className = 'stamp approve';
    summaryBar.classList.remove('show');
    summaryBar.innerHTML = '';
    hudBeat.textContent = 'running';
    hudChecks.textContent = '0';
    hudCalls.textContent = 'live';
    hudTokens.textContent = 'live';
    light(null);
    caption('intro');
  }

  el('eng-toggle').addEventListener('change', function () { logEl.classList.toggle('show', this.checked); });

  button.addEventListener('click', function () {
    button.disabled = true;
    logEl.textContent = '';
    stageEl.classList.add('cut');
    statusEl.className = '';
    statusEl.textContent = 'Running. Streaming the live demo...';
    setTimeout(function () {
      resetTheater();
      setFrame('f2');
      stageEl.classList.remove('cut');
    }, 500);
    var source = new EventSource('/run');
    source.onmessage = function (event) { processLine(JSON.parse(event.data)); };
    source.addEventListener('summary', function (event) {
      var s = JSON.parse(event.data);
      if (typeof s.total_model_calls === 'number') hudCalls.textContent = String(s.total_model_calls);
      if (typeof s.total_tokens === 'number') hudTokens.textContent = String(s.total_tokens);
    });
    source.addEventListener('done', function (event) {
      var result = JSON.parse(event.data);
      source.close();
      button.disabled = false;
      if (result.busy) {
        statusEl.textContent = 'A run is already in progress. Wait for it to finish, then try again.';
        hudCalls.textContent = 'not started'; hudTokens.textContent = 'not started';
      } else if (result.code === 0) {
        statusEl.className = 'pass';
        statusEl.textContent = 'All beats passed.';
        summaryBar.innerHTML = '<b>' + (allPassed ? 'All four beats passed.' : 'Run finished.') + '</b> Checks passed: ' + okCount + ' of ' + (okCount + failCount) + '.&nbsp; <a href="https://github.com/admin-baked/clearcart-protocol" target="_blank" rel="noopener">Public repo</a> &nbsp;<a href="https://github.com/admin-baked/clearcart-protocol/tree/main/evidence/live-run-2026-11-03" target="_blank" rel="noopener">Run evidence</a>';
        summaryBar.classList.add('show');
        hudBeat.textContent = '4 of 4';
      } else {
        statusEl.className = 'fail';
        statusEl.textContent = 'Run failed (exit ' + result.code + '). See the engineer view for the raw log.';
      }
    });
    source.onerror = function () {
      source.close();
      if (button.disabled) {
        button.disabled = false;
        statusEl.className = 'fail';
        statusEl.textContent = 'Stream disconnected. Is the server still running?';
      }
    };
  });
</script>
</body>
</html>
`;

function sendLine(res: ServerResponse, line: string) {
  res.write(`data: ${JSON.stringify(line)}\n\n`);
}

function sendDone(res: ServerResponse, payload: Record<string, unknown>) {
  res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sendSummary(res: ServerResponse, payload: Record<string, unknown>) {
  res.write(`event: summary\ndata: ${JSON.stringify(payload)}\n\n`);
}

function streamRun(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  if (activeRun) {
    sendLine(res, "A run is already in progress. Please wait for it to finish.");
    sendDone(res, { busy: true });
    res.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runEvidenceDir = join(webRunsRoot, `web-run-${stamp}`);
  mkdirSync(runEvidenceDir, { recursive: true });

  const child = spawn("node", ["demo/run-demo-live.ts"], {
    cwd: repoRoot,
    env: { ...process.env, CLEARCART_EVIDENCE_DIR: runEvidenceDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeRun = child;
  let finished = false;

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  const makePump = () => {
    let buf = "";
    return (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        sendLine(res, buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    };
  };
  const pumpOut = makePump();
  const pumpErr = makePump();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", pumpOut);
  child.stderr?.on("data", pumpErr);

  child.on("error", (err) => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    sendLine(res, `Failed to start the demo: ${err.message}`);
    sendDone(res, { code: 1 });
    res.end();
    if (activeRun === child) activeRun = null;
  });

  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    // The runner writes summary.json into this run's own evidence dir at
    // the end of the run. Read the real model call and token figures from
    // it for the page HUD; retry briefly in case the write lands a beat
    // after the process exits. If it never appears, the HUD keeps its
    // running state rather than showing an invented number.
    let attempts = 0;
    const finish = () => {
      attempts += 1;
      let summary: { total_model_calls?: unknown; usage_totals?: { total_tokens?: unknown } } | null = null;
      try {
        summary = JSON.parse(readFileSync(join(runEvidenceDir, "summary.json"), "utf8"));
      } catch {
        summary = null;
      }
      if (summary === null && attempts < 5 && (code ?? 1) === 0) {
        setTimeout(finish, 300);
        return;
      }
      clearInterval(heartbeat);
      if (summary && typeof summary.total_model_calls === "number") {
        sendSummary(res, {
          total_model_calls: summary.total_model_calls,
          total_tokens:
            summary.usage_totals && typeof summary.usage_totals.total_tokens === "number"
              ? summary.usage_totals.total_tokens
              : null,
        });
      }
      sendDone(res, { code: code ?? 1 });
      res.end();
      if (activeRun === child) activeRun = null;
    };
    finish();
  });

  // If the viewer closes the page mid-run, stop the run rather than let
  // it keep spending model calls with nobody watching.
  res.on("close", () => {
    if (!finished && activeRun === child) {
      finished = true;
      clearInterval(heartbeat);
      child.kill("SIGTERM");
      activeRun = null;
    }
  });
}

const ASSET_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.url === "/run") {
    streamRun(res);
    return;
  }
  if (req.url?.startsWith("/assets/")) {
    // Lakeshore brand assets (logo, storefront photo, product packshots)
    // served from ../lakeshore-assets/. Basename-only names, image types
    // only; anything else is a 404.
    const name = decodeURIComponent(req.url.slice("/assets/".length)).split("/").pop() ?? "";
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const type = ASSET_TYPES[ext];
    const file = join(assetsDir, name);
    if (type && /^[a-z0-9._-]+$/i.test(name) && existsSync(file)) {
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ClearCart web demo listening at http://127.0.0.1:${port}`);
});
