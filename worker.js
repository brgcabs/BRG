/**
 * ════════════════════════════════════════════════════════════════
 *  BRG CABS — Cloudflare Worker
 *  URL: https://brgcabs.brgtoursindia.workers.dev
 * ════════════════════════════════════════════════════════════════
 *
 *  ENVIRONMENT VARIABLES (Settings → Variables and Secrets)
 *  ─────────────────────────────────────────────────────────────
 *  GOOGLE_MAPS_KEY        → Google Maps API Key
 *  GOOGLE_SCRIPT_URL      → Google Apps Script URL (for booking sheet logging)
 *  RAZORPAY_KEY_ID        → Razorpay Key ID
 *  RAZORPAY_KEY_SECRET    → Razorpay Key Secret
 *  ALLOWED_ORIGIN         → https://www.brgcabs.in
 *  ADMIN_EMAIL            → Admin email for notifications
 *  ADMIN_PHONE            → Admin WhatsApp number (91XXXXXXXXXX)
 *  WA_ACCESS_TOKEN        → WhatsApp Business API Bearer Token
 *  WA_PHONE_NUMBER_ID     → WhatsApp Business Phone Number ID
 *  WA_OTP_TEMPLATE_NAME   → WhatsApp OTP template name (e.g. "brg_otp")
 *  WA_TEMPLATE_LANG       → Template language code (e.g. "en" or "en_US")
 * ════════════════════════════════════════════════════════════════
 *
 *  API ENDPOINTS:
 *  ─────────────────────────────────────────────────────────────
 *  POST /api/otp/send          → Send OTP via WhatsApp Business API
 *  GET  /api/distance          → Google Distance Matrix
 *  GET  /api/places            → Google Places Autocomplete — Places API (New)
 *  POST /api/payment/order     → Create Razorpay Order
 *  POST /api/payment/verify    → Verify Razorpay Payment Signature
 *  POST /api/booking/notify    → Save booking + notify admin on WhatsApp
 * ════════════════════════════════════════════════════════════════
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS HEADERS ──
    // Places & Distance are public read-only (key is server-side).
    // Allow all origins so the site works from any domain/localhost/file.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    // ── WhatsApp API helper ──
    const sendWhatsApp = async (toPhone, templateName, langCode, components) => {
      const phoneId = env.WA_PHONE_NUMBER_ID;
      const token   = env.WA_ACCESS_TOKEN;
      if (!phoneId || !token) throw new Error('WhatsApp not configured');

      // Ensure phone is in international format without + (e.g. 919876543210)
      const phone = toPhone.replace(/\D/g, '').replace(/^0/, '91');

      const body = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: langCode || 'en' },
          components: components || [],
        },
      };

      const res = await fetch(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      return res.json();
    };

    try {
      const path = url.pathname;

      // ──────────────────────────────────────────────────────────
      // 1. SEND OTP via WhatsApp Business API
      // POST /api/otp/send
      // Body: { phone: "9876543210", otp: "4521", name: "Rajesh" }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/otp/send' && request.method === 'POST') {
        const { phone, otp, name } = await request.json();

        if (!phone || !otp) {
          return json({ success: false, error: 'phone and otp are required' }, 400);
        }

        const templateName = env.WA_OTP_TEMPLATE_NAME || 'brgcabs_otp';
        const langCode     = env.WA_TEMPLATE_LANG     || 'en';

        // Meta Authentication template: "*{{1}}* is your verification code."
        // Authentication templates ONLY take one component: button with otp_type=COPY_CODE
        // The body {{1}} is automatically filled by the button parameter
        const components = [
          {
            type:     'button',
            sub_type: 'url',
            index:    '0',
            parameters: [{ type: 'text', text: otp }],
          },
        ];

        try {
          const waResult = await sendWhatsApp(phone, templateName, langCode, components);

          if (waResult.error) {
            console.error('WA OTP error:', JSON.stringify(waResult.error));
            return json({ success: false, error: waResult.error.message || 'WhatsApp send failed' }, 502);
          }

          return json({ success: true, message: 'OTP sent via WhatsApp', messageId: waResult.messages?.[0]?.id });

        } catch (waErr) {
          console.error('WA OTP exception:', waErr.message);
          return json({ success: false, error: 'OTP service error' }, 502);
        }
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
      // 3. PLACES AUTOCOMPLETE — Places API (New)
      // GET /api/places?input=Mumbai airport
      // ──────────────────────────────────────────────────────────
      if (path === '/api/places' && request.method === 'GET') {
        const input = url.searchParams.get('input');

        if (!input || input.trim().length < 2) {
          return json({ success: false, predictions: [] });
        }

        // Places API (New) — autocomplete endpoint.
        // Requires: Places API (New) enabled in Google Cloud Console.
        // includedPrimaryTypes not set → returns all place types (cities, airports,
        // stations, streets, landmarks) across India.
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
          console.error('Places API (New) error:', JSON.stringify(placesData?.error || placesData));
          return json({
            success:     false,
            error:       placesData?.error?.message || 'Places API failed',
            predictions: [],
          }, 502);
        }

        const predictions = (placesData.suggestions || [])
          .map(item => {
            const place = item.placePrediction;
            return {
              place_id:    place?.placeId || '',
              description: place?.text?.text || '',
              main_text:   place?.structuredFormat?.mainText?.text     || place?.text?.text || '',
              secondary:   place?.structuredFormat?.secondaryText?.text || '',
            };
          })
          .slice(0, 8);

        return json({ success: true, predictions });
      }

      // ──────────────────────────────────────────────────────────
      // 4. CREATE RAZORPAY ORDER
      // POST /api/payment/order
      // Body: { amount: 500, bookingId: "BRG123456", notes: {} }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/payment/order' && request.method === 'POST') {
        const { amount, bookingId, notes } = await request.json();

        if (!amount || amount < 100) {
          return json({ success: false, error: 'Invalid amount (minimum ₹100)' }, 400);
        }

        const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

        const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
          method:  'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            amount:   Math.round(amount * 100), // paise
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

      // ──────────────────────────────────────────────────────────
      // 5. VERIFY RAZORPAY PAYMENT
      // POST /api/payment/verify
      // Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
      // ──────────────────────────────────────────────────────────
      if (path === '/api/payment/verify' && request.method === 'POST') {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await request.json();

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
          return json({ success: false, error: 'Missing payment fields' }, 400);
        }

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
      // 6. BOOKING NOTIFICATION
      // POST /api/booking/notify
      // Body: { booking: { id, name, phone, from, to, date, vehicle, fare, tripType } }
      // ── Saves to KV + logs to Google Sheet + notifies admin on WhatsApp
      // ──────────────────────────────────────────────────────────
      if (path === '/api/booking/notify' && request.method === 'POST') {
        const { booking } = await request.json();

        if (!booking || !booking.id) {
          return json({ success: false, error: 'Invalid booking data' }, 400);
        }

        const results = { stored: false, sheet: false, adminNotified: false };

        // ── Save to KV (BOOKINGS namespace) ──
        if (env.BOOKINGS) {
          try {
            await env.BOOKINGS.put(booking.id, JSON.stringify({
              ...booking,
              timestamp: new Date().toISOString(),
            }), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days
            results.stored = true;
          } catch (e) { console.error('KV store error:', e.message); }
        }

        // ── Log to Google Sheet via Apps Script ──
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

        // ── Notify Admin on WhatsApp ──
        if (env.ADMIN_PHONE && env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID) {
          try {
            const adminMsg = [
              `🚖 *New BRG CABS Booking!*`,
              `ID: ${booking.id}`,
              `👤 ${booking.name} | 📞 ${booking.phone}`,
              `📍 ${booking.from} → ${booking.to}`,
              `📅 ${booking.date}${booking.time ? ' ' + booking.time : ''}`,
              `🚗 ${booking.vehicle} | ${booking.tripType || 'One Way'}`,
              `💰 Fare: ₹${booking.fare} | Advance: ₹${booking.advance || 0}`,
              booking.notes ? `📝 ${booking.notes}` : '',
            ].filter(Boolean).join('\n');

            // Use a text message for admin (no template needed for business-initiated text to own number)
            // If admin number is verified in WABA, use template; otherwise use text
            const adminPhoneClean = env.ADMIN_PHONE.replace(/\D/g, '').replace(/^0/, '91');
            await fetch(
              `https://graph.facebook.com/v19.0/${env.WA_PHONE_NUMBER_ID}/messages`,
              {
                method:  'POST',
                headers: {
                  'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`,
                  'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to:   adminPhoneClean,
                  type: 'text',
                  text: { body: adminMsg, preview_url: false },
                }),
              }
            );
            results.adminNotified = true;
          } catch (e) { console.error('Admin WA notify error:', e.message); }
        }

        return json({ success: true, ...results });
      }

      // ── DEBUG: GET /api/debug/places?input=delhi
      // Remove or protect this endpoint before going to production
      if (path === '/api/debug/places' && request.method === 'GET') {
        const input = url.searchParams.get('input') || 'delhi';
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
            body: JSON.stringify({ input, includedRegionCodes: ['IN'], languageCode: 'en' }),
          }
        );
        const raw = await placesRes.json();
        return new Response(JSON.stringify({ httpStatus: placesRes.status, raw }, null, 2), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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
 *  ALL ENVIRONMENT VARIABLES — already set in your dashboard ✅
 * ════════════════════════════════════════════════════════════════
 *
 *  ADMIN_EMAIL            ✅
 *  ADMIN_PHONE            ✅  (format: 919876543210)
 *  ALLOWED_ORIGIN         ✅  https://www.brgcabs.in
 *  GOOGLE_MAPS_KEY        ✅
 *  GOOGLE_SCRIPT_URL      ✅
 *  RAZORPAY_KEY_ID        ✅
 *  RAZORPAY_KEY_SECRET    ✅
 *  WA_ACCESS_TOKEN        ✅
 *  WA_OTP_TEMPLATE_NAME   ✅  (your approved OTP template name)
 *  WA_PHONE_NUMBER_ID     ✅
 *  WA_TEMPLATE_LANG       ✅  (e.g. "en" or "en_US")
 *
 *  OPTIONAL — Add KV namespace binding named "BOOKINGS" for booking storage
 *
 * ════════════════════════════════════════════════════════════════
 *  OTP TEMPLATE — brgcabs_otp (Authentication, Active ✅)
 * ════════════════════════════════════════════════════════════════
 *  Template body: "*{{1}}* is your verification code."
 *  Category: Authentication — Meta auto-fills {{1}} via the button parameter.
 *  No body component needed — only the button component with the OTP value.
 *  WA_OTP_TEMPLATE_NAME = "brgcabs_otp"
 *  WA_TEMPLATE_LANG     = "en"
 * ════════════════════════════════════════════════════════════════
 */
