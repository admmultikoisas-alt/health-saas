require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');
const Stripe = require('stripe');
const specialists = require('./specialists');

const app = express();
const PORT = process.env.PORT || 3456;

const stripe = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('YOUR')
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────
app.get('/chat/:specialist/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/chat/:specialist', (req, res) =>
  res.redirect(`/chat/${req.params.specialist}/`));
app.get('/success', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ── Specialist info ─────────────────────────────────────
app.get('/api/specialist/:slug', (req, res) => {
  const sp = specialists[req.params.slug];
  if (!sp) return res.status(404).json({ error: 'Specialist not found' });
  const { systemPrompt, apiKeyEnv, ...safe } = sp;
  res.json(safe);
});

// ── Chat with Pollinations AI (no API key needed) ───────
app.post('/api/chat', async (req, res) => {
  const { slug, messages } = req.body;
  const sp = specialists[slug];
  if (!sp) return res.status(404).json({ error: 'Specialist not found' });
  if (!messages?.length) return res.status(400).json({ error: 'No messages' });

  // Build message list — must start with user role
  const msgList = [...messages];
  while (msgList.length > 1 && msgList[0].role === 'assistant') msgList.shift();

  const body = JSON.stringify({
    model: 'openai',
    messages: [
      { role: 'system', content: sp.systemPrompt },
      ...msgList.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      }))
    ],
    max_tokens: 300,
    temperature: 0.7,
    stream: true,
    referrer: 'individual-consult'
  });

  const options = {
    hostname: 'text.pollinations.ai',
    path: '/openai',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Referer': `http://localhost:${PORT}`
    }
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const proxyReq = https.request(options, (proxyRes) => {
    let buffer = '';

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          if (trimmed === 'data: [DONE]') {
            res.write('data: [DONE]\n\n');
          }
          continue;
        }
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const text = parsed.choices?.[0]?.delta?.content || '';
            if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
          } catch {}
        }
      }
    });

    proxyRes.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    proxyRes.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: err.message });
      else res.end();
    });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  });

  proxyReq.write(body);
  proxyReq.end();
});

// ── Verify Stripe Payment ────────────────────────────────
app.get('/api/verify-payment', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid' || session.status === 'complete') {
      return res.json({ premium: true, email: session.customer_details?.email });
    }
    res.json({ premium: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Stripe Checkout ─────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Individual Consult — Premium',
            description: 'Unlimited consultations with all health specialists, 24/7.',
            images: ['https://i.postimg.cc/CKD0rSsN/logo.png'],
          },
          unit_amount: 990,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅  Individual Consult → http://localhost:${PORT}`);
  console.log(`    AI       → Pollinations AI (público, sem chave)`);
  console.log(`    Stripe   → ${stripe ? '✅' : '⚠️  não configurado'}\n`);
});
