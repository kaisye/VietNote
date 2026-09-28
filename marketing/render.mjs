import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('file://' + process.cwd() + '/intro.html');
await page.waitForTimeout(500);
const [mode, ...rest] = process.argv.slice(2);
if (mode === 'stills') {
  for (const t of rest) { await page.evaluate(t => render(t), +t); await page.screenshot({ path: `still_${t}.png` }); }
} else {
  const fps = 30, total = 30 * fps;
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', 'video.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = 0; f < total; f++) {
    await page.evaluate(t => render(t), f / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log('frame', f);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
}
await browser.close();
