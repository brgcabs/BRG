/**
 * ════════════════════════════════════════════════════════════════
 *  BRG CABS — Cloudflare Worker  (Merged — v3.0)
 *  URL: https://brgcabs.brgtoursindia.workers.dev
 * ════════════════════════════════════════════════════════════════
 *
 *  ENVIRONMENT VARIABLES:
 *  ─────────────────────────────────────────────────────────────
 *  GOOGLE_MAPS_KEY        → Google Maps API Key
 *  GOOGLE_SCRIPT_URL      → Google Apps Script URL
 *  RAZORPAY_KEY_ID        → Razorpay Key ID
 *  RAZORPAY_KEY_SECRET    → Razorpay Key Secret
 *  ADMIN_PHONE            → Admin WhatsApp number (91XXXXXXXXXX)
 *  WA_ACCESS_TOKEN        → WhatsApp Business API Bearer Token
 *  WA_PHONE_NUMBER_ID     → WhatsApp Business Phone Number ID (1205015552687577)
 *  WA_OTP_TEMPLATE_NAME   → brgcabs_otp
 *  WA_TEMPLATE_LANG       → en
 *
 *  KV NAMESPACE:
 *  BOOKINGS               → KV for booking storage + OTP storage
 *
 *  ENDPOINTS:
 *  POST /api/otp/send     → Generate OTP server-side, store in KV, send via WhatsApp
 *  POST /api/otp/verify   → Verify OTP against KV store (server-side)
 *  GET  /api/distance     → Google Distance Matrix
 *  GET  /api/places       → Google Places Autocomplete
 *  POST /api/payment/order   → Create Razorpay order
 *  POST /api/payment/verify  → Verify Razorpay signature
 *  POST /api/booking/notify  → Store booking + notify admin
 * ════════════════════════════════════════════════════════════════
 */

// ── Phone normalizer — returns E.164 without '+' prefix (91XXXXXXXXXX) ──────
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = p.substring(1);
  if (!p.startsWith('91') && p.length === 10) p = '91' + p;
  if (!/^91\d{10}$/.test(p)) return null;
  return p;
}

// ── OTP generator using Web Crypto (server-side only) ──────────────────────
async function generateOTP() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(1000 + (arr[0] % 9000));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS HEADERS ──────────────────────────────────────────────────────
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    };

    // ── SECURITY HEADERS (added to every response) ────────────────────────
    const secHeaders = {
      'X-Frame-Options':        'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy':        'strict-origin-when-cross-origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders, ...secHeaders } });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, ...secHeaders, 'Content-Type': 'application/json' },
      });

    // ── WhatsApp API helper ───────────────────────────────────────────────
    const sendWhatsApp = async (toPhone, templateName, langCode, components) => {
      const phoneId = env.WA_PHONE_NUMBER_ID;
      const token   = env.WA_ACCESS_TOKEN;
      if (!phoneId || !token) throw new Error('WhatsApp not configured');

      // Format as +91XXXXXXXXXX for WhatsApp API
      const normalized = normalizePhone(toPhone);
      if (!normalized) throw new Error('Invalid phone number');
      const waPhone = '+' + normalized;

      const res = await fetch(
        `https://graph.facebook.com/v21.0/${phoneId}/messages`,
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to:   waPhone,
            type: 'template',
            template: {
              name:       templateName,
              language:   { code: langCode || 'en' },
              components: components || [],
            },
          }),
        }
      );
      return res.json();
    };

    try {
      const path = url.pathname;

      // ── ROOT ─────────────────────────────────────────────────────────────
      if (path === '/') {
        return json({ success: true, message: 'BRG Cabs API is running.' });
      }

      // ══════════════════════════════════════════════════════════════════════
      // 1. SEND OTP  —  POST /api/otp/send
      //    Body: { phone, name }
      //    - Generates OTP server-side (never from client)
      //    - Stores in KV with 5-min TTL
      //    - Rate-limited: 1 request per phone per 60s
      //    - Sends via WhatsApp brgcabs_otp template
      //    - Auto-retries with body-only if button component fails (error 132000)
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/otp/send' && request.method === 'POST') {
        const body  = await request.json();
        const phone = normalizePhone(body.phone);

        if (!phone) {
          return json({ success: false, error: 'Invalid phone number' }, 400);
        }

        // Rate limit: 1 OTP per phone per 60 seconds
        if (env.BOOKINGS) {
          const rlKey = `ratelimit:otp:${phone}`;
          const rl    = await env.BOOKINGS.get(rlKey).catch(() => null);
          if (rl) {
            return json({ success: false, error: 'Please wait 60 seconds before requesting a new OTP' }, 429);
          }
          await env.BOOKINGS.put(rlKey, '1', { expirationTtl: 60 }).catch(() => {});
        }

        // Generate OTP server-side and store in KV (5-min TTL)
        const otp          = await generateOTP();
        const templateName = env.WA_OTP_TEMPLATE_NAME || 'brgcabs_otp';
        const langCode     = env.WA_TEMPLATE_LANG     || 'en';

        if (env.BOOKINGS) {
          await env.BOOKINGS.put(`otp:${phone}`, otp, { expirationTtl: 300 }).catch(() => {});
        }

        // Component: body + button (with auto-fallback to body-only if needed)
        const components = [
          {
            type: 'body',
            parameters: [{ type: 'text', text: String(otp) }],
          },
          {
            type:       'button',
            sub_type:   'url',
            index:      '0',
            parameters: [{ type: 'text', text: String(otp) }],
          },
        ];

        try {
          const waResult = await sendWhatsApp(phone, templateName, langCode, components);

          // Auto-fallback: if URL button is static Meta returns error 132000 — retry body-only
          if (waResult.error && waResult.error.code === 132000) {
            console.warn('URL button is static — retrying with body-only component');
            const fallback = [{ type: 'body', parameters: [{ type: 'text', text: String(otp) }] }];
            const retry    = await sendWhatsApp(phone, templateName, langCode, fallback);
            if (retry.error) {
              return json({ success: false, error: retry.error.message, code: retry.error.code }, 502);
            }
            return json({ success: true, message: 'OTP sent via WhatsApp', messageId: retry.messages?.[0]?.id });
          }

          if (waResult.error) {
            console.error('WA OTP error:', JSON.stringify(waResult.error));
            return json({ success: false, error: waResult.error.message || 'WhatsApp send failed', code: waResult.error.code, details: waResult.error }, 502);
          }

          return json({ success: true, message: 'OTP sent via WhatsApp', messageId: waResult.messages?.[0]?.id });

        } catch (waErr) {
          console.error('WA OTP exception:', waErr.message);
          return json({ success: false, error: waErr.message }, 502);
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // 1b. VERIFY OTP  —  POST /api/otp/verify
      //     Body: { phone, otp }
      //     Verifies against KV-stored OTP, deletes after use
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/otp/verify' && request.method === 'POST') {
        const body  = await request.json();
        const phone = normalizePhone(body.phone);
        const otp   = String(body.otp || '').trim();

        if (!phone || !otp) {
          return json({ success: false, error: 'phone and otp are required' }, 400);
        }

        if (!env.BOOKINGS) {
          return json({ success: false, error: 'KV storage not configured' }, 503);
        }

        const stored = await env.BOOKINGS.get(`otp:${phone}`).catch(() => null);

        if (!stored) {
          return json({ success: false, error: 'OTP expired or not found. Please request a new OTP.' }, 400);
        }

        if (stored !== otp) {
          return json({ success: false, error: 'Invalid OTP. Please try again.' }, 400);
        }

        // OTP verified — delete immediately (single use)
        await env.BOOKINGS.delete(`otp:${phone}`).catch(() => {});

        // Issue a short-lived session token (10-min TTL)
        const sessionToken = String(Math.random()).slice(2, 10) + String(Date.now()).slice(-6);
        await env.BOOKINGS.put(`session:${phone}`, sessionToken, { expirationTtl: 600 }).catch(() => {});

        return json({ success: true, verified: true, sessionToken });
      }

      // ══════════════════════════════════════════════════════════════════════
      // 2. DISTANCE MATRIX  —  GET /api/distance
      // ══════════════════════════════════════════════════════════════════════
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

      // ══════════════════════════════════════════════════════════════════════
      // 3. PLACES AUTOCOMPLETE  —  GET /api/places
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/places' && request.method === 'GET') {
        const input = url.searchParams.get('input');

        if (!input || input.trim().length < 2) {
          return json({ success: false, predictions: [] });
        }

        const placesRes = await fetch(
          'https://places.googleapis.com/v1/places:autocomplete',
          {
            method: 'POST',
            headers: {
              'Content-Type':     'application/json',
              'X-Goog-Api-Key':   env.GOOGLE_MAPS_KEY,
              'X-Goog-FieldMask':
                'suggestions.placePrediction.placeId,' +
                'suggestions.placePrediction.text,' +
                'suggestions.placePrediction.structuredFormat',
            },
            body: JSON.stringify({
              input,
              includedRegionCodes: ['IN'],
              languageCode: 'en',
            }),
          }
        );

        const placesData = await placesRes.json();

        if (!placesRes.ok) {
          console.error('Places API error:', JSON.stringify(placesData?.error || placesData));
          return json({ success: false, error: placesData?.error?.message || 'Places API failed', predictions: [] }, 502);
        }

        const predictions = (placesData.suggestions || [])
          .map(item => {
            const place = item.placePrediction;
            return {
              place_id:    place?.placeId     || '',
              description: place?.text?.text  || '',
              main_text:   place?.structuredFormat?.mainText?.text     || place?.text?.text || '',
              secondary:   place?.structuredFormat?.secondaryText?.text || '',
            };
          })
          .slice(0, 8);

        return json({ success: true, predictions });
      }

      // ══════════════════════════════════════════════════════════════════════
      // 4. CREATE RAZORPAY ORDER  —  POST /api/payment/order
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/payment/order' && request.method === 'POST') {
        const { amount, bookingId, notes } = await request.json();

        if (!amount || amount < 100) {
          return json({ success: false, error: 'Invalid amount (minimum ₹100)' }, 400);
        }

        const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

        const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
          method:  'POST',
          headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            amount:   Math.round(amount * 100),
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
          key_id:   env.RAZORPAY_KEY_ID,
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // 5. VERIFY RAZORPAY PAYMENT  —  POST /api/payment/verify
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/payment/verify' && request.method === 'POST') {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await request.json();

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
          return json({ success: false, error: 'Missing payment fields' }, 400);
        }

        const encoder   = new TextEncoder();
        const keyData   = encoder.encode(env.RAZORPAY_KEY_SECRET);
        const msgData   = encoder.encode(`${razorpay_order_id}|${razorpay_payment_id}`);
        const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sigBuf    = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
        const expected  = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

        if (expected === razorpay_signature) {
          return json({ success: true, verified: true, payment_id: razorpay_payment_id });
        } else {
          return json({ success: false, verified: false, error: 'Signature mismatch' }, 400);
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // 6. BOOKING NOTIFICATION  —  POST /api/booking/notify
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/booking/notify' && request.method === 'POST') {
        const { booking } = await request.json();

        if (!booking || !booking.id) {
          return json({ success: false, error: 'Invalid booking data' }, 400);
        }

        const results = { stored: false, sheet: false, adminNotified: false };

        // Store in KV (90-day TTL)
        if (env.BOOKINGS) {
          try {
            await env.BOOKINGS.put(booking.id, JSON.stringify({
              ...booking,
              timestamp: new Date().toISOString(),
            }), { expirationTtl: 7776000 });
            results.stored = true;
          } catch (e) { console.error('KV store error:', e.message); }
        }

        // Log to Google Sheet
        if (env.GOOGLE_SCRIPT_URL) {
          try {
            await fetch(env.GOOGLE_SCRIPT_URL, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ type: 'booking_notify', booking }),
            });
            results.sheet = true;
          } catch (e) { console.error('Sheet log error:', e.message); }
        }

        // Notify admin on WhatsApp
        if (env.ADMIN_PHONE && env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID) {
          try {
            const adminPhoneNorm = normalizePhone(env.ADMIN_PHONE);
            if (adminPhoneNorm) {
              const adminMsg = [
                `🚖 *New BRG CABS Booking!*`,
                `ID: ${booking.id}`,
                `👤 ${booking.name} | 📞 ${booking.phone}`,
                `📍 ${booking.pickup || booking.from} → ${booking.drop || booking.to}`,
                `📅 ${booking.date}${booking.time ? ' ' + booking.time : ''}`,
                `🚗 ${booking.vehicleName || booking.vehicle} | ${booking.tripType || 'One Way'}`,
                `💰 Fare: ₹${booking.totalFare || booking.fare} | Advance: ₹${booking.advAmt || booking.advance || 0}`,
                booking.notes ? `📝 ${booking.notes}` : '',
              ].filter(Boolean).join('\n');

              await fetch(
                `https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`,
                {
                  method:  'POST',
                  headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to:   '+' + adminPhoneNorm,
                    type: 'text',
                    text: { body: adminMsg, preview_url: false },
                  }),
                }
              );
              results.adminNotified = true;
            }
          } catch (e) { console.error('Admin WA notify error:', e.message); }
        }

        return json({ success: true, ...results });
      }

      // ══════════════════════════════════════════════════════════════════════
      // 7. PAYMENT NOTIFICATION  —  POST /api/payment/notify
      //    Body: { bookingId, paymentId, orderId, paymentType, amount,
      //            totalFare, balance, name, phone }
      //    Stores payment record in KV + sends WhatsApp alert to admin
      // ══════════════════════════════════════════════════════════════════════
      if (path === '/api/payment/notify' && request.method === 'POST') {
        const body = await request.json();
        const { bookingId, paymentId, paymentType, amount, totalFare, balance, name, phone } = body;

        if (!bookingId || !paymentId) {
          return json({ success: false, error: 'bookingId and paymentId are required' }, 400);
        }

        const results = { stored: false, adminNotified: false };

        // Store payment record in KV (90-day TTL)
        if (env.BOOKINGS) {
          try {
            await env.BOOKINGS.put('payment:' + bookingId, JSON.stringify({
              ...body,
              timestamp: new Date().toISOString(),
            }), { expirationTtl: 7776000 });
            results.stored = true;
          } catch (e) { console.error('KV payment store error:', e.message); }
        }

        // WhatsApp alert to admin
        if (env.ADMIN_PHONE && env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID) {
          try {
            const adminPhoneNorm = normalizePhone(env.ADMIN_PHONE);
            if (adminPhoneNorm) {
              const balanceMsg = balance > 0
                ? `Balance ₹${balance} to be collected from customer`
                : 'FULLY PAID — nothing to collect';
              const msg = [
                `💳 *BRG CABS — Payment Received!*`,
                `📋 Booking: ${bookingId}`,
                `👤 ${name || 'N/A'} | 📞 ${phone || 'N/A'}`,
                `💰 ${paymentType || 'Payment'}: ₹${amount || 0}`,
                `🧾 Total Fare: ₹${totalFare || 0}`,
                balanceMsg,
                `🔑 Payment ID: ${paymentId}`,
              ].join('\n');

              await fetch(
                `https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`,
                {
                  method:  'POST',
                  headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to:   '+' + adminPhoneNorm,
                    type: 'text',
                    text: { body: msg, preview_url: false },
                  }),
                }
              );
              results.adminNotified = true;
            }
          } catch (e) { console.error('Payment WA notify error:', e.message); }
        }

        return json({ success: true, ...results });
      }

      return json({ success: false, error: 'Endpoint not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ success: false, error: 'Internal server error' }, 500);
    }
  },
};
