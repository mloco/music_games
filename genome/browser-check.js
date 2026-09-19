/* Browser smoke-check for Genome's challenge mode.
   Run after starting a static server in the repo root:
     python3 -m http.server 8823
     node genome/browser-check.js
   (playwright-core is resolved from the gstack skill's node_modules.)
 */
const path = require("path");
const { chromium } = require("/Users/manlioloconte/.claude/skills/gstack/node_modules/playwright-core");

const BASE = "http://127.0.0.1:8823";

function fmt(c) {
  return `E(${c.k},${c.n},φ${c.phase}) f1=${c.score.f1.toFixed(3)}`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", err => consoleErrors.push(String(err)));

  // 1. Instrument mode loads without errors.
  await page.goto(`${BASE}/genome/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  if (await page.locator("#instrumentMode").isVisible()) {
    console.log("PASS instrument mode visible");
  } else {
    console.log("FAIL instrument mode not visible");
    process.exitCode = 1;
  }

  // 2. Switch to challenge mode.
  await page.click("#modeChallenge");
  await page.waitForTimeout(200);
  const challengeVisible = await page.locator("#challengeMode").isVisible();
  console.log(challengeVisible ? "PASS challenge mode visible" : "FAIL challenge mode");

  // 3. World necklace rendered / label correct.
  const worldLabel = await page.textContent("#chWorldLabel");
  console.log(worldLabel.includes("E(5,16)") ? `PASS world label: ${worldLabel}` : `FAIL world label: ${worldLabel}`);

  // 4. Population cards built.
  const cardCount = await page.locator("#chPopGrid .ch-creature").count();
  console.log(cardCount === 8 ? "PASS 8 population cards" : `FAIL cards=${cardCount}`);

  // 5. Greedy solve through the live UI: each generation breed the two best.
  const budget = 12;
  let gen = 0;
  let won = false;
  for (gen = 0; gen < budget; gen++) {
    // Read ranks from the DOM (card sub captions: "match N% · hits ...").
    const subTexts = await page.$$eval("#chPopGrid .ch-creature", cards =>
      cards.map(card => card.querySelector(".sub").textContent)
    );
    const pcts = subTexts.map(t => parseInt(t.match(/match (\d+)%/)[1], 10));
    const cardTexts = await page.$$eval("#chPopGrid .ch-creature", cards =>
      cards.map(card => card.querySelector(".cap").textContent)
    );
    const ranked = pcts.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
    const [pa, pb] = [ranked[0][1], ranked[1][1]];
    const before = cardTexts[pa] + " x " + cardTexts[pb];
    await page.keyboard.press(String(pa + 1));
    await page.keyboard.press(String(pb + 1));
    await page.click("#chBreed");
    await page.waitForTimeout(50);
    const status = await page.textContent("#chBannerText");
    const parents = await page.textContent("#chParents");
    const genTxt = await page.textContent("#chGen");
    if (gen === 0) console.log(`gen1 bred ${before} -> parents now ${parents}`);
    if (status && status.length > 0) {
      console.log(`BANNER: ${status}`);
      won = status.includes("Perfect match");
      break;
    }
    if (genTxt.trim() !== String(gen + 1)) {
      console.log(`FAIL generation accounting: expected ${gen + 1} got ${genTxt}`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(won ? `PASS greedy solve won at generation ${gen + 1}` : "FAIL greedy solve did not win in budget");

  // 6. Restart reproduces a fresh run (generation back to 0).
  await page.click("#chRestart");
  await page.waitForTimeout(100);
  const genAfter = await page.textContent("#chGen");
  console.log(genAfter.trim() === "0" ? "PASS restart resets to gen 0" : `FAIL restart gen=${genAfter}`);

  // 7. Number-key parent selection (keyboard operability).
  await page.keyboard.press("1");
  await page.keyboard.press("2");
  const parents2 = await page.textContent("#chParents");
  console.log(parents2.includes("B: E") ? `PASS keyboard selection: ${parents2}` : `FAIL keyboard selection: ${parents2}`);

  // 8. Return to instrument mode still works (no JS errors thrown anywhere).
  await page.click("#modeInstrument");
  await page.waitForTimeout(200);
  console.log(consoleErrors.length === 0 ? "PASS no console errors" : `FAIL console errors: ${consoleErrors.join(" | ")}`);

  await browser.close();
  process.exit();
})();