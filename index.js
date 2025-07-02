import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

console.log('✅ Server starting...');


app.post('/review', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(2000);
    const html = await page.content();

    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const screenshotBase64 = screenshot.toString('base64');

    await supabase.from('reviews').insert([
      {
        url,
        review: 'SINGLE REVIEW - APPROVED (basic load)',
        html_snapshot: html.substring(0, 3000),
        ai_raw_response: null,
        model_used: 'manual-review',
        screenshot_base64: screenshotBase64,
        gif_base64: null,
        created_at: new Date().toISOString()
      }
    ]);

    console.log(`✅ Single site review stored for ${url}`);
    res.json({ url, screenshot_base64: screenshotBase64, html: html.substring(0, 3000) });
  } catch (err) {
    console.error(`❌ Error in single review for ${url}:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.post('/batch-review', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'No URLs array provided' });

  const results = [];
  const browser = await chromium.launch();

  try {
    for (const url of urls) {
      let retries = 0;
      let success = false;
      while (retries < 3 && !success) {
        const page = await browser.newPage();
       
        await page.addInitScript(() => {
          window.require = () => ({});
          window.module = { exports: {} };
        });

        const consoleIssues = [];
        page.on('pageerror', error => {
          if (error.message.includes('require is not defined')) {
            console.log('⚠️ Ignored page error:', error.message);
          } else {
            consoleIssues.push(`[pageerror] ${error.message}`);
          }
        });

        try {
          page.on('console', msg => {
            if (['error', 'warning'].includes(msg.type())) {
              if (!msg.text().includes('require is not defined')) {
                consoleIssues.push(`[${msg.type()}] ${msg.text()}`);
              } else {
                console.log(`⚠️ Ignored console error: ${msg.text()}`);
              }
            }
          });

          const failedRequests = [];
          page.on('requestfailed', request => {
            failedRequests.push(`${request.url()} - ${request.failure()?.errorText}`);
          });

          const failedAPICalls = [];
          page.on('response', async response => {
            if (!response.ok()) {
              failedAPICalls.push(`${response.url()} - HTTP ${response.status()}`);
            }
          });

          let response;
          try {
            response = await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
          } catch (e) {
            if (e.message.includes('require is not defined')) {
              console.log('⚠️ Ignored navigation error:', e.message);
            } else {
              throw e;
            }
          }
          await page.waitForTimeout(2000);
          const status = response?.status();
          let interactivityFailed = false;
          let interactivityReasons = [];

          if (status && status >= 400) {
            interactivityFailed = true;
            interactivityReasons.push(`HTTP status code ${status}`);
          }

          const htmlBefore = await page.content();

          // scroll to bottom repeatedly until no more height change
          let lastHeight = await page.evaluate(() => {
            try { return document.body.scrollHeight; } catch (e) { return 0; }
          });
          while (true) {
            await page.evaluate(() => {
              try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
            });
            await page.waitForTimeout(1000);
            let newHeight = await page.evaluate(() => {
              try { return document.body.scrollHeight; } catch (e) { return 0; }
            });
            if (newHeight === lastHeight) break;
            lastHeight = newHeight;
          }

          // additional checks
          const imagesCount = await page.$$eval('img', imgs => imgs.length);
          if (imagesCount < 1) {
            interactivityFailed = true;
            interactivityReasons.push('No images found on page.');
          }

          const hasTextContent = await page.$eval('h1, h2, p', el => el.textContent.length > 0).catch(() => false);
          if (!hasTextContent) {
            interactivityFailed = true;
            interactivityReasons.push('No headings or paragraphs with text found.');
          }

          const pageText = await page.evaluate(() => {
            try { return document.body.innerText; } catch (e) { return ''; }
          });
          if (/404|not found|error/i.test(pageText)) {
            interactivityFailed = true;
            interactivityReasons.push('Page text contains 404 or error.');
          }

          const hasLoginForm = await page.$('form#login') !== null;
          if (!hasLoginForm) {
            interactivityFailed = true;
            interactivityReasons.push('Missing <form id="login"> on page.');
          }
          const containsWelcome = await page.evaluate(() => {
            try { return document.body.innerText.includes('Welcome'); } catch (e) { return false; }
          });
          if (!containsWelcome) {
            interactivityFailed = true;
            interactivityReasons.push('Page does not contain text "Welcome".');
          }

          // click
          const clickables = await page.$$('a, button, input[type="submit"], [role="button"], [onclick]');
          for (const el of clickables) {
            try {
              await el.click();
              await page.waitForTimeout(500);
              await el.click();
              await page.waitForTimeout(1000);
            } catch (e) {
              console.log('⚠️ Could not click element:', e.message);
            }
          }

          const inputs = await page.$$('input[type="text"], input:not([type])');
          for (const input of inputs) {
            try {
              await input.type('Hack Club Test Input');
              await page.waitForTimeout(500);
            } catch (e) {
              console.log('⚠️ Could not type into input:', e.message);
            }
          }

          // Select dropdowns
          const selects = await page.$$('select');
          for (const sel of selects) {
            try {
              const options = await sel.$$('option');
              if (options.length > 1) {
                await sel.selectOption({ index: 1 });
                await page.waitForTimeout(1000);
              }
            } catch (e) {
              console.log('⚠️ Could not select dropdown:', e.message);
            }
          }

          // submit forms
          const forms = await page.$$('form');
          for (const form of forms) {
            try {
              await form.evaluate(f => f.submit());
              await page.waitForTimeout(1000);
            } catch (e) {
              console.log('⚠️ Could not submit form:', e.message);
            }
          }

          //  scrioll
          await page.evaluate(() => { try { window.scrollTo(0, 0); } catch (e) {} });
          await page.waitForTimeout(1000);

          const newContentAppeared = await page.$('h2, h3, .card, .result, .pokemon-name, .list-item');
          if (!newContentAppeared) {
            interactivityFailed = true;
            interactivityReasons.push('Dropdowns or buttons did not produce new visible content.');
          }

          const htmlAfter = await page.content();

          if (htmlBefore === htmlAfter) {
            interactivityFailed = true;
            interactivityReasons.push('Page content did not change after interacting.');
          }

          const title = await page.title();
          if (/404|not found|error/i.test(title)) {
            interactivityFailed = true;
            interactivityReasons.push(`Page title indicates error: "${title}"`);
          }

          if (consoleIssues.length > 0) {
            console.log(`📝 Console issues (ignored for pass/fail): ${consoleIssues.join('; ')}`);
          }

          if (failedRequests.length > 0) {
            interactivityFailed = true;
            interactivityReasons.push('Failed static requests: ' + failedRequests.join('; '));
          }

          if (failedAPICalls.length > 0) {
            interactivityFailed = true;
            interactivityReasons.push('Failed API calls: ' + failedAPICalls.join('; '));
          }

          const html = htmlAfter;

          if (interactivityFailed) {
            const failScreenshot = await page.screenshot({ type: 'png', fullPage: true });
            const failPath = `fail-${encodeURIComponent(url)}.png`;
            require('fs').writeFileSync(failPath, failScreenshot);
            console.log(`📸 Saved failure screenshot: ${failPath}`);
          }

          const prompt = `You are an automated reviewer. Given this webpage content, decide only if the site successfully loads in a browser without any obvious errors. 
It does not matter if the page has minimal content, or uses JavaScript frameworks with sparse HTML—if it loads and does not show an error page, APPROVE it.

Respond exactly with:

RESULT: APPROVED

or

RESULT: DENIED
REASON: [short reason]

HTML:
${html.substring(0, 10000)}`;

          const decisions = [];

          // Openai
          {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              },
              body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
              }),
            });

            const data = await response.json();
            const raw = data.choices?.[0]?.message?.content.trim() || '';
            let decision = 'DENIED';
            let reason = null;

            if (/RESULT:\s*APPROVED/i.test(raw)) {
              decision = 'APPROVED';
            } else if (/RESULT:\s*DENIED/i.test(raw)) {
              decision = 'DENIED';
              const match = raw.match(/REASON:\s*(.+)/i);
              reason = match ? match[1].trim() : 'No reason provided';
            }

            if (interactivityFailed) {
              decision = 'DENIED';
              reason = interactivityReasons.join(' | ');
            }

            console.log(`✅ [OpenAI] Decision for ${url}: ${decision}${reason ? ' - ' + reason : ''}`);

            decisions.push({ model: 'openai-gpt-4o', decision, reason, raw });

            const finalDecision = decision;
            const combinedReasons = reason ? `OpenAI: ${reason}` : null;

            const screenshot = await page.screenshot({ type: 'png', fullPage: true });
            const screenshotBase64 = screenshot.toString('base64');

            console.log(`🏁 Final decision for ${url}: ${finalDecision}${combinedReasons ? ' - ' + combinedReasons : ''}`);

            const { error: insertError } = await supabase.from('reviews').insert([
              {
                url,
                review: finalDecision === 'APPROVED' ? 'APPROVED' : `DENIED: ${combinedReasons}`,
                html_snapshot: html.substring(0, 3000),
                ai_raw_response: JSON.stringify([{ model: 'openai-gpt-4o', decision, reason, raw }]),
                model_used: 'openai-gpt-4o',
                screenshot_base64: screenshotBase64,
                gif_base64: null,
                created_at: new Date().toISOString()
              }
            ]);
            if (insertError) {
              console.error(`❌ Supabase Insert Error for ${url}:`, insertError.message);
            } else {
              console.log(`📝 Stored final decision for ${url} with OpenAI`);
            }

            results.push({ url, finalDecision, combinedReasons, decisions: [{ model: 'openai-gpt-4o', decision, reason, raw }], screenshot_base64: screenshotBase64 });
          }
          success = true;
        } catch (err) {
          retries++;
          console.log(`⚠️ Attempt #${retries} failed for ${url}: ${err.message}`);
          await page.waitForTimeout(2000 * retries);
          if (retries === 3) {
            console.error(`🚨 Gave up on ${url} after 3 attempts.`);
            const { error: insertError } = await supabase.from('reviews').insert([
              {
                url,
                review: 'DENIED: Failed to load page',
                html_snapshot: null,
                ai_raw_response: null,
                model_used: 'none',
                screenshot_base64: null,
                gif_base64: null,
                created_at: new Date().toISOString()
              }
            ]);
            if (insertError) {
              console.error(`❌ Supabase Insert Error for ${url}:`, insertError.message);
            }
            results.push({
              url,
              finalDecision: 'DENIED',
              combinedReasons: 'Failed to load page: ' + err.message,
              decisions: [],
              screenshot_base64: null
            });
          }
        } finally {
          await page.close();
        }
      }
    }

    let summary = results.map(r => {
      return `\n🔗 ${r.url}\n   ➜ Decision: ${r.finalDecision}${r.combinedReasons ? ' - ' + r.combinedReasons : ''}`;
    }).join('\n');
    console.log(summary);
    const total = results.length;
    const passed = results.filter(r => r.finalDecision === 'APPROVED').length;
    const failed = total - passed;
    console.log(`\n✅ SUMMARY: ${passed}/${total} passed, ${failed} failed.`);
    res.send(summary);
  } catch (err) {
    console.error('❌ BATCH REVIEW ERROR:', err);
    res.status(500).json({ error: 'Batch review failed', details: err.message });
  } finally {
    await browser.close();
  }
});



app.use(express.static('public'));

// Recent reviews API endpoint
app.get('/api/recent-reviews', async (req, res) => {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('❌ Error fetching recent reviews:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => {
  console.log('Striker is running at http://localhost:3000');
});


// by @rushmore