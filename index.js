import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

console.log('✅ Server starting...');


async function safePageEvaluate(page, script, defaultValue = null) {
  try {
    return await page.evaluate(script);
  } catch (e) {
    console.log('⚠️ Safe evaluate failed:', e.message);
    return defaultValue;
  }
}

async function safeElementAction(element, action, ...args) {
  try {
    await element[action](...args);
    return true;
  } catch (e) {
    console.log(`⚠️ Could not ${action} element:`, e.message);
    return false;
  }
}

app.post('/review', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const html = await page.content();

    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const screenshotBase64 = screenshot.toString('base64');

    const { error: insertError } = await supabase.from('reviews').insert([
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

    if (insertError) {
      console.error('❌ Supabase Insert Error:', insertError.message);
    }

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
  const browser = await chromium.launch({ headless: true });

  try {
    for (const url of urls) {
      console.log(`🔍 Testing ${url}...`);
      let success = false;
      let attempts = 0;
      const maxAttempts = 3;

      while (!success && attempts < maxAttempts) {
        attempts++;
        const page = await browser.newPage();

        const consoleIssues = [];
        const failedRequests = [];
        const failedAPICalls = [];


        page.on('pageerror', error => {
          if (!error.message.includes('require is not defined')) {
            consoleIssues.push(`[pageerror] ${error.message}`);
          }
        });

        page.on('console', msg => {
          if (['error', 'warning'].includes(msg.type())) {
            if (!msg.text().includes('require is not defined')) {
              consoleIssues.push(`[${msg.type()}] ${msg.text()}`);
            }
          }
        });

        page.on('requestfailed', request => {
          failedRequests.push(`${request.url()} - ${request.failure()?.errorText || 'Unknown error'}`);
        });

        page.on('response', async response => {
          if (!response.ok() && response.status() >= 400) {
            failedAPICalls.push(`${response.url()} - HTTP ${response.status()}`);
          }
        });

        try {

          const response = await page.goto(url, { 
            waitUntil: 'networkidle', 
            timeout: 15000 
          });
          
          await page.waitForTimeout(2000);
          
          const status = response?.status() || 0;
          let interactivityFailed = false;
          let interactivityReasons = [];


          if (status >= 400) {
            interactivityFailed = true;
            interactivityReasons.push(`HTTP status code ${status}`);
          }

          const htmlBefore = await page.content();

          // scroll
          await page.evaluate(() => {
            return new Promise((resolve) => {
              let totalHeight = 0;
              const distance = 100;
              const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                  clearInterval(timer);
                  resolve();
                }
              }, 100);
            });
          });

          await page.waitForTimeout(1500);


          const pageMetrics = await page.evaluate(() => {
            const images = document.querySelectorAll('img').length;
            const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
            const paragraphs = document.querySelectorAll('p').length;
            const bodyText = document.body.innerText || '';
            const title = document.title || '';
            const hasLoginForm = !!document.querySelector('form#login, form[action*="login"], input[type="password"]');
            
            return {
              images,
              headings,
              paragraphs,
              bodyText: bodyText.substring(0, 500),
              title,
              hasLoginForm,
              containsWelcome: bodyText.toLowerCase().includes('welcome'),
              hasErrorIndicators: /404|not found|error|oops/i.test(bodyText + ' ' + title)
            };
          });

          if (pageMetrics.images < 1 && pageMetrics.headings < 1 && pageMetrics.paragraphs < 1) {
            interactivityFailed = true;
            interactivityReasons.push('Page appears to have minimal content');
          }

          if (pageMetrics.hasErrorIndicators) {
            interactivityFailed = true;
            interactivityReasons.push('Page contains error indicators');
          }

          // element testing
          const clickables = await page.$$('a:not([href="#"]), button:not([disabled]), input[type="submit"]:not([disabled]), [role="button"]:not([disabled])');
          let clickedElements = 0;
          
          for (const el of clickables.slice(0, 5)) { // clickable
            const clicked = await safeElementAction(el, 'click');
            if (clicked) {
              clickedElements++;
              await page.waitForTimeout(500);
            }
          }

          // forms
          const textInputs = await page.$$('input[type="text"], input[type="email"], input:not([type]), textarea');
          for (const input of textInputs.slice(0, 3)) { // Limit to first 3 inputs
            await safeElementAction(input, 'fill', 'Hack Club Test Input');
            await page.waitForTimeout(300);
          }

          // dropdown
          const selects = await page.$$('select');
          for (const select of selects.slice(0, 2)) { 
            try {
              const options = await select.$$('option');
              if (options.length > 1) {
                await select.selectOption({ index: 1 });
                await page.waitForTimeout(500);
              }
            } catch (e) {
              console.log('⚠️ Could not interact with dropdown:', e.message);
            }
          }

          
          await page.waitForTimeout(1000);
          const htmlAfter = await page.content();
          
          
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(500);

         
          const newContentAppeared = await page.$('.card, .result, .list-item, .dynamic-content, [data-testid]') !== null;

          
          if (htmlBefore === htmlAfter && clickedElements === 0) {
            interactivityFailed = true;
            interactivityReasons.push('No content changes detected after interactions');
          }

          if (failedRequests.length > 5) {
            interactivityFailed = true;
            interactivityReasons.push(`Too many failed requests: ${failedRequests.length}`);
          }

          if (failedAPICalls.length > 3) { 
            interactivityFailed = true;
            interactivityReasons.push(`Multiple API failures: ${failedAPICalls.length}`);
          }

          // AI Review
          const prompt = `You are an automated website reviewer for Hack Club projects. Analyze this webpage and determine if it successfully loads and functions without critical errors.

APPROVAL CRITERIA:
- Page loads without critical errors
- Has basic content (text, images, or interactive elements)
- Not showing 404/error pages
- Basic functionality appears to work

Respond exactly with:
RESULT: APPROVED
or
RESULT: DENIED
REASON: [brief reason]

Page Title: ${pageMetrics.title}
Page Status: HTTP ${status}
Content Summary: ${pageMetrics.headings} headings, ${pageMetrics.paragraphs} paragraphs, ${pageMetrics.images} images
Has Interactive Elements: ${clickedElements > 0 ? 'Yes' : 'No'}
Error Indicators: ${pageMetrics.hasErrorIndicators ? 'Yes' : 'No'}

HTML Sample:
${htmlAfter.substring(0, 8000)}`;

          let finalDecision = 'APPROVED';
          let aiReason = null;
          let aiRawResponse = '';

          try {
            const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              },
              body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 150,
                temperature: 0.1
              }),
            });

            if (openaiResponse.ok) {
              const data = await openaiResponse.json();
              aiRawResponse = data.choices?.[0]?.message?.content?.trim() || '';
              
              if (/RESULT:\s*APPROVED/i.test(aiRawResponse)) {
                finalDecision = 'APPROVED';
              } else if (/RESULT:\s*DENIED/i.test(aiRawResponse)) {
                finalDecision = 'DENIED';
                const match = aiRawResponse.match(/REASON:\s*(.+)/i);
                aiReason = match ? match[1].trim() : 'No reason provided';
              }
            } else {
              console.error('❌ OpenAI API Error:', openaiResponse.status);
              finalDecision = 'DENIED';
              aiReason = 'AI review failed';
            }
          } catch (aiError) {
            console.error('❌ AI Review Error:', aiError.message);
            finalDecision = 'DENIED';
            aiReason = 'AI review error';
          }


          if (interactivityFailed) {
            finalDecision = 'DENIED';
            aiReason = interactivityReasons.join(' | ');
          }


          const screenshot = await page.screenshot({ type: 'png', fullPage: true });
          const screenshotBase64 = screenshot.toString('base64');

          if (finalDecision === 'DENIED') {
            const failPath = `fail-${Date.now()}-${encodeURIComponent(url.replace(/[^a-zA-Z0-9]/g, '_'))}.png`;
            fs.writeFileSync(failPath, screenshot);
            console.log(`📸 Saved failure screenshot: ${failPath}`);
          }


          const reviewText = finalDecision === 'APPROVED' ? 'APPROVED' : `DENIED: ${aiReason}`;
          const { error: insertError } = await supabase.from('reviews').insert([
            {
              url,
              review: reviewText,
              html_snapshot: htmlAfter.substring(0, 3000),
              ai_raw_response: JSON.stringify({ decision: finalDecision, reason: aiReason, raw: aiRawResponse }),
              model_used: 'openai-gpt-4o',
              screenshot_base64: screenshotBase64,
              gif_base64: null,
              created_at: new Date().toISOString()
            }
          ]);

          if (insertError) {
            console.error(`❌ Supabase Insert Error for ${url}:`, insertError.message);
          }

          console.log(`✅ [${finalDecision}] ${url}${aiReason ? ' - ' + aiReason : ''}`);
          
          results.push({
            url,
            finalDecision,
            combinedReasons: aiReason,
            decisions: [{ model: 'openai-gpt-4o', decision: finalDecision, reason: aiReason, raw: aiRawResponse }],
            screenshot_base64: screenshotBase64
          });

          success = true;

        } catch (err) {
          console.log(`⚠️ Attempt ${attempts}/${maxAttempts} failed for ${url}: ${err.message}`);
          
          if (attempts === maxAttempts) {
            console.error(`🚨 Failed to test ${url} after ${maxAttempts} attempts`);
            
          
            const { error: insertError } = await supabase.from('reviews').insert([
              {
                url,
                review: `DENIED: Failed to load - ${err.message}`,
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
              combinedReasons: `Failed to load: ${err.message}`,
              decisions: [],
              screenshot_base64: null
            });
          } else {
            await page.waitForTimeout(2000 * attempts);
          }
        } finally {
          await page.close();
        }
      }
    }


    const summary = results.map(r => 
      `🔗 ${r.url}\n   ➜ ${r.finalDecision}${r.combinedReasons ? ' - ' + r.combinedReasons : ''}`
    ).join('\n\n');

    const total = results.length;
    const passed = results.filter(r => r.finalDecision === 'APPROVED').length;
    const failed = total - passed;

    const finalSummary = `${summary}\n\n✅ SUMMARY: ${passed}/${total} passed, ${failed} failed.`;
    console.log(finalSummary);
    
    res.json({
      summary: finalSummary,
      results,
      stats: { total, passed, failed }
    });

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
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('❌ Error fetching recent reviews:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error('❌ API Error:', err);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Striker is running at http://localhost:${PORT}`);
});

// by @rushmore