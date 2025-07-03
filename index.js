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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);


function rateLimit(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(clientIP)) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const clientData = rateLimitMap.get(clientIP);
  
  if (now > clientData.resetTime) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded', 
      message: `Too many requests. Try again in ${Math.ceil((clientData.resetTime - now) / 1000)} seconds.` 
    });
  }
  
  clientData.count++;
  next();
}

async function safePageEvaluate(page, script, defaultValue = null, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const result = await Promise.race([
        page.evaluate(script),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Evaluation timeout')), 5000))
      ]);
      return result;
    } catch (e) {
      if (i === retries) {
        console.log(`⚠️ Safe evaluate failed after ${retries} retries:`, e.message);
        return defaultValue;
      }
      await page.waitForTimeout(Math.min(500 * (i + 1), 2000));
    }
  }
}

async function safeElementEvaluate(element, script, defaultValue = null, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const result = await Promise.race([
        element.evaluate(script),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Evaluation timeout')), 5000))
      ]);
      return result;
    } catch (e) {
      if (i === retries) {
        console.log(`⚠️ Safe element evaluate failed after ${retries} retries:`, e.message);
        return defaultValue;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * (i + 1), 2000)));
    }
  }
}

async function safeElementAction(element, action, ...args) {
  try {
    await Promise.race([
      element[action](...args),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Action timeout')), 3000))
    ]);
    return true;
  } catch (e) {
    console.log(`⚠️ Could not ${action} element:`, e.message);
    return false;
  }
}

async function performAdvancedScrolling(page) {
  console.log('🔄 Performing optimized scrolling...');
  
  try {
    const dimensions = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));

    if (dimensions.scrollHeight > dimensions.clientHeight) {
      await page.evaluate((scrollHeight) => {
        return new Promise((resolve) => {
          let currentScroll = 0;
          const step = Math.max(200, scrollHeight / 10);
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            currentScroll += step;
            if (currentScroll >= scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      }, dimensions.scrollHeight);

      await page.waitForTimeout(800);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await page.waitForTimeout(300);

      if (dimensions.scrollWidth > dimensions.clientWidth) {
        await page.evaluate(() => window.scrollTo(document.body.scrollWidth / 2, window.scrollY));
        await page.waitForTimeout(300);
      }

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    }
  } catch (error) {
    console.log('⚠️ Scrolling error:', error.message);
  }
}

async function interactWithForms(page) {
  console.log('📝 Enhanced form interaction...');
  
  const formData = {
    text: ['Test User', 'John Doe', 'Sample Text', 'Hello World'],
    email: ['test@hackclub.com', 'demo@example.com', 'user@test.com'],
    password: ['TestPass123!', 'SecurePassword456'],
    number: ['42', '100', '2024', '123'],
    tel: ['555-0123', '(123) 456-7890'],
    url: ['https://hackclub.com', 'https://example.com'],
    search: ['hackclub', 'test search', 'sample query'],
    date: ['2024-01-01', '2023-12-25'],
    time: ['14:30', '09:15'],
    color: ['#ff0000', '#00ff00', '#0000ff']
  };

  try {
    const inputTypes = ['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'date', 'time', 'color'];
    
    for (const inputType of inputTypes) {
      const selector = inputType === 'text' 
        ? `input[type="${inputType}"], input:not([type]):not([readonly]):not([disabled])`
        : `input[type="${inputType}"]:not([readonly]):not([disabled])`;
        
      const inputs = await page.$$(selector);
      
      for (let i = 0; i < Math.min(inputs.length, 2); i++) {
        const input = inputs[i];
        const testData = formData[inputType] || formData.text;
        const value = testData[i % testData.length];
        
        const isInteractable = await safeElementEvaluate(input, (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && 
                 style.visibility !== 'hidden' && 
                 style.display !== 'none' &&
                 !el.disabled && !el.readOnly;
        }, false);
        
        if (isInteractable) {
          await safeElementAction(input, 'scrollIntoViewIfNeeded');
          await safeElementAction(input, 'focus');
          await page.waitForTimeout(100);
          await safeElementAction(input, 'fill', value);
          await page.waitForTimeout(150);
          
          await safeElementAction(input, 'press', 'Tab');
          await page.waitForTimeout(100);
        }
      }
    }

    const textareas = await page.$$('textarea:not([readonly]):not([disabled])');
    const longText = 'This is a comprehensive test of textarea functionality. Testing multi-line input with various characters and length to ensure proper form handling.';
    
    for (let i = 0; i < Math.min(textareas.length, 2); i++) {
      const textarea = textareas[i];
      const isVisible = await safeElementEvaluate(textarea, (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, false);
      
      if (isVisible) {
        await safeElementAction(textarea, 'scrollIntoViewIfNeeded');
        await safeElementAction(textarea, 'fill', longText);
        await page.waitForTimeout(200);
      }
    }

    const selects = await page.$$('select:not([disabled])');
    for (const select of selects.slice(0, 3)) {
      try {
        const options = await select.$$('option');
        if (options.length > 1) {
          const optionIndex = Math.min(2, options.length - 1);
          await safeElementAction(select, 'selectOption', { index: optionIndex });
          await page.waitForTimeout(200);
        }
      } catch (e) {
        console.log('⚠️ Select interaction failed:', e.message);
      }
    }

    const checkboxes = await page.$$('input[type="checkbox"]:not([disabled])');
    for (let i = 0; i < Math.min(checkboxes.length, 3); i++) {
      const checkbox = checkboxes[i];
      const isVisible = await safeElementEvaluate(checkbox, (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, false);
      
      if (isVisible) {
        await safeElementAction(checkbox, 'check');
        await page.waitForTimeout(150);
      }
    }

    const radios = await page.$$('input[type="radio"]:not([disabled])');
    const radioGroups = new Set();
    for (const radio of radios) {
      try {
        const name = await radio.getAttribute('name');
        if (name && !radioGroups.has(name) && radioGroups.size < 3) {
          radioGroups.add(name);
          await safeElementAction(radio, 'check');
          await page.waitForTimeout(150);
        }
      } catch (e) {
        console.log('⚠️ Radio interaction failed:', e.message);
      }
    }

    return true;
  } catch (error) {
    console.log('⚠️ Form interaction error:', error.message);
    return false;
  }
}

async function performDeepNavigation(page, baseUrl, maxDepth = 2, currentDepth = 0, visitedUrls = new Set()) {
  if (currentDepth >= maxDepth) return [];
  
  console.log(`🔍 Deep navigation (depth ${currentDepth + 1}/${maxDepth})...`);
  const visitedPages = [];
  
  try {
    const links = await page.$$eval('a[href]', (anchors, base, visited) => {
      return anchors
        .map(a => {
          try {
            const href = new URL(a.href, base).href;
            return href;
          } catch {
            return null;
          }
        })
        .filter(href => {
          if (!href) return false;
          try {
            const url = new URL(href);
            const baseUrl = new URL(base);
            return url.hostname === baseUrl.hostname && 
                   !href.includes('#') && 
                   !href.includes('mailto:') && 
                   !href.includes('tel:') &&
                   !href.match(/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx|ppt|pptx)$/i) &&
                   !visited.has(href) &&
                   href !== base;
          } catch {
            return false;
          }
        })
        .slice(0, 3);
    }, baseUrl, Array.from(visitedUrls));

    for (const link of links) {
      if (visitedUrls.has(link)) continue;
      visitedUrls.add(link);
      
      try {
        console.log(`🔗 Navigating to: ${link}`);
        
        const response = await page.goto(link, { 
          waitUntil: 'domcontentloaded', 
          timeout: 8000 
        });
        
        if (!response || response.status() >= 400) {
          console.log(`⚠️ Failed to load ${link}: HTTP ${response?.status()}`);
          continue;
        }
        
        await page.waitForTimeout(1000);
        
        await performAdvancedScrolling(page);
        const clickedElements = await testPageInteractivity(page);
        
        const pageInfo = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title || 'Untitled',
          hasForm: !!document.querySelector('form'),
          hasButtons: document.querySelectorAll('button, input[type="submit"]').length,
          hasNavigation: !!document.querySelector('nav, .navigation, .navbar, .menu'),
          loadTime: performance.now()
        }));
        
        pageInfo.clickedElements = clickedElements;
        visitedPages.push(pageInfo);
        
        if (currentDepth < maxDepth - 1) {
          const subPages = await performDeepNavigation(page, link, maxDepth, currentDepth + 1, visitedUrls);
          visitedPages.push(...subPages);
        }
        
      } catch (e) {
        console.log(`⚠️ Navigation failed for ${link}:`, e.message);
      }
    }
  } catch (error) {
    console.log('⚠️ Deep navigation error:', error.message);
  }
  
  return visitedPages;
}

async function testPageInteractivity(page) {
  console.log('🖱️ Testing page interactivity...');
  
  const buttonSelectors = [
    'button:not([disabled]):not([hidden])',
    'input[type="submit"]:not([disabled])',
    'input[type="button"]:not([disabled])',
    '[role="button"]:not([disabled]):not([hidden])',
    'a[href]:not([href="#"]):not([href="javascript:void(0)"])',
    '.btn:not([disabled]):not(.disabled)',
    '.button:not([disabled]):not(.disabled)'
  ];

  let clickedElements = 0;
  
  try {
    for (const selector of buttonSelectors) {
      const elements = await page.$$(selector);
      
      for (let i = 0; i < Math.min(elements.length, 2); i++) {
        const element = elements[i];
        
        try {
          const isClickable = await safeElementEvaluate(element, (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            
            return rect.width > 0 && 
                   rect.height > 0 && 
                   style.visibility !== 'hidden' && 
                   style.display !== 'none' &&
                   style.pointerEvents !== 'none' &&
                   rect.top < window.innerHeight &&
                   rect.left < window.innerWidth;
          }, false);
          
          if (isClickable) {
            await safeElementAction(element, 'scrollIntoViewIfNeeded');
            await page.waitForTimeout(200);
            await safeElementAction(element, 'hover');
            await page.waitForTimeout(150);
            const clicked = await safeElementAction(element, 'click');
            if (clicked) {
              clickedElements++;
              await page.waitForTimeout(600);
              const modal = await page.$('.modal, .popup, .dialog, [role="dialog"], .overlay');
              if (modal) {
                console.log('🔮 Modal detected, attempting to close...');
                const closeSelectors = [
                  '.modal .close', '.popup .close', '[aria-label*="close" i]',
                  '.modal button[data-dismiss]', '.overlay .close-btn',
                  'button[data-bs-dismiss="modal"]'
                ];
                for (const closeSelector of closeSelectors) {
                  const closeBtn = await page.$(closeSelector);
                  if (closeBtn) {
                    await safeElementAction(closeBtn, 'click');
                    await page.waitForTimeout(300);
                    break;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.log(`⚠️ Element interaction failed:`, e.message);
        }
      }
    }
  } catch (error) {
    console.log('⚠️ Interactivity testing error:', error.message);
  }
  
  return clickedElements;
}

async function simulateUserBehavior(page) {
  console.log('👤 Simulating user behavior...');
  
  try {
    const viewport = page.viewportSize();
    await page.mouse.move(viewport.width * 0.1, viewport.height * 0.1);
    await page.waitForTimeout(150);
    await page.mouse.move(viewport.width * 0.3, viewport.height * 0.2);
    await page.waitForTimeout(150);
    await page.mouse.move(viewport.width * 0.7, viewport.height * 0.5);
    await page.waitForTimeout(150);
    
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    
    await page.waitForTimeout(800);
  } catch (error) {
    console.log('⚠️ User simulation error:', error.message);
  }
}

function generateAIPrompt(pageMetrics, status, clickedElements, visitedPages, deepTest, failedRequests, consoleIssues, htmlSample) {
  return `You are testing website functionality for Hack Club projects.

ALWAYS respond in EXACTLY one of these formats:
RESULT: APPROVED
OR
RESULT: DENIED
REASON: [short, specific reason]

EVALUATION CRITERIA:
✅ APPROVE if:
- Page loads successfully (HTTP 200-299)
- If interactive features (forms, buttons, links) are present, they work correctly (can be clicked, submitted, etc.)
- If there are no interactive elements at all, that is acceptable

❌ DENY if:
- HTTP status is 400 or above
- Page fails to load completely
- Forms exist but cannot be submitted or interacted with
- Buttons exist but none are clickable
- Critical JavaScript errors prevent functionality (e.g. 5+ console errors)

WHEN WRITING THE REASON:
Be precise. Mention HTTP codes, count of non-working elements, or number of JavaScript errors.

EXAMPLES:
- RESULT: APPROVED
- RESULT: DENIED
  REASON: HTTP 404 - page not found

- RESULT: DENIED
  REASON: 3 buttons found but none clickable

- RESULT: DENIED
  REASON: 8 console errors blocking scripts

WEBSITE ANALYSIS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Technical Metrics:
• HTTP Status: ${status}
• Page Title: "${pageMetrics.title}"
• Interactive Elements: ${pageMetrics.forms} forms, ${pageMetrics.buttons} buttons, ${pageMetrics.links} links
• User Interactions: ${clickedElements} successful clicks
• Navigation: ${pageMetrics.hasNavigation ? 'Present' : 'Not found'}

🔧 Functionality Test Results:
• Dynamic Features: ${pageMetrics.hasDynamicElements ? 'Working' : 'Not detected'}
• Interactive Features: ${pageMetrics.hasInteractiveFeatures ? 'Working' : 'Not detected'}
• Form Functionality: ${pageMetrics.forms > 0 ? 'Forms present and tested' : 'No forms'}
• Button Functionality: ${pageMetrics.buttons > 0 ? 'Buttons present and tested' : 'No buttons'}

⚠️ Technical Issues:
• Failed Requests: ${failedRequests.length}
• Console Errors: ${consoleIssues.length}
${deepTest ? `• Deep Navigation: Tested ${visitedPages.length} additional pages` : ''}

📝 HTML Sample (first 4000 chars):
${htmlSample.substring(0, 4000)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Focus ONLY on functionality - does everything work? Ignore content quality.`;
}

app.post('/batch-review', rateLimit, async (req, res) => {
  const { urls, deepTest = false, maxDepth = 2 } = req.body;
  
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'No URLs array provided' });
  }

  if (urls.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 URLs allowed per batch' });
  }

  const results = [];
  let browser;

  try {
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-dev-shm-usage'
      ]
    });

    for (const url of urls) {
      console.log(`🔍 Enhanced testing ${url}...`);
      let success = false;
      let attempts = 0;
      const maxAttempts = 2;

      while (!success && attempts < maxAttempts) {
        attempts++;
        const page = await browser.newPage();

        try {
          await page.setViewportSize({ width: 1280, height: 720 });
          await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          });

          const issues = {
            console: [],
            requests: [],
            api: []
          };
          
          let visitedPages = [];

          page.on('pageerror', error => {
            if (!error.message.includes('require is not defined') && 
                !error.message.includes('Script error')) {
              issues.console.push(`[pageerror] ${error.message}`);
            }
          });

          page.on('console', msg => {
            if (['error', 'warning'].includes(msg.type())) {
              const text = msg.text();
              if (!text.includes('require is not defined') && 
                  !text.includes('favicon') &&
                  !text.includes('Script error')) {
                issues.console.push(`[${msg.type()}] ${text}`);
              }
            }
          });

          page.on('requestfailed', request => {
            const url = request.url();
            if (!url.includes('favicon') && !url.includes('analytics')) {
              issues.requests.push(`${url} - ${request.failure()?.errorText || 'Unknown'}`);
            }
          });

          page.on('response', response => {
            if (!response.ok() && response.status() >= 400) {
              const url = response.url();
              if (!url.includes('favicon') && !url.includes('analytics')) {
                issues.api.push(`${url} - HTTP ${response.status()}`);
              }
            }
          });

          const response = await page.goto(url, { 
            waitUntil: 'domcontentloaded', 
            timeout: 15000 
          });
          
          await page.waitForTimeout(1500);
          
          const status = response?.status() || 0;
          let functionalityFailed = false;
          let functionalityReasons = [];

          if (status >= 400) {
            functionalityFailed = true;
            functionalityReasons.push(`HTTP ${status} - Page failed to load`);
          }

          const htmlBefore = await page.content();

          await performAdvancedScrolling(page);
          await simulateUserBehavior(page);
          const formSuccess = await interactWithForms(page);
          const clickedElements = await testPageInteractivity(page);

          if (deepTest) {
            try {
              const navResults = await performDeepNavigation(page, url, Math.min(maxDepth, 3));
              visitedPages = navResults;
              console.log(`🗺️ Visited ${navResults.length} additional pages`);
            } catch (navError) {
              console.log('⚠️ Navigation error:', navError.message);
            }
          }

          const pageMetrics = await page.evaluate(() => {
            const elements = {
              images: document.querySelectorAll('img').length,
              headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
              paragraphs: document.querySelectorAll('p').length,
              forms: document.querySelectorAll('form').length,
              buttons: document.querySelectorAll('button, input[type="submit"], input[type="button"]').length,
              links: document.querySelectorAll('a[href]').length
            };

            const text = document.body.innerText || '';
            const title = document.title || '';
            
            return {
              ...elements,
              bodyText: text.substring(0, 500),
              title,
              contentLength: text.length,
              hasLoginForm: !!document.querySelector('form#login, form[action*="login"], input[type="password"]'),
              hasDynamicElements: !!(
                document.querySelector('.loading, .spinner, [data-loading]') ||
                document.querySelector('[data-testid], [data-cy]') ||
                document.querySelector('.react-root, #root, #app')
              ),
              hasInteractiveFeatures: !!(
                document.querySelector('canvas') ||
                document.querySelector('video, audio') ||
                document.querySelector('.carousel, .slider') ||
                document.querySelector('[role="tabpanel"], [role="tab"]')
              ),
              hasNavigation: !!document.querySelector('nav, .navigation, .navbar, .menu')
            };
          });

          if (clickedElements === 0 && pageMetrics.buttons > 0) {
            functionalityFailed = true;
            functionalityReasons.push('Buttons present but none are clickable');
          }

          if (issues.console.filter(e => e.includes('[error]')).length > 5) {
            functionalityFailed = true;
            functionalityReasons.push(`Critical JavaScript errors (${issues.console.filter(e => e.includes('[error]')).length} errors)`);
          }

          const htmlAfter = await page.content();

          let finalDecision = 'APPROVED';
          let aiReason = null;
          let aiRawResponse = '';

          if (process.env.OPENAI_API_KEY) {
            try {
              const prompt = generateAIPrompt(
                pageMetrics, status, clickedElements, visitedPages, 
                deepTest, issues.requests, issues.console, htmlAfter
              );

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
                  aiReason = match ? match[1].trim() : 'Functionality issues detected';
                }
              } else {
                console.error('❌ OpenAI API Error:', openaiResponse.status);
              }
            } catch (aiError) {
              console.error('❌ AI Review Error:', aiError.message);
            }
          }

          if (functionalityFailed) {
            finalDecision = 'DENIED';
            aiReason = functionalityReasons.join(' | ');
          }

          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(300);
          const screenshot = await page.screenshot({ 
            type: 'png', 
            fullPage: false
          });
          const screenshotBase64 = screenshot.toString('base64');

          const reviewText = finalDecision === 'APPROVED' ? 
            `APPROVED - Functionality Testing` : 
            `DENIED: ${aiReason}`;

          const dbRecord = {
            url,
            review: reviewText,
            html_snapshot: htmlAfter.substring(0, 4000),
            ai_raw_response: JSON.stringify({ 
              decision: finalDecision, 
              reason: aiReason, 
              raw: aiRawResponse,
              metrics: pageMetrics,
              visitedPages: visitedPages.length,
              clickedElements,
              enhancedTesting: true,
              deepTest,
              issues: {
                console: issues.console.length,
                requests: issues.requests.length,
                api: issues.api.length
              },
              formSuccess,
              timestamp: new Date().toISOString()
            }),
            model_used: process.env.OPENAI_API_KEY ? 'openai-gpt-4o-enhanced' : 'local-enhanced',
            screenshot_base64: screenshotBase64,
            gif_base64: null,
            created_at: new Date().toISOString()
          };

          let insertAttempts = 0;
          const maxInsertAttempts = 2;
          
          while (insertAttempts < maxInsertAttempts) {
            try {
              const { error: insertError } = await supabase.from('reviews').insert([dbRecord]);
              if (!insertError) break;
              
              insertAttempts++;
              if (insertAttempts === maxInsertAttempts) {
                console.error(`❌ Supabase Insert Error for ${url}:`, insertError.message);
              }
            } catch (dbError) {
              insertAttempts++;
              console.error(`❌ Database Error for ${url}:`, dbError.message);
            }
          }

          console.log(`✅ [${finalDecision}] ${url}${aiReason ? ' - ' + aiReason : ''}`);
          console.log(`   📊 Metrics: ${clickedElements} clicks, ${visitedPages.length} pages, ${pageMetrics.contentLength} chars`);
          
          results.push({
            url,
            finalDecision,
            combinedReasons: aiReason,
            decisions: [{ 
              model: process.env.OPENAI_API_KEY ? 'openai-gpt-4o-enhanced' : 'local-enhanced', 
              decision: finalDecision, 
              reason: aiReason, 
              raw: aiRawResponse 
            }],
            screenshot_base64: screenshotBase64,
            metrics: pageMetrics,
            visitedPages: visitedPages.length,
            clickedElements,
            enhancedTesting: true,
            issues: issues,
            performance: {
              status,
              contentLength: pageMetrics.contentLength,
              loadTime: Date.now()
            }
          });

          success = true;

        } catch (err) {
          console.log(`⚠️ Attempt ${attempts}/${maxAttempts} failed for ${url}: ${err.message}`);
          
          if (attempts === maxAttempts) {
            console.error(`🚨 Failed to test ${url} after ${maxAttempts} attempts`);
            
            try {
              await supabase.from('reviews').insert([{
                url,
                review: `DENIED: Failed to load - ${err.message}`,
                html_snapshot: null,
                ai_raw_response: JSON.stringify({ 
                  error: err.message, 
                  enhancedTesting: true,
                  timestamp: new Date().toISOString()
                }),
                model_used: 'error',
                screenshot_base64: null,
                gif_base64: null,
                created_at: new Date().toISOString()
              }]);
            } catch (dbError) {
              console.error(`❌ Failed to record error for ${url}:`, dbError.message);
            }

            results.push({
              url,
              finalDecision: 'DENIED',
              combinedReasons: `Failed to load: ${err.message}`,
              decisions: [],
              screenshot_base64: null,
              enhancedTesting: true,
              error: err.message
            });
          } else {
            await page.waitForTimeout(2000 * attempts);
          }
        } finally {
          try {
            await page.close();
          } catch (closeError) {
            console.log('⚠️ Page close error:', closeError.message);
          }
        }
      }
    }

    const total = results.length;
    const passed = results.filter(r => r.finalDecision === 'APPROVED').length;
    const failed = total - passed;
    const totalInteractions = results.reduce((sum, r) => sum + (r.clickedElements || 0), 0);
    const totalPagesVisited = results.reduce((sum, r) => sum + (r.visitedPages || 0), 0);
    const avgContentLength = Math.round(
      results.reduce((sum, r) => sum + (r.performance?.contentLength || 0), 0) / total
    );

    const summary = results.map(r => {
      let line = `🔗 ${r.url}\n   ➜ ${r.finalDecision}`;
      if (r.combinedReasons) {
        line += ` - ${r.combinedReasons}`;
      }
      if (r.enhancedTesting && !r.error) {
        line += `\n   📊 ${r.clickedElements || 0} interactions, ${r.visitedPages || 0} pages explored`;
        if (r.performance?.contentLength) {
          line += `, ${r.performance.contentLength} chars`;
        }
      }
      return line;
    }).join('\n\n');

    const finalSummary = `${summary}\n\n✅ FUNCTIONALITY TEST SUMMARY: ${passed}/${total} passed, ${failed} failed
🔧 Total interactions: ${totalInteractions}, Pages explored: ${totalPagesVisited}
📊 Average content length: ${avgContentLength} characters
⚡ Enhanced testing: ${deepTest ? 'Enabled' : 'Disabled'}`;

    console.log(finalSummary);
    
    res.json({
      summary: finalSummary,
      results,
      stats: { 
        total, 
        passed, 
        failed, 
        totalInteractions, 
        totalPagesVisited,
        avgContentLength,
        successRate: Math.round((passed / total) * 100)
      },
      enhancedTesting: true,
      deepTest,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ ENHANCED BATCH REVIEW ERROR:', err);
    res.status(500).json({ 
      error: 'Enhanced batch review failed', 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.log('⚠️ Browser close error:', closeError.message);
      }
    }
  }
});

app.post('/review', rateLimit, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    const response = await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 15000 
    });
    
    await page.waitForTimeout(2000);
    
    const html = await page.content();
    const status = response?.status() || 0;


    const pageMetrics = await page.evaluate(() => ({
      title: document.title || 'Untitled',
      contentLength: document.body.innerText.length,
      hasForm: !!document.querySelector('form'),
      hasButtons: document.querySelectorAll('button, input[type="submit"]').length > 0
    }));

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const screenshotBase64 = screenshot.toString('base64');

    const reviewText = status >= 400 ? 
      `DENIED: HTTP ${status}` : 
      'APPROVED - Basic Load Test';

    try {
      await supabase.from('reviews').insert([{
        url,
        review: reviewText,
        html_snapshot: html.substring(0, 3000),
        ai_raw_response: JSON.stringify({
          basic: true,
          metrics: pageMetrics,
          status,
          timestamp: new Date().toISOString()
        }),
        model_used: 'basic-review',
        screenshot_base64: screenshotBase64,
        gif_base64: null,
        created_at: new Date().toISOString()
      }]);
    } catch (insertError) {
      console.error('❌ Database Insert Error:', insertError.message);
    }

    console.log(`✅ Basic review completed for ${url} - ${reviewText}`);
    
    res.json({ 
      url, 
      screenshot_base64: screenshotBase64, 
      html: html.substring(0, 3000),
      status: reviewText,
      metrics: pageMetrics
    });

  } catch (err) {
    console.error(`❌ Error in single review for ${url}:`, err.message);
    res.status(500).json({ 
      error: err.message,
      url,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.log('⚠️ Browser close error:', closeError.message);
      }
    }
  }
});

app.get('/api/recent-reviews', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const filter = req.query.filter;

    let query = supabase
      .from('reviews')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filter === 'approved') {
      query = query.ilike('review', '%APPROVED%');
    } else if (filter === 'denied') {
      query = query.ilike('review', '%DENIED%');
    } else if (filter === 'enhanced') {
      query = query.ilike('model_used', '%enhanced%');
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('❌ Error fetching reviews:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      reviews: data || [],
      pagination: {
        total: count,
        limit,
        offset,
        hasMore: (offset + limit) < count
      },
      filter: filter || 'all',
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ API Error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch reviews',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '2.0.0',
    features: {
      deepNavigation: true,
      enhancedTesting: true,
      aiReviews: !!process.env.OPENAI_API_KEY,
      rateLimit: true
    },
    timestamp: new Date().toISOString()
  });
});


app.get('/api/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('review, created_at')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) throw error;

    const stats = {
      total: data.length,
      approved: data.filter(r => r.review.includes('APPROVED')).length,
      denied: data.filter(r => r.review.includes('DENIED')).length,
      enhanced: data.filter(r => r.review.includes('Enhanced')).length,
      last30Days: data.length,
      timestamp: new Date().toISOString()
    };

    stats.successRate = stats.total > 0 ? Math.round((stats.approved / stats.total) * 100) : 0;

    res.json(stats);
  } catch (err) {
    console.error('❌ Stats Error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// live logs page
const logStreamClients = [];

app.get('/api/live-logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  logStreamClients.push(client);

  req.on('close', () => {
    const index = logStreamClients.indexOf(client);
    if (index !== -1) logStreamClients.splice(index, 1);
  });
});

function broadcastLog(message) {
  logStreamClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify({ message, timestamp: new Date().toISOString() })}\n\n`);
  });
}

const originalLog = console.log;
console.log = (...args) => {
  originalLog(...args);
  broadcastLog(args.join(' '));
};

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    method: req.method,
    path: req.path,
    availableRoutes: [
      'POST /review',
      'POST /batch-review', 
      'GET /api/recent-reviews',
      'GET /api/stats',
      'GET /health',
      'GET /api/live-logs'
    ]
  });
});

app.use((error, req, res, next) => {
  console.error('❌ Server Error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Striker v2.0.0 running on port ${PORT} - http://localhost:${PORT}/`);
  console.log(`🌐 Health Check: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

export default app;