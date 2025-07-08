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
const TESTING_CONFIG = {
  MAX_PAGES_TO_TEST: 15,
  MAX_DEPTH: 4,
  CLICK_TIMEOUT: 3000,
  PAGE_TIMEOUT: 15000,
  INTERACTION_DELAY: 500,
  SCROLL_DELAY: 200,
  FORM_FILL_DELAY: 300,
  CRITICAL_ERROR_THRESHOLD: 3,
  BROKEN_ELEMENT_THRESHOLD: 2
};
class FailureTracker {
  constructor() {
    this.failures = [];
    this.criticalFailures = [];
    this.warnings = [];
    this.testedElements = 0;
    this.brokenElements = 0;
    this.pagesVisited = [];
  }
  addFailure(type, message, severity = 'medium', page = null) {
    const failure = {
      type,
      message,
      severity,
      page: page || 'main',
      timestamp: new Date().toISOString()
    };
    this.failures.push(failure);
    if (severity === 'critical') {
      this.criticalFailures.push(failure);
    }
    console.log(`${severity === 'critical' ? '🚨' : '⚠️'} ${type}: ${message}${page ? ` (${page})` : ''}`);
  }
  addWarning(message, page = null) {
    this.warnings.push({ message, page, timestamp: new Date().toISOString() });
    console.log(`⚠️ Warning: ${message}${page ? ` (${page})` : ''}`);
  }
  incrementBroken() {
    this.brokenElements++;
  }
  incrementTested() {
    this.testedElements++;
  }
  shouldFail() {
    return this.criticalFailures.length > 0 || 
           this.brokenElements >= TESTING_CONFIG.BROKEN_ELEMENT_THRESHOLD ||
           (this.failures.filter(f => f.severity === 'high').length >= TESTING_CONFIG.CRITICAL_ERROR_THRESHOLD);
  }
  getSummary() {
    return {
      totalFailures: this.failures.length,
      criticalFailures: this.criticalFailures.length,
      warnings: this.warnings.length,
      testedElements: this.testedElements,
      brokenElements: this.brokenElements,
      brokenElementRatio: this.testedElements > 0 ? this.brokenElements / this.testedElements : 0,
      pagesVisited: this.pagesVisited.length,
      shouldFail: this.shouldFail()
    };
  }
}
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
async function safeElementAction(element, action, failureTracker, ...args) {
  try {
    const isInteractable = await element.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible = rect.width > 0 && rect.height > 0 && 
                       style.visibility !== 'hidden' && 
                       style.display !== 'none' &&
                       rect.top < window.innerHeight && 
                       rect.bottom > 0 &&
                       rect.left < window.innerWidth && 
                       rect.right > 0;
      const isClickable = !el.disabled && 
                         !el.hasAttribute('readonly') &&
                         style.pointerEvents !== 'none' &&
                         !el.closest('[disabled]');
      return { isVisible, isClickable, tagName: el.tagName.toLowerCase() };
    });
    failureTracker.incrementTested();
    if (!isInteractable.isVisible) {
      failureTracker.addFailure('HIDDEN_ELEMENT', 
        `${isInteractable.tagName} element exists but is not visible`, 'medium');
      failureTracker.incrementBroken();
      return false;
    }
    if (!isInteractable.isClickable) {
      failureTracker.addFailure('DISABLED_ELEMENT', 
        `${isInteractable.tagName} element is disabled or not clickable`, 'medium');
      failureTracker.incrementBroken();
      return false;
    }
    await element.scrollIntoViewIfNeeded();
    await new Promise(resolve => setTimeout(resolve, TESTING_CONFIG.INTERACTION_DELAY));
    const postScrollVisible = await element.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
             style.visibility !== 'hidden' && style.display !== 'none' &&
             rect.top < window.innerHeight && rect.bottom > 0 &&
             rect.left < window.innerWidth && rect.right > 0;
    });
    if (!postScrollVisible) {
      failureTracker.addFailure('ELEMENT_STILL_HIDDEN_AFTER_SCROLL',
        `Element still not visible after scroll attempt`, 'critical');
      return false;
    }
    await Promise.race([
      element[action](...args),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Action timeout')), TESTING_CONFIG.CLICK_TIMEOUT)
      )
    ]);
    return true;
  } catch (error) {
    failureTracker.addFailure('INTERACTION_FAILED', 
      `Failed to ${action}: ${error.message}`, 'high');
    failureTracker.incrementBroken();
    return false;
  }
}
async function performHumanLikeScrolling(page, failureTracker) {
  console.log('📜 Performing human-like scrolling and discovery...');
  try {
    const pageInfo = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      title: document.title
    }));
    if (pageInfo.scrollHeight <= pageInfo.clientHeight) {
      console.log('📄 Page fits in viewport, no scrolling needed');
      return;
    }
    const sections = 8;
    const sectionHeight = pageInfo.scrollHeight / sections;
    for (let i = 0; i < sections; i++) {
      const targetY = Math.floor(sectionHeight * i);
      await page.evaluate((target) => {
        return new Promise(resolve => {
          const start = window.scrollY;
          const distance = target - start;
          const duration = 800 + Math.random() * 400;
          const startTime = performance.now();
          function easeInOutQuad(t) {
            return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          }
          function animate(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easedProgress = easeInOutQuad(progress);
            const currentY = start + distance * easedProgress;
            window.scrollTo(0, currentY);
            if (progress < 1) {
              requestAnimationFrame(animate);
            } else {
              resolve();
            }
          }
          requestAnimationFrame(animate);
        });
      }, targetY);
      await page.waitForTimeout(TESTING_CONFIG.SCROLL_DELAY + Math.random() * 300);
      await discoverNewInteractiveElements(page, failureTracker);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
  } catch (error) {
    failureTracker.addFailure('SCROLLING_ERROR', 
      `Scrolling failed: ${error.message}`, 'medium');
  }
}
async function discoverNewInteractiveElements(page, failureTracker) {
  try {
    const elements = await page.evaluate(() => {
      const interactiveSelectors = [
        'button:not([disabled])',
        'input[type="submit"]:not([disabled])',
        'input[type="button"]:not([disabled])',
        'a[href]:not([href="#"]):not([href^="javascript:"])',
        '[role="button"]:not([disabled])',
        '.btn:not([disabled]):not(.disabled)',
        '.button:not([disabled]):not(.disabled)',
        'form',
        'input[type="text"]:not([disabled])',
        'input[type="email"]:not([disabled])',
        'textarea:not([disabled])',
        'select:not([disabled])',
        '[onclick]',
        '[data-action]',
        '.clickable'
      ];
      const found = [];
      for (const selector of interactiveSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.top <= window.innerHeight && 
              rect.width > 0 && rect.height > 0) {
            found.push({
              tag: el.tagName.toLowerCase(),
              type: el.type || null,
              text: el.textContent?.trim().substring(0, 50) || '',
              href: el.href || null,
              id: el.id || null,
              className: el.className || null,
              visible: true
            });
          }
        }
      }
      return found;
    });
    console.log(`🔍 Discovered ${elements.length} interactive elements in current viewport`);
    return elements;
  } catch (error) {
    failureTracker.addFailure('ELEMENT_DISCOVERY_FAILED', 
      `Could not discover elements: ${error.message}`, 'low');
    return [];
  }
}
async function testAllForms(page, failureTracker) {
  console.log('📋 Testing all forms comprehensively...');
  const formTestData = {
    text: ['John Doe', 'Test User', 'Sample Input', 'Valid Text'],
    email: ['test@example.com', 'user@hackclub.com', 'valid@email.org'],
    password: ['SecurePass123!', 'TestPassword456#'],
    number: ['42', '100', '2024'],
    tel: ['555-123-4567', '(555) 987-6543'],
    url: ['https://example.com', 'https://hackclub.com'],
    search: ['test search', 'sample query'],
    date: ['2024-01-01', '2023-12-25'],
    time: ['14:30', '09:15'],
    color: ['#ff0000', '#00ff00']
  };
  try {
    const forms = await page.$$('form');
    console.log(`📝 Found ${forms.length} forms to test`);
    for (let formIndex = 0; formIndex < forms.length; formIndex++) {
      const form = forms[formIndex];
      try {
        await form.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const formInfo = await form.evaluate((form, index) => {
          const inputs = form.querySelectorAll('input, textarea, select');
          const submitButton = form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
          return {
            id: form.id || `form-${index}`,
            action: form.action || 'No action',
            method: form.method || 'GET',
            inputCount: inputs.length,
            hasSubmitButton: !!submitButton,
            inputs: Array.from(inputs).map(input => ({
              type: input.type || input.tagName.toLowerCase(),
              name: input.name || null,
              required: input.required || false,
              placeholder: input.placeholder || ''
            }))
          };
        }, formIndex);
        console.log(`📋 Testing form: ${formInfo.id} (${formInfo.inputCount} inputs)`);
        let formInteractionCount = 0;
        let formFailures = 0;
        for (const inputInfo of formInfo.inputs) {
          const inputSelector = inputInfo.name ? 
            `[name="${inputInfo.name}"]` : 
            `input[type="${inputInfo.type}"], ${inputInfo.type}`;
          try {
            const input = await form.$(inputSelector);
            if (!input) continue;
            failureTracker.incrementTested();
            formInteractionCount++;
            const testData = formTestData[inputInfo.type] || formTestData.text;
            const value = testData[formInteractionCount % testData.length];
            const success = await safeElementAction(input, 'fill', failureTracker, value);
            if (!success) {
              formFailures++;
              failureTracker.addFailure('FORM_INPUT_FAILED', 
                `Cannot interact with ${inputInfo.type} input in form ${formInfo.id}`, 'high');
            } else {
              await page.waitForTimeout(TESTING_CONFIG.FORM_FILL_DELAY);
            }
          } catch (inputError) {
            formFailures++;
            failureTracker.addFailure('FORM_INPUT_ERROR', 
              `Error with input ${inputInfo.type}: ${inputError.message}`, 'high');
          }
        }
        if (formInteractionCount > 20 && formFailures / formInteractionCount > 0.8) {
          failureTracker.addFailure('FORM_STUCK', `Form ${formInfo.id} appears stuck (too many retries with invisible elements)`, 'critical');
        }
        if (formInfo.hasSubmitButton) {
          const submitButton = await form.$('input[type="submit"], button[type="submit"], button:not([type])');
          if (submitButton) {
            failureTracker.incrementTested();
            const isClickable = await submitButton.evaluate(btn => {
              const rect = btn.getBoundingClientRect();
              const style = window.getComputedStyle(btn);
              return rect.width > 0 && rect.height > 0 && 
                     !btn.disabled && 
                     style.pointerEvents !== 'none';
            });
            if (!isClickable) {
              failureTracker.addFailure('SUBMIT_BUTTON_DISABLED', 
                `Submit button in form ${formInfo.id} is not clickable`, 'critical');
              formFailures++;
            }
          }
        } else {
          failureTracker.addFailure('NO_SUBMIT_BUTTON', 
            `Form ${formInfo.id} has no submit button`, 'medium');
        }
        if (formFailures > formInteractionCount / 2) {
          failureTracker.addFailure('FORM_MOSTLY_BROKEN', 
            `Form ${formInfo.id} has ${formFailures}/${formInteractionCount} broken elements`, 'critical');
        }
      } catch (formError) {
        failureTracker.addFailure('FORM_TEST_ERROR', 
          `Could not test form ${formIndex}: ${formError.message}`, 'high');
      }
    }
  } catch (error) {
    failureTracker.addFailure('FORM_TESTING_FAILED', 
      `Form testing failed: ${error.message}`, 'medium');
  }
}
async function testAllInteractiveElements(page, failureTracker) {
  console.log('🖱️ Testing all interactive elements...');
  const buttonSelectors = [
    'button:not([disabled])',
    'input[type="submit"]:not([disabled])',
    'input[type="button"]:not([disabled])',
    '[role="button"]:not([disabled])',
    '.btn:not([disabled]):not(.disabled)',
    '.button:not([disabled]):not(.disabled)',
    'a[href]:not([href="#"]):not([href^="javascript:void"])',
    '[onclick]:not([disabled])',
    '[data-action]:not([disabled])'
  ];
  for (const selector of buttonSelectors) {
    try {
      const elements = await page.$$(selector);
      console.log(`🔘 Testing ${elements.length} elements matching: ${selector}`);
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        try {
          const elementInfo = await element.evaluate(el => ({
            tagName: el.tagName.toLowerCase(),
            text: el.textContent?.trim() || '',
            href: el.href || null,
            type: el.type || null,
            id: el.id || null,
            className: el.className || ''
          }));
          console.log(`🔗 Testing: ${elementInfo.tagName} "${elementInfo.text.substring(0, 30)}"`);
          await element.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
          await element.hover();
          await page.waitForTimeout(100);
          const beforeClick = Date.now();
          const clickSuccess = await safeElementAction(element, 'click', failureTracker);
          const afterClick = Date.now();
          if (clickSuccess) {
            await page.waitForTimeout(800);
            const hasModal = await page.$('.modal, .popup, .dialog, [role="dialog"], .overlay, .lightbox');
            const currentUrl = page.url();
            if (hasModal) {
              console.log('🔮 Modal detected after click, attempting to close...');
              const closeSelectors = [
                '.modal .close', '.popup .close', '[aria-label*="close" i]',
                '.modal button[data-dismiss]', '.overlay .close-btn',
                'button[data-bs-dismiss="modal"]', '.modal-close', 'button[aria-label="Close"]'
              ];
              for (const closeSelector of closeSelectors) {
                const closeBtn = await page.$(closeSelector);
                if (closeBtn) {
                  await safeElementAction(closeBtn, 'click', failureTracker);
                  await page.waitForTimeout(300);
                  break;
                }
              }
            }
            console.log(`✅ Element responded in ${afterClick - beforeClick}ms`);
          }
        } catch (elementError) {
          failureTracker.addFailure('ELEMENT_INTERACTION_ERROR', 
            `Error testing element: ${elementError.message}`, 'high');
        }
      }
    } catch (selectorError) {
      failureTracker.addFailure('SELECTOR_ERROR', 
        `Error with selector ${selector}: ${selectorError.message}`, 'medium');
    }
  }
}
async function performComprehensiveNavigation(page, baseUrl, failureTracker, maxDepth = TESTING_CONFIG.MAX_DEPTH, currentDepth = 0, visitedUrls = new Set()) {
  if (currentDepth >= maxDepth || visitedUrls.size >= TESTING_CONFIG.MAX_PAGES_TO_TEST) {
    console.log(`🛑 Stopping navigation: depth ${currentDepth}/${maxDepth}, pages ${visitedUrls.size}/${TESTING_CONFIG.MAX_PAGES_TO_TEST}`);
    return;
  }
  console.log(`🗺️ Deep navigation (depth ${currentDepth + 1}/${maxDepth})...`);
  try {
    const links = await page.evaluate((base, visited) => {
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const navLinks = allLinks.filter(a => {
        const parent = a.closest('nav, .navigation, .navbar, .menu, header, .header');
        return parent !== null;
      });
      const otherLinks = allLinks.filter(a => {
        const parent = a.closest('nav, .navigation, .navbar, .menu, header, .header');
        return parent === null;
      });
      const processLinks = (links) => {
        return links
          .map(a => {
            try {
              const url = new URL(a.href, base);
              return {
                href: url.href,
                text: a.textContent?.trim() || '',
                isInternal: url.hostname === new URL(base).hostname
              };
            } catch {
              return null;
            }
          })
          .filter(link => {
            if (!link || !link.isInternal) return false;
            const href = link.href;
            return !href.includes('#') &&
                   !href.includes('mailto:') &&
                   !href.includes('tel:') &&
                   !href.match(/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx|ppt|pptx|mp4|avi)$/i) &&
                   !visited.includes(href) &&
                   href !== base;
          });
      };
      const prioritizedLinks = [
        ...processLinks(navLinks),
        ...processLinks(otherLinks)
      ];
      const unique = [];
      const seen = new Set();
      for (const link of prioritizedLinks) {
        if (!seen.has(link.href)) {
          seen.add(link.href);
          unique.push(link);
        }
      }
      return unique.slice(0, 10);
    }, baseUrl, Array.from(visitedUrls));
    console.log(`🔗 Found ${links.length} internal links to test`);
    for (const link of links) {
      if (visitedUrls.has(link.href) || visitedUrls.size >= TESTING_CONFIG.MAX_PAGES_TO_TEST) {
        continue;
      }
      visitedUrls.add(link.href);
      failureTracker.pagesVisited.push(link.href);
      try {
        console.log(`🌐 Navigating to: ${link.href}`);
        const response = await page.goto(link.href, { 
          waitUntil: 'domcontentloaded', 
          timeout: TESTING_CONFIG.PAGE_TIMEOUT 
        });
        const status = response?.status() || 0;
        if (status >= 400) {
          failureTracker.addFailure('PAGE_LOAD_FAILED', 
            `Page ${link.href} returned HTTP ${status}`, 'critical', link.href);
          continue;
        }
        await page.waitForTimeout(1000);
        await performHumanLikeScrolling(page, failureTracker);
        await testAllForms(page, failureTracker);
        await testAllInteractiveElements(page, failureTracker);
        await checkForJavaScriptErrors(page, failureTracker, link.href);
        if (currentDepth < maxDepth - 1) {
          await performComprehensiveNavigation(page, link.href, failureTracker, maxDepth, currentDepth + 1, visitedUrls);
        }
      } catch (navError) {
        failureTracker.addFailure('NAVIGATION_ERROR', 
          `Cannot navigate to ${link.href}: ${navError.message}`, 'high', link.href);
      }
    }
  } catch (error) {
    failureTracker.addFailure('COMPREHENSIVE_NAV_ERROR', 
      `Navigation system failed: ${error.message}`, 'medium');
  }
}
async function checkForJavaScriptErrors(page, failureTracker, pageUrl = 'main') {
  try {
    const errors = await page.evaluate(() => {
      return window.jsErrors || [];
    });
    const consoleErrors = await page.evaluate(() => {
      const errors = [];
      const originalError = console.error;
      console.error = function(...args) {
        errors.push(args.join(' '));
        originalError.apply(console, args);
      };
      return errors;
    });
    const totalErrors = errors.length + consoleErrors.length;
    if (totalErrors > TESTING_CONFIG.CRITICAL_ERROR_THRESHOLD) {
      failureTracker.addFailure('EXCESSIVE_JS_ERRORS', 
        `Page has ${totalErrors} JavaScript errors`, 'critical', pageUrl);
    } else if (totalErrors > 0) {
      failureTracker.addWarning(`${totalErrors} JavaScript errors detected`, pageUrl);
    }
  } catch (error) {
    failureTracker.addWarning(`Could not check for JS errors: ${error.message}`, pageUrl);
  }
}
function generateAdvancedAIPrompt(pageMetrics, status, failureTracker, htmlSample) {
  const summary = failureTracker.getSummary();
  return `You are an expert website functionality tester. Analyze this comprehensive test report and determine if the website PASSES or FAILS.
STRICT EVALUATION CRITERIA:
🔴 IMMEDIATE FAIL CONDITIONS:
- ANY HTTP 4xx/5xx errors
- ANY critical failures (forms completely broken, navigation completely broken)
- More than ${TESTING_CONFIG.BROKEN_ELEMENT_THRESHOLD} broken interactive elements
- More than ${TESTING_CONFIG.CRITICAL_ERROR_THRESHOLD} JavaScript errors
- Essential functionality broken (can't navigate, can't submit forms, major buttons don't work)
🟡 FAIL CONDITIONS:
- More than 30% of interactive elements are broken
- Navigation exists but is mostly non-functional
- Forms exist but can't be filled or submitted
- Excessive console errors (5+)
🟢 PASS CONDITIONS:
- Site is basic with no buttons and forms but works as expected
- All major functionality works
- Navigation works properly
- Forms can be filled and submitted
- Interactive elements respond appropriately
- No critical errors
RESPOND WITH EXACTLY:
RESULT: PASS
OR
RESULT: FAIL
REASON: [specific, actionable reason]
ANALYSIS DATA:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 COMPREHENSIVE TEST RESULTS:
• HTTP Status: ${status}
• Pages Tested: ${summary.pagesVisited}
• Elements Tested: ${summary.testedElements}
• Broken Elements: ${summary.brokenElements}
• Broken Element Ratio: ${(summary.brokenElementRatio * 100).toFixed(1)}%
• Total Failures: ${summary.totalFailures}
• Critical Failures: ${summary.criticalFailures}
• Warnings: ${summary.warnings}
🔧 PAGE METRICS:
• Title: "${pageMetrics.title}"
• Content Length: ${pageMetrics.contentLength} characters
• Forms: ${pageMetrics.forms}
• Buttons: ${pageMetrics.buttons}
• Links: ${pageMetrics.links}
• Has Navigation: ${pageMetrics.hasNavigation}
• Interactive Features: ${pageMetrics.hasInteractiveFeatures}
⚠️ DETAILED FAILURES:
${failureTracker.failures.map(f => `[${f.severity.toUpperCase()}] ${f.type}: ${f.message} (${f.page})`).join('\n')}
🚨 CRITICAL FAILURES:
${failureTracker.criticalFailures.map(f => `${f.type}: ${f.message} (${f.page})`).join('\n') || 'None'}
📝 HTML SAMPLE (first 3000 chars):
${htmlSample.substring(0, 3000)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION LOGIC:
${summary.shouldFail ? '🔴 AUTOMATIC FAIL - Critical issues detected' : '🟢 No automatic fail conditions met'}
Focus on functionality over aesthetics. If users can't complete basic tasks, FAIL the site.`;
}
app.post('/batch-review', rateLimit, async (req, res) => {
  const { urls, deepTest = true, maxDepth = TESTING_CONFIG.MAX_DEPTH } = req.body;
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
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-dev-tools'
      ]
    });
    for (const url of urls) {
      console.log(`🚀 Starting comprehensive test for ${url}...`);
      const failureTracker = new FailureTracker();
      let success = false;
      let attempts = 0;
      const maxAttempts = 2;
      while (!success && attempts < maxAttempts) {
        attempts++;
        if (attempts === maxAttempts) {
          failureTracker.addFailure('MAX_ATTEMPTS_REACHED', 'Test got stuck and exceeded max attempts', 'critical');
          break;
        }
        const page = await browser.newPage();
        try {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          });
          const issues = {
            console: [],
            requests: [],
            responses: []
          };
          page.on('pageerror', error => {
            const message = error.message;
            if (!message.includes('require is not defined') && 
                !message.includes('Script error') &&
                !message.includes('Non-Error promise rejection')) {
              issues.console.push(`[PAGEERROR] ${message}`);
              failureTracker.addFailure('JAVASCRIPT_ERROR', message, 'high');
            }
          });
          page.on('console', msg => {
            if (msg.type() === 'error') {
              const text = msg.text();
              if (!text.includes('require is not defined') && 
                  !text.includes('favicon') &&
                  !text.includes('Script error') &&
                  !text.includes('404')) {
                issues.console.push(`[CONSOLE_ERROR] ${text}`);
                failureTracker.addFailure('CONSOLE_ERROR', text, 'medium');
              }
            }
          });
          page.on('requestfailed', request => {
            const requestUrl = request.url();
            const failure = request.failure();
            if (!requestUrl.includes('favicon') && 
                !requestUrl.includes('analytics') &&
                !requestUrl.includes('ads') &&
                !requestUrl.includes('tracking')) {
              issues.requests.push(`${requestUrl} - ${failure?.errorText || 'Unknown'}`);
              failureTracker.addFailure('REQUEST_FAILED', 
                `Failed to load: ${requestUrl}`, 'medium');
            }
          });
          page.on('response', response => {
            if (!response.ok() && response.status() >= 400) {
              const responseUrl = response.url();
              if (!responseUrl.includes('favicon') && 
                  !responseUrl.includes('analytics') &&
                  !responseUrl.includes('ads')) {
                issues.responses.push(`${responseUrl} - HTTP ${response.status()}`);
                if (response.status() >= 500) {
                  failureTracker.addFailure('SERVER_ERROR', 
                    `${responseUrl} returned ${response.status()}`, 'critical');
                } else if (response.status() >= 400) {
                  failureTracker.addFailure('CLIENT_ERROR', 
                    `${responseUrl} returned ${response.status()}`, 'high');
                }
              }
            }
          });
          console.log(`📍 Loading page: ${url}`);
          const response = await page.goto(url, { 
            waitUntil: 'domcontentloaded', 
            timeout: TESTING_CONFIG.PAGE_TIMEOUT 
          });
          const status = response?.status() || 0;
          console.log(`📊 HTTP Status: ${status}`);
          if (status >= 400) {
            failureTracker.addFailure('HTTP_ERROR', 
              `Page returned HTTP ${status}`, 'critical');
          }
          await page.waitForTimeout(2000);
          const pageMetrics = await page.evaluate(() => {
            const elements = {
              images: document.querySelectorAll('img').length,
              headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
              paragraphs: document.querySelectorAll('p').length,
              forms: document.querySelectorAll('form').length,
              buttons: document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]').length,
              links: document.querySelectorAll('a[href]').length,
              inputs: document.querySelectorAll('input, textarea, select').length
            };
            const text = document.body.innerText || '';
            const title = document.title || '';
            return {
              ...elements,
              bodyText: text.substring(0, 500),
              title,
              contentLength: text.length,
              hasLoginForm: !!document.querySelector('form input[type="password"]'),
              hasDynamicElements: !!(
                document.querySelector('.loading, .spinner, [data-loading]') ||
                document.querySelector('[data-testid], [data-cy]') ||
                document.querySelector('.react-root, #root, #app, [ng-app]')
              ),
              hasInteractiveFeatures: !!(
                document.querySelector('canvas') ||
                document.querySelector('video, audio') ||
                document.querySelector('.carousel, .slider, .swiper') ||
                document.querySelector('[role="tabpanel"], [role="tab"]') ||
                document.querySelector('.dropdown, .modal, .popup')
              ),
              hasNavigation: !!document.querySelector('nav, .navigation, .navbar, .menu, header .menu'),
              hasSearchForm: !!document.querySelector('form input[type="search"], form input[placeholder*="search" i]'),
              hasContactForm: !!document.querySelector('form input[type="email"], form textarea')
            };
          });
          console.log(`📋 Page metrics: ${pageMetrics.forms} forms, ${pageMetrics.buttons} buttons, ${pageMetrics.links} links`);
          console.log('🧪 Starting comprehensive testing sequence...');
          await performHumanLikeScrolling(page, failureTracker);
          if (pageMetrics.forms > 0) {
            await testAllForms(page, failureTracker);
          }
          if (pageMetrics.buttons > 0 || pageMetrics.links > 0) {
            await testAllInteractiveElements(page, failureTracker);
          }
          if (deepTest && pageMetrics.hasNavigation) {
            console.log('🗺️ Starting deep navigation testing...');
            await performComprehensiveNavigation(page, url, failureTracker, Math.min(maxDepth, 4));
          }
          await checkForJavaScriptErrors(page, failureTracker);
          console.log('📱 Testing responsive behavior...');
          await page.setViewportSize({ width: 375, height: 667 });
          await page.waitForTimeout(1000);
          const mobileMetrics = await page.evaluate(() => {
            const hasHorizontalScroll = document.body.scrollWidth > window.innerWidth;
            const hasOverflowingElements = Array.from(document.querySelectorAll('*')).some(el => {
              const rect = el.getBoundingClientRect();
              return rect.right > window.innerWidth;
            });
            return { hasHorizontalScroll, hasOverflowingElements };
          });
          if (mobileMetrics.hasHorizontalScroll || mobileMetrics.hasOverflowingElements) {
            failureTracker.addWarning('Potential mobile responsiveness issues detected');
          }
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.waitForTimeout(500);
          const htmlSnapshot = await page.content();
          const testSummary = failureTracker.getSummary();
          console.log(`📊 Test Summary: ${testSummary.totalFailures} failures, ${testSummary.criticalFailures} critical, ${testSummary.brokenElements}/${testSummary.testedElements} broken elements`);
          let finalDecision = 'PASS';
          let aiReason = null;
          let aiRawResponse = '';
          if (process.env.OPENAI_API_KEY) {
            try {
              const prompt = generateAdvancedAIPrompt(pageMetrics, status, failureTracker, htmlSnapshot);
              const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                  model: 'gpt-4o',
                  messages: [{ role: 'user', content: prompt }],
                  max_tokens: 200,
                  temperature: 0.1
                }),
              });
              if (openaiResponse.ok) {
                const data = await openaiResponse.json();
                aiRawResponse = data.choices?.[0]?.message?.content?.trim() || '';
                if (/RESULT:\s*PASS/i.test(aiRawResponse)) {
                  finalDecision = 'PASS';
                } else if (/RESULT:\s*FAIL/i.test(aiRawResponse)) {
                  finalDecision = 'FAIL';
                  const match = aiRawResponse.match(/REASON:\s*(.+)/i);
                  aiReason = match ? match[1].trim() : 'Critical functionality issues detected';
                }
              } else {
                console.error('❌ OpenAI API Error:', openaiResponse.status);
                failureTracker.addWarning('AI evaluation unavailable, using local evaluation');
              }
            } catch (aiError) {
              console.error('❌ AI Review Error:', aiError.message);
              failureTracker.addWarning('AI evaluation failed, using local evaluation');
            }
          }
          if (testSummary.shouldFail) {
            finalDecision = 'FAIL';
            if (!aiReason) {
              const reasons = [];
              if (testSummary.criticalFailures > 0) {
                reasons.push(`${testSummary.criticalFailures} critical failures`);
              }
              if (testSummary.brokenElementRatio > 0.3) {
                reasons.push(`${(testSummary.brokenElementRatio * 100).toFixed(1)}% broken elements`);
              }
              if (status >= 400) {
                reasons.push(`HTTP ${status} error`);
              }
              aiReason = reasons.join(', ') || 'Multiple functionality issues';
            }
          }
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(300);
          const screenshot = await page.screenshot({ 
            type: 'png', 
            fullPage: false,
            clip: { x: 0, y: 0, width: 1440, height: 900 }
          });
          const screenshotBase64 = screenshot.toString('base64');
          const reviewText = finalDecision === 'PASS' ? 
            `APPROVED - Advanced Functionality Testing (${testSummary.testedElements} elements tested, ${testSummary.pagesVisited} pages)` : 
            `DENIED: ${aiReason}`;
          const dbRecord = {
            url,
            review: reviewText,
            html_snapshot: htmlSnapshot.substring(0, 5000),
            ai_raw_response: JSON.stringify({ 
              decision: finalDecision, 
              reason: aiReason, 
              raw: aiRawResponse,
              metrics: pageMetrics,
              testSummary,
              failures: failureTracker.failures,
              criticalFailures: failureTracker.criticalFailures,
              warnings: failureTracker.warnings,
              advancedTesting: true,
              deepTest,
              timestamp: new Date().toISOString(),
              version: '2.0-advanced'
            }),
            model_used: process.env.OPENAI_API_KEY ? 'openai-gpt-4o-advanced' : 'local-advanced',
            screenshot_base64: screenshotBase64,
            gif_base64: null,
            created_at: new Date().toISOString()
          };
          try {
            const { error: insertError } = await supabase.from('reviews').insert([dbRecord]);
            if (insertError) {
              console.error(`❌ Database Error for ${url}:`, insertError.message);
            }
          } catch (dbError) {
            console.error(`❌ Database Connection Error for ${url}:`, dbError.message);
          }
          const resultIcon = finalDecision === 'PASS' ? '✅' : '❌';
          console.log(`${resultIcon} [${finalDecision}] ${url}${aiReason ? ' - ' + aiReason : ''}`);
          console.log(`   📊 Advanced Metrics: ${testSummary.testedElements} elements tested, ${testSummary.brokenElements} broken, ${testSummary.pagesVisited} pages visited`);
          console.log(`   🔍 Failure breakdown: ${testSummary.criticalFailures} critical, ${testSummary.totalFailures - testSummary.criticalFailures} other`);
          results.push({
            url,
            finalDecision,
            combinedReasons: aiReason,
            decisions: [{ 
              model: process.env.OPENAI_API_KEY ? 'openai-gpt-4o-advanced' : 'local-advanced', 
              decision: finalDecision, 
              reason: aiReason, 
              raw: aiRawResponse 
            }],
            screenshot_base64: screenshotBase64,
            metrics: pageMetrics,
            testSummary,
            failures: failureTracker.failures.slice(0, 10),
            criticalFailures: failureTracker.criticalFailures,
            warnings: failureTracker.warnings.slice(0, 5),
            advancedTesting: true,
            issues: {
              console: issues.console.length,
              requests: issues.requests.length,
              responses: issues.responses.length
            },
            performance: {
              status,
              contentLength: pageMetrics.contentLength,
              loadTime: Date.now(),
              elementsTestedRatio: testSummary.testedElements > 0 ? 
                (testSummary.testedElements - testSummary.brokenElements) / testSummary.testedElements : 0
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
                review: `DENIED: Test execution failed - ${err.message}`,
                html_snapshot: null,
                ai_raw_response: JSON.stringify({ 
                  error: err.message, 
                  advancedTesting: true,
                  testFailed: true,
                  timestamp: new Date().toISOString()
                }),
                model_used: 'error-advanced',
                screenshot_base64: null,
                gif_base64: null,
                created_at: new Date().toISOString()
              }]);
            } catch (dbError) {
              console.error(`❌ Failed to record error for ${url}:`, dbError.message);
            }
            results.push({
              url,
              finalDecision: 'FAIL',
              combinedReasons: `Test execution failed: ${err.message}`,
              decisions: [],
              screenshot_base64: null,
              advancedTesting: true,
              testFailed: true,
              error: err.message
            });
          } else {
            await new Promise(resolve => setTimeout(resolve, 3000 * attempts));
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
    const passed = results.filter(r => r.finalDecision === 'PASS').length;
    const failed = total - passed;
    const totalElementsTested = results.reduce((sum, r) => sum + (r.testSummary?.testedElements || 0), 0);
    const totalBrokenElements = results.reduce((sum, r) => sum + (r.testSummary?.brokenElements || 0), 0);
    const totalPagesVisited = results.reduce((sum, r) => sum + (r.testSummary?.pagesVisited || 0), 0);
    const totalCriticalFailures = results.reduce((sum, r) => sum + (r.testSummary?.criticalFailures || 0), 0);
    const avgContentLength = Math.round(
      results.reduce((sum, r) => sum + (r.performance?.contentLength || 0), 0) / total
    );
    const summary = results.map(r => {
      let line = `🔗 ${r.url}\n   ➜ ${r.finalDecision}`;
      if (r.combinedReasons) {
        line += ` - ${r.combinedReasons}`;
      }
      if (r.advancedTesting && !r.error) {
        const ts = r.testSummary || {};
        line += `\n   📊 ${ts.testedElements || 0} elements tested, ${ts.brokenElements || 0} broken, ${ts.pagesVisited || 0} pages explored`;
        if (ts.criticalFailures > 0) {
          line += `, ${ts.criticalFailures} critical failures`;
        }
      }
      return line;
    }).join('\n\n');
    const finalSummary = `${summary}\n\n🧪 ADVANCED TESTING SUMMARY: ${passed}/${total} passed (${Math.round((passed/total)*100)}% success rate)
🔧 Elements tested: ${totalElementsTested}, Broken: ${totalBrokenElements} (${totalElementsTested > 0 ? Math.round((totalBrokenElements/totalElementsTested)*100) : 0}% failure rate)
🗺️ Total pages explored: ${totalPagesVisited}
🚨 Critical failures: ${totalCriticalFailures}
📊 Average content length: ${avgContentLength} characters
⚡ Advanced testing: ${deepTest ? 'Deep navigation enabled' : 'Basic testing'} | Max depth: ${maxDepth}`;
    console.log('\n' + '='.repeat(80));
    console.log(finalSummary);
    console.log('='.repeat(80));
    res.json({
      summary: finalSummary,
      results,
      stats: { 
        total, 
        passed, 
        failed, 
        successRate: Math.round((passed / total) * 100),
        totalElementsTested,
        totalBrokenElements,
        elementFailureRate: totalElementsTested > 0 ? Math.round((totalBrokenElements / totalElementsTested) * 100) : 0,
        totalPagesVisited,
        totalCriticalFailures,
        avgContentLength
      },
      advancedTesting: true,
      deepTest,
      version: '2.0-advanced',
      testingConfig: TESTING_CONFIG,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ ADVANCED BATCH REVIEW ERROR:', err);
    res.status(500).json({ 
      error: 'Advanced batch review failed', 
      details: err.message,
      timestamp: new Date().toISOString(),
      version: '2.0-advanced'
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
  return app.handle({
    ...req,
    body: { urls: [url], deepTest: false }
  }, res);
});
app.post('/human-review', rateLimit, async (req, res) => {
  const { reviewId, newDecision, humanNotes } = req.body;
  if (!reviewId || !newDecision || !humanNotes) {
    return res.status(400).json({ error: 'Missing required fields: reviewId, newDecision, humanNotes' });
  }
  if (!['PASS', 'FAIL'].includes(newDecision)) {
    return res.status(400).json({ error: 'newDecision must be either PASS or FAIL' });
  }
  try {
    const { data: existingReview, error: fetchError } = await supabase
      .from('reviews')
      .select('*')
      .eq('id', reviewId)
      .single();
    if (fetchError || !existingReview) {
      return res.status(404).json({ error: 'Review not found' });
    }
    let aiData = {};
    try {
      aiData = JSON.parse(existingReview.ai_raw_response || '{}');
    } catch (e) {
      aiData = {};
    }
    aiData.humanReview = {
      originalDecision: aiData.decision || 'UNKNOWN',
      humanDecision: newDecision,
      humanNotes,
      reviewedAt: new Date().toISOString(),
      reviewedBy: 'human-reviewer'
    };
    const newReviewText = newDecision === 'PASS' ? 
      `APPROVED - Human Override: ${humanNotes}` : 
      `DENIED - Human Override: ${humanNotes}`;
    const { error: updateError } = await supabase
      .from('reviews')
      .update({
        review: newReviewText,
        ai_raw_response: JSON.stringify(aiData),
        model_used: `${existingReview.model_used}-human-reviewed`
      })
      .eq('id', reviewId);
    if (updateError) {
      console.error('❌ Database update error:', updateError.message);
      return res.status(500).json({ error: 'Failed to update review' });
    }
    console.log(`👤 Human review completed: ${existingReview.url} - ${newDecision}`);
    res.json({
      success: true,
      message: 'Human review recorded successfully',
      reviewId,
      newDecision,
      humanNotes,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Human review error:', error);
    res.status(500).json({
      error: 'Failed to process human review',
      details: error.message,
      timestamp: new Date().toISOString()
    });
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
    } else if (filter === 'advanced') {
      query = query.ilike('model_used', '%advanced%');
    } else if (filter === 'critical') {
      query = query.ilike('ai_raw_response', '%critical%');
    } else if (filter === 'human-reviewed') {
      query = query.ilike('model_used', '%human-reviewed%');
    }
    const { data, error, count } = await query;
    if (error) {
      console.error('❌ Error fetching reviews:', error.message);
      return res.status(500).json({ error: error.message });
    }
    const enhancedData = (data || []).map(review => {
      try {
        const aiData = JSON.parse(review.ai_raw_response || '{}');
        return {
          ...review,
          testSummary: aiData.testSummary,
          criticalFailures: aiData.criticalFailures?.length || 0,
          elementsTestedTotal: aiData.testSummary?.testedElements || 0,
          advancedTesting: aiData.advancedTesting || false,
          humanReview: aiData.humanReview || null
        };
      } catch {
        return review;
      }
    });
    res.json({
      reviews: enhancedData,
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
    version: '2.0.0-advanced',
    features: {
      deepNavigation: true,
      advancedTesting: true,
      comprehensiveFormTesting: true,
      humanLikeInteraction: true,
      responsiveDesignTesting: true,
      criticalFailureDetection: true,
      humanReview: true,
      aiReviews: !!process.env.OPENAI_API_KEY,
      rateLimit: true
    },
    testingConfig: TESTING_CONFIG,
    timestamp: new Date().toISOString()
  });
});
app.get('/api/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('review, ai_raw_response, created_at')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    if (error) throw error;
    const stats = {
      total: data.length,
      approved: data.filter(r => r.review.includes('APPROVED')).length,
      denied: data.filter(r => r.review.includes('DENIED')).length,
      advanced: data.filter(r => r.review.includes('Advanced')).length,
      humanReviewed: data.filter(r => r.review.includes('Human Override')).length,
      last30Days: data.length
    };
    let totalElementsTested = 0;
    let totalBrokenElements = 0;
    let totalCriticalFailures = 0;
    data.forEach(review => {
      try {
        const aiData = JSON.parse(review.ai_raw_response || '{}');
        if (aiData.testSummary) {
          totalElementsTested += aiData.testSummary.testedElements || 0;
          totalBrokenElements += aiData.testSummary.brokenElements || 0;
          totalCriticalFailures += aiData.testSummary.criticalFailures || 0;
        }
      } catch (e) {
      }
    });
    stats.successRate = stats.total > 0 ? Math.round((stats.approved / stats.total) * 100) : 0;
    stats.elementFailureRate = totalElementsTested > 0 ? 
      Math.round((totalBrokenElements / totalElementsTested) * 100) : 0;
    stats.totalElementsTested = totalElementsTested;
    stats.totalBrokenElements = totalBrokenElements;
    stats.totalCriticalFailures = totalCriticalFailures;
    stats.timestamp = new Date().toISOString();
    res.json(stats);
  } catch (err) {
    console.error('❌ Stats Error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});
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
    try {
      client.res.write(`data: ${JSON.stringify({ message, timestamp: new Date().toISOString() })}\n\n`);
    } catch (e) {
    }
  });
}
const originalLog = console.log;
console.log = (...args) => {
  originalLog(...args);
  broadcastLog(args.join(' '));
};
const originalError = console.error;
console.error = (...args) => {
  originalError(...args);
  broadcastLog(`ERROR: ${args.join(' ')}`);
};
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/config', (req, res) => {
  res.json({
    version: '2.0.0-advanced',
    testingConfig: TESTING_CONFIG,
    features: {
      deepNavigation: true,
      advancedTesting: true,
      comprehensiveFormTesting: true,
      humanLikeInteraction: true,
      responsiveDesignTesting: true,
      criticalFailureDetection: true,
      humanReview: true,
      aiReviews: !!process.env.OPENAI_API_KEY
    }
  });
});
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    method: req.method,
    path: req.path,
    availableRoutes: [
      'POST /batch-review',
      'POST /review', 
      'POST /human-review',
      'GET /api/recent-reviews',
      'GET /api/stats',
      'GET /health',
      'GET /config',
      'GET /api/live-logs'
    ],
    version: '2.0.0-advanced'
  });
});
app.use((error, req, res, next) => {
  console.error('❌ Server Error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    timestamp: new Date().toISOString(),
    version: '2.0.0-advanced'
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Advanced AI Site Checker v2.0.0 running on port ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}/`);
  console.log(`🩺 Health Check: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
  console.log(`⚙️ Config: http://localhost:${PORT}/config`);
  console.log(`🧪 Testing Config: Max ${TESTING_CONFIG.MAX_PAGES_TO_TEST} pages, depth ${TESTING_CONFIG.MAX_DEPTH}`);
  console.log(`🤖 AI Reviews: ${process.env.OPENAI_API_KEY ? 'Enabled' : 'Disabled'}`);
  console.log(`👤 Human Review: Enabled`);
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