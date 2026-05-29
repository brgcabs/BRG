/**
 * ════════════════════════════════════════════════════════════════
 *  BRG CABS — Cloudflare Worker
 *  File: cloudflare-worker.js
 *  Deploy: https://dash.cloudflare.com → Workers → Create Worker
 * ════════════════════════════════════════════════════════════════
 *
 *  ENVIRONMENT VARIABLES (set in Cloudflare Dashboard → Worker → Settings → Variables)
 *  ─────────────────────────────────────────────────────────────
 *  GOOGLE_MAPS_KEY       → Your Google Maps API Key
 *  GOOGLE_SCRIPT_URL     → Deployed Google Apps Script Web App URL
 *  RAZORPAY_KEY_ID       → Razorpay Key ID (rzp_live_XXXX)
 *  RAZORPAY_KEY_SECRET   → Razorpay Key Secret (mark as Secret)
 *  ALLOWED_ORIGIN        → https://www.brgcabs.in  (your domain)
 * ═══════════════════════════════════════════════════════════════
 *
 *  API ENDPOINTS:
 *  ─────────────────────────────────────────────────────────────
 *  POST /api/otp/send          → Send OTP via Google Apps Script
 *  GET  /api/distance          → Google Distance Matrix
 *  GET  /api/places            → Google Places Autocomplete
 *  POST /api/payment/order     → Create Razorpay Order
 *  POST /api/payment/verify    → Verify Razorpay Payment Signature
 *  POST /api/booking/notify    → Send admin WhatsApp notification
 * ════════════════════════════════════════════════════════════════
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS HEADERS ──
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    try {
      const path = url.pathname;

      // ──────────────────────────────────────────────────────────
      // 1. SEND OTP
      // POST /api/otp/send
      // Body: { phone: "9876543210", otp: "4521", name: "Rajesh" }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/otp/send' && request.method === 'POST') {
        const { phone, otp, name } = await request.json();

        if (!phone || !otp) {
          return json({ success: false, error: 'phone and otp are required' }, 400);
        }

        // Call your deployed Google Apps Script URL
        const scriptResponse = await fetch(env.GOOGLE_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, otp, name }),
        });

        if (!scriptResponse.ok) {
          return json({ success: false, error: 'OTP service unavailable' }, 502);
        }

        const result = await scriptResponse.json();
        return json({ success: true, message: 'OTP sent', ...result });
      }

      // ──────────────────────────────────────────────────────────
      // 2. DISTANCE MATRIX
      // GET /api/distance?origin=Delhi&destination=Jaipur
      // ──────────────────────────────────────────────────────────
      if (path === '/api/distance' && request.method === 'GET') {
        const origin_place = url.searchParams.get('origin');
        const destination  = url.searchParams.get('destination');
        const mode         = url.searchParams.get('mode') || 'driving';

        if (!origin_place || !destination) {
          return json({ success: false, error: 'origin and destination required' }, 400);
        }

        const mapsUrl =
          `https://maps.googleapis.com/maps/api/distancematrix/json` +
          `?origins=${encodeURIComponent(origin_place)}` +
          `&destinations=${encodeURIComponent(destination)}` +
          `&mode=${mode}` +
          `&units=metric` +
          `&key=${env.GOOGLE_MAPS_KEY}`;

        const mapsRes  = await fetch(mapsUrl);
        const mapsData = await mapsRes.json();

        if (mapsData.status !== 'OK') {
          return json({ success: false, error: mapsData.status }, 502);
        }

        const element = mapsData.rows[0]?.elements[0];
        if (!element || element.status !== 'OK') {
          return json({ success: false, error: 'Route not found' }, 404);
        }

        return json({
          success:      true,
          distanceText: element.distance.text,
          distanceKm:   Math.ceil(element.distance.value / 1000),
          durationText: element.duration.text,
          durationMins: Math.ceil(element.duration.value / 60),
        });
      }

      // ──────────────────────────────────────────────────────────
      // 3. PLACES AUTOCOMPLETE
      // GET /api/places?input=Delhi air
      // ──────────────────────────────────────────────────────────
      if (path === '/api/places' && request.method === 'GET') {
        const input        = url.searchParams.get('input');
        const sessiontoken = url.searchParams.get('sessiontoken') || '';

        if (!input || input.length < 2) {
          return json({ success: false, error: 'input too short' }, 400);
        }

        const placesUrl =
          `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
          `?input=${encodeURIComponent(input)}` +
          `&components=country:in` +
          `&sessiontoken=${sessiontoken}` +
          `&key=${env.GOOGLE_MAPS_KEY}`;

        const placesRes  = await fetch(placesUrl);
        const placesData = await placesRes.json();

        return json({
          success:     placesData.status === 'OK',
          predictions: (placesData.predictions || []).slice(0, 8).map(p => ({
            place_id:    p.place_id,
            description: p.description,
            main_text:   p.structured_formatting?.main_text,
            secondary:   p.structured_formatting?.secondary_text,
          })),
        });
      }

      // ──────────────────────────────────────────────────────────
      // 4. CREATE RAZORPAY ORDER
      // POST /api/payment/order
      // Body: { amount: 500, bookingId: "BRG123456", notes: {} }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/payment/order' && request.method === 'POST') {
        const { amount, bookingId, notes } = await request.json();

        if (!amount || amount < 100) {
          return json({ success: false, error: 'Invalid amount' }, 400);
        }

        const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

        const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
          method:  'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount:   amount * 100, // paise
            currency: 'INR',
            receipt:  bookingId || `BRG${Date.now()}`,
            notes:    notes || {},
          }),
        });

        const rzpData = await rzpRes.json();

        if (rzpData.error) {
          return json({ success: false, error: rzpData.error.description }, 502);
        }

        return json({
          success:  true,
          orderId:  rzpData.id,
          amount:   rzpData.amount,
          currency: rzpData.currency,
          key_id:   env.RAZORPAY_KEY_ID, // safe to expose key_id
        });
      }

      // ──────────────────────────────────────────────────────────
      // 5. VERIFY RAZORPAY PAYMENT
      // POST /api/payment/verify
      // Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/payment/verify' && request.method === 'POST') {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await request.json();

        // Verify HMAC SHA256 signature
        const body    = `${razorpay_order_id}|${razorpay_payment_id}`;
        const encoder = new TextEncoder();
        const keyData = encoder.encode(env.RAZORPAY_KEY_SECRET);
        const msgData = encoder.encode(body);

        const cryptoKey = await crypto.subtle.importKey(
          'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
        const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (expectedSignature === razorpay_signature) {
          return json({ success: true, verified: true, payment_id: razorpay_payment_id });
        } else {
          return json({ success: false, verified: false, error: 'Signature mismatch' }, 400);
        }
      }

      // ──────────────────────────────────────────────────────────
      // 6. BOOKING NOTIFICATION (store to KV + notify via script)
      // POST /api/booking/notify
      // Body: { booking: { id, name, phone, ... } }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/booking/notify' && request.method === 'POST') {
        const { booking } = await request.json();

        if (!booking || !booking.id) {
          return json({ success: false, error: 'Invalid booking data' }, 400);
        }

        // Optional: Store in KV (if KV namespace bound as BOOKINGS)
        if (env.BOOKINGS) {
          await env.BOOKINGS.put(booking.id, JSON.stringify({
            ...booking,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days
        }

        // Notify admin via Google Script (sends WhatsApp/Email)
        const notifyRes = await fetch(env.GOOGLE_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'booking_notify', booking }),
        });

        return json({ success: true, stored: !!env.BOOKINGS });
      }

      // 404
      return json({ success: false, error: 'Endpoint not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ success: false, error: 'Internal server error' }, 500);
    }
  },
};

/**
 * ════════════════════════════════════════════════════════════════
 *  DEPLOYMENT STEPS
 * ════════════════════════════════════════════════════════════════
 *
 *  1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this file content
 *  3. Click "Save and Deploy"
 *  4. Go to Settings → Variables and Secrets, add:
 *
 *     Variable Name          │ Type    │ Value
 *     ──────────────────────────────────────────
 *     GOOGLE_MAPS_KEY        │ Secret  │ AIza...
 *     GOOGLE_SCRIPT_URL      │ Secret  │ https://script.google.com/macros/s/.../exec
 *     RAZORPAY_KEY_ID        │ Text    │ rzp_live_...
 *     RAZORPAY_KEY_SECRET    │ Secret  │ your_secret
 *     ALLOWED_ORIGIN         │ Text    │ https://www.brgcabs.in
 *
 *  5. Optionally add a KV namespace named "BOOKINGS" for booking storage
 *
 *  6. Add custom route in Cloudflare DNS:
 *     Route: www.brgcabs.in/api/*  → Your Worker
 *
 *  7. In brgcabs.html, set:
 *     window.WORKER_URL = 'https://your-worker.workers.dev';
 *
 * ════════════════════════════════════════════════════════════════
 */
