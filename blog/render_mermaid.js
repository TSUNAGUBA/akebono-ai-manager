/**
 * Render Mermaid code blocks to PNG images using Node Playwright.
 * Usage: node render_mermaid.js <input.json> <output_dir>
 * input.json: array of mermaid code strings
 * Outputs: mermaid_0.png, mermaid_1.png, ... in output_dir
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3];
  const blocks = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  // Read local mermaid.min.js
  const mermaidJs = fs.readFileSync('/tmp/node_modules/mermaid/dist/mermaid.min.js', 'utf-8');

  const browser = await chromium.launch();
  const context = await browser.newContext();

  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i];
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });

    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html>
<html><head>
<script>${mermaidJs}</script>
<script>mermaid.initialize({startOnLoad:true, theme:'default'});</script>
<style>body{margin:0;background:white;display:flex;justify-content:center;padding:20px;}</style>
</head><body>
<pre class="mermaid">${escaped}</pre>
</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle' });
    try {
      await page.waitForSelector('svg', { timeout: 15000 });
      // Wait a bit for rendering to complete
      await page.waitForTimeout(500);

      const svg = await page.$('svg');
      if (svg) {
        const outPath = path.join(outputDir, `mermaid_${i}.png`);
        await svg.screenshot({ path: outPath });
        console.log(`OK: ${outPath}`);
      } else {
        console.error(`FAIL: no svg for diagram ${i}`);
      }
    } catch (e) {
      console.error(`FAIL: diagram ${i}: ${e.message}`);
    }
    await page.close();
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
