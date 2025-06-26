import { chromium } from 'playwright';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();
console.log('🔑 Loaded OpenAI Key:', process.env.OPENAI_API_KEY?.slice(0, 5) + '...');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/review', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const path = await import('path');
    const tmp = await import('tmp-promise');

    const tmpDir = await tmp.dir();
    const videoPath = path.join(tmpDir.path, 'recording.webm');
    const gifPath = path.join(tmpDir.path, 'recording.gif');

    
    const screenshotPaths = [];
    for (let i = 0; i < 5; i++) {
      const shotPath = path.join(tmpDir.path, `screenshot-${i}.png`);
      await page.screenshot({ path: shotPath });
      screenshotPaths.push(shotPath);
      await page.waitForTimeout(500);
    }

    const screenshotList = screenshotPaths.map(p => `"${p}"`).join(' ');
    execSync(`ffmpeg -y -framerate 2 -i "${tmpDir.path}/screenshot-%d.png" -vf "scale=480:-1:flags=lanczos" "${gifPath}"`);
    const gifBuffer = fs.readFileSync(gifPath);
    const screenshotBase64 = gifBuffer.toString('base64');

    
    const links = await page.$$eval('a[href]', anchors =>
      anchors
        .map(a => a.getAttribute('href'))
        .filter(href =>
          href &&
          !href.startsWith('http') &&
          !href.startsWith('#') &&
          !href.startsWith('mailto:')
        )
        .slice(0, 3) // 3 pages only
    );

  
    let additionalHtml = '';
    for (const link of links) {
      try {
        const newPage = await browser.newPage();
        await newPage.goto(new URL(link, url).toString(), { waitUntil: 'domcontentloaded', timeout: 10000 });
        const pageHtml = await newPage.content();
        additionalHtml += '\n\n---\n\n' + pageHtml.substring(0, 2000);
        await newPage.close();
      } catch (e) {
        console.warn(`⚠️ Failed to load internal link: ${link}`, e.message);
      }
    }

    const html = await page.content();

    const prompt = `You are a Hack Club staff member reviewing a student project website. Based on the raw HTML provided and a screenshot (not shown), write a 3-sentence review. Then, return a simple JSON object with scores (0–5) for:
- visual_design
- usability
- clarity_of_purpose

Main Page HTML:
${html.substring(0, 3000)}

Additional Page HTML:
${additionalHtml}

(Screenshot not shown here)

Respond like this:
REVIEW:
[your review here]

SCORES:
{ "visual_design": 4, "usability": 3, "clarity_of_purpose": 5 }`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    console.log('🔎 OpenAI raw response:', JSON.stringify(data, null, 2));
    const raw = data.choices?.[0]?.message?.content || 'No review from AI';
    const [_, reviewText = '', scoresJson = '{}'] = raw.match(/REVIEW:\s*([\s\S]+?)\n+SCORES:\s*({[\s\S]+})/) || [];
    const scores = JSON.parse(scoresJson);
    const review = reviewText.trim();

    console.log('🧠 AI Review:', review);

    const { error: insertError } = await supabase.from('reviews').insert([
      {
        url,
        review,
        screenshot_base64: screenshotBase64,
        gif_base64: screenshotBase64,
        score_visual: scores?.visual_design ?? null,
        score_usability: scores?.usability ?? null,
        score_clarity: scores?.clarity_of_purpose ?? null,
        created_at: new Date().toISOString()
      }
    ]);

    if (insertError) {
      console.error('❌ Supabase Insert Error:', insertError.message);
    }
    res.json({ review, gif: `data:image/gif;base64,${screenshotBase64}`, scores, html });
  } catch (err) {
    console.error('❌ REVIEW ERROR:', err);
    res.status(500).json({ error: 'Failed to review project', details: err.message });
  } finally {
    await browser.close();
  }
});



app.get('/history', async (req, res) => {
  const { data, error } = await supabase
    .from('reviews')
    .select('url, review, score_visual, score_usability, score_clarity, gif_base64, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('❌ Failed to fetch history:', error.message);
    return res.status(500).json([]);
  }

  res.json(data);
});

app.use(express.static('public'));
app.listen(3000, () => console.log('Mole V3 is live at http://localhost:3000'));

// WrgjXqiaEIeIVrRp