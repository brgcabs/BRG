/**
 * ════════════════════════════════════════════════════════════════
 *  BRG CABS — Google Apps Script (OTP Sender + Booking Notifier)
 *  File: Code.gs
 *
 *  HOW TO DEPLOY:
 *  ─────────────────────────────────────────────────────────────
 *  1. Go to https://script.google.com → New Project
 *  2. Name it "BRG CABS OTP"
 *  3. Paste this entire code into Code.gs
 *  4. Set Script Properties (File → Project Settings → Script Properties):
 *
 *     Property Name        │ Value
 *     ──────────────────────────────────────────────────────────
 *     FAST2SMS_API_KEY     │ Your Fast2SMS API key (fast2sms.com)
 *     ADMIN_PHONE          │ 919811419926
 *     ADMIN_EMAIL          │ brgcabs@gmail.com  (your email)
 *     BRG_SHEET_ID         │ (optional) Google Sheet ID for bookings log
 *
 *  5. Click Deploy → New Deployment → Web App
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  6. Copy the Web App URL → paste as GAS_URL in index.html
 *
 * ════════════════════════════════════════════════════════════════
 */

const PROPS = PropertiesService.getScriptProperties();

// ── GET HANDLER ────────────────────────────────────────────────
// Called by the HTML page via no-cors fetch with ?action=...
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = params.action || '';

  // ── sendOTP ─────────────────────────────────────────────────
  if (action === 'sendOTP') {
    const phone     = params.phone     || '';
    const name      = params.name      || 'Customer';
    const otp       = params.otp       || '';
    const bookingId = params.bookingId || '';

    if (!phone || !otp) {
      return jsonResponse({ success: false, error: 'phone and otp required' });
    }

    const cleanPhone = String(phone).replace(/^\+?91/, '').replace(/\D/g, '');

    // 1. Try Fast2SMS SMS delivery
    const smsResult = sendFast2SMS(cleanPhone, otp, name);
    if (smsResult.success) {
      logOTPRequest(cleanPhone, otp, 'fast2sms', true);
      return jsonResponse({ success: true, method: 'fast2sms' });
    }

    // 2. Fallback — email OTP to admin so they can relay it
    const emailResult = sendOTPEmail(cleanPhone, otp, name);
    logOTPRequest(cleanPhone, otp, 'email', emailResult.success);
    return jsonResponse(emailResult);
  }

  // ── booking ──────────────────────────────────────────────────
  // Log confirmed booking to sheet + send admin & customer emails
  if (action === 'booking') {
    try {
      const booking = JSON.parse(params.data || '{}');
      handleBookingNotify(booking);
      return jsonResponse({ success: true });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message });
    }
  }

  // ── health check ─────────────────────────────────────────────
  return ContentService
    .createTextOutput('BRG CABS OTP Service is running. ✓')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ── POST HANDLER ───────────────────────────────────────────────
// Kept for backward compatibility with Cloudflare Worker
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const type = data.type || 'send_otp';

    if (type === 'send_otp') {
      return handleSendOTP(data);
    }

    if (type === 'booking_notify') {
      return handleBookingNotify(data.booking);
    }

    return jsonResponse({ success: false, error: 'Unknown request type' });

  } catch (err) {
    Logger.log('Error: ' + err.message);
    return jsonResponse({ success: false, error: err.message });
  }
}

// ══════════════════════════════════════════════════════════════
// 1. SEND OTP
// ══════════════════════════════════════════════════════════════
function handleSendOTP(data) {
  const { phone, otp, name } = data;

  if (!phone || !otp) {
    return jsonResponse({ success: false, error: 'phone and otp are required' });
  }

  const cleanPhone = String(phone).replace(/^\+?91/, '').replace(/\D/g, '');

  if (cleanPhone.length !== 10) {
    return jsonResponse({ success: false, error: 'Invalid phone number' });
  }

  // Try Fast2SMS first
  const fast2smsResult = sendFast2SMS(cleanPhone, otp, name);
  if (fast2smsResult.success) {
    logOTPRequest(cleanPhone, otp, 'fast2sms', true);
    return jsonResponse({ success: true, method: 'fast2sms', message: 'OTP sent successfully' });
  }

  // Fallback: send via Email
  const emailResult = sendOTPEmail(cleanPhone, otp, name);
  logOTPRequest(cleanPhone, otp, 'email', emailResult.success);

  return jsonResponse(emailResult);
}

// ── FAST2SMS — QUICK ROUTE (no DLT registration needed) ───────
// After DLT approval: swap to OTP route with sender ID & template ID
function sendFast2SMS(phone, otp, name) {
  const apiKey = PROPS.getProperty('FAST2SMS_API_KEY');
  if (!apiKey) {
    Logger.log('Fast2SMS: API key not set in Script Properties');
    return { success: false, error: 'Fast2SMS API key not configured' };
  }

  try {
    // ── QUICK ROUTE (active — works without DLT) ──────────────
    const payload = {
      route: 'q',
      message: 'Your BRG CABS booking OTP is ' + otp + '. Valid for 5 minutes. Do not share.',
      language: 'english',
      flash: 0,
      numbers: phone
    };

    // ── OTP ROUTE (enable after DLT approval) ─────────────────
    // Replace the payload above with this once DLT is approved:
    /*
    const payload = {
      route: 'otp',
      sender_id: 'BRGCAB',               // your approved sender ID
      message: 'YOUR_TEMPLATE_ID',        // your approved template ID
      variables_values: String(otp),
      numbers: phone,
      flash: 0
    };
    */

    const response = UrlFetchApp.fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'post',
      headers: {
        'authorization': apiKey,
        'Content-Type': 'application/json',
        'cache-control': 'no-cache'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());
    Logger.log('Fast2SMS response: ' + JSON.stringify(result));

    if (result.return === true) {
      return { success: true };
    } else {
      Logger.log('Fast2SMS failed: ' + JSON.stringify(result));
      return { success: false, error: result.message || 'Fast2SMS failed' };
    }

  } catch (err) {
    Logger.log('Fast2SMS error: ' + err.message);
    return { success: false, error: err.message };
  }
}

// ── EMAIL FALLBACK ─────────────────────────────────────────────
function sendOTPEmail(phone, otp, name) {
  const adminEmail = PROPS.getProperty('ADMIN_EMAIL');
  if (!adminEmail) {
    return { success: false, error: 'No email configured' };
  }

  try {
    MailApp.sendEmail({
      to:      adminEmail,
      subject: `BRG CABS OTP for +91${phone}`,
      htmlBody: `
        <div style="font-family:Arial;padding:20px;background:#f5f5f5">
          <div style="background:#0A0A0A;border-radius:12px;padding:24px;max-width:400px;margin:auto">
            <h2 style="color:#F5C518;font-family:Arial;margin:0 0 16px">BRG CABS OTP</h2>
            <p style="color:#fff">Customer Phone: <strong>+91${phone}</strong></p>
            <p style="color:#fff">Customer Name: ${name || 'Customer'}</p>
            <div style="background:#F5C518;border-radius:8px;padding:16px;text-align:center;margin:16px 0">
              <span style="font-size:2rem;font-weight:900;color:#000;letter-spacing:8px">${otp}</span>
            </div>
            <p style="color:rgba(255,255,255,.5);font-size:.8rem">Valid for 5 minutes. Please call or WhatsApp the customer to relay this OTP.</p>
            <a href="https://wa.me/91${phone}?text=Your%20BRG%20CABS%20OTP%20is%20${otp}.%20Valid%20for%205%20minutes."
               style="display:block;background:#25D366;color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">
              📲 Send OTP via WhatsApp
            </a>
          </div>
        </div>
      `
    });
    return { success: true, method: 'email' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// 2. BOOKING NOTIFICATION
// ══════════════════════════════════════════════════════════════
function handleBookingNotify(booking) {
  if (!booking) return jsonResponse({ success: false, error: 'No booking data' });

  // 1. Log to Google Sheets
  logBookingToSheet(booking);

  // 2. Send admin email notification
  sendAdminEmailNotification(booking);

  // 3. Send customer confirmation email
  if (booking.email) {
    sendCustomerConfirmationEmail(booking);
  }

  return jsonResponse({ success: true, message: 'Booking logged and notified' });
}

// ── LOG TO GOOGLE SHEETS ───────────────────────────────────────
function logBookingToSheet(booking) {
  const sheetId = PROPS.getProperty('BRG_SHEET_ID');
  if (!sheetId) return;

  try {
    const sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();

    // Add header if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Booking ID', 'Date', 'Name', 'Phone', 'Email',
        'Vehicle', 'Trip Type', 'Pickup', 'Drop',
        'Distance (km)', 'Fare (₹)', 'Advance (₹)',
        'Travel Date', 'Travel Time', 'Passengers',
        'Payment ID', 'Status', 'Notes'
      ]);
      sheet.getRange(1, 1, 1, 18).setBackground('#F5C518').setFontWeight('bold');
    }

    sheet.appendRow([
      booking.id             || '',
      new Date().toLocaleString('en-IN'),
      booking.name           || '',
      '+91' + (booking.phone || ''),
      booking.email          || '',
      booking.vehicleName    || '',
      booking.tripType       || '',
      booking.pickup         || '',
      booking.drop           || '',
      booking.distKm         || '',
      booking.totalFare      || '',
      booking.advAmt         || '',
      booking.date           || '',
      booking.time           || '',
      booking.pax            || '',
      booking.paymentId      || 'Pending',
      booking.paymentId ? 'Paid (Advance)' : 'WhatsApp Booking',
      booking.notes          || ''
    ]);
  } catch (err) {
    Logger.log('Sheet error: ' + err.message);
  }
}

// ── ADMIN EMAIL ────────────────────────────────────────────────
function sendAdminEmailNotification(booking) {
  const adminEmail = PROPS.getProperty('ADMIN_EMAIL');
  if (!adminEmail) return;

  try {
    MailApp.sendEmail({
      to:      adminEmail,
      subject: `🚕 New Booking: ${booking.id} — ${booking.name}`,
      htmlBody: `
        <div style="font-family:Arial;background:#f5f5f5;padding:20px">
          <div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
            <div style="background:#0A0A0A;padding:24px;text-align:center">
              <h1 style="color:#F5C518;margin:0;font-size:1.6rem">🚕 BRG CABS</h1>
              <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:.85rem">New Booking Received</p>
            </div>
            <div style="padding:24px">
              <div style="background:#FFF8E1;border-left:4px solid #F5C518;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px">
                <strong style="font-size:1rem">Booking ID: ${booking.id}</strong><br>
                <span style="color:#666;font-size:.85rem">${new Date().toLocaleString('en-IN')}</span>
              </div>
              ${infoRow('👤 Customer', `${booking.name} · +91${booking.phone}`)}
              ${infoRow('🚗 Vehicle', booking.vehicleName)}
              ${infoRow('🎯 Trip Type', booking.tripType === 'roundtrip' ? 'Round Trip' : 'One Way')}
              ${infoRow('📍 Pickup', booking.pickup)}
              ${infoRow('🏁 Drop', booking.drop)}
              ${infoRow('📅 Travel', `${booking.date} at ${booking.time}`)}
              ${infoRow('👥 Passengers', booking.pax)}
              ${infoRow('📏 Distance', `~${booking.distKm} km`)}
              ${infoRow('💰 Total Fare', `₹${(booking.totalFare||0).toLocaleString('en-IN')}`)}
              ${infoRow('💳 Advance Paid', booking.paymentId ? `₹${booking.advAmt} ✅` : 'Not Paid')}
              ${booking.notes ? infoRow('📝 Notes', booking.notes) : ''}
            </div>
            <div style="background:#0A0A0A;padding:16px;text-align:center">
              <a href="tel:+91${booking.phone}" style="background:#F5C518;color:#000;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:700;font-size:.9rem;display:inline-block">📞 Call Customer</a>
              &nbsp;
              <a href="https://wa.me/91${booking.phone}?text=Hi%20${encodeURIComponent(booking.name)}!%20Your%20BRG%20CABS%20booking%20${booking.id}%20is%20confirmed." style="background:#25D366;color:#fff;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:700;font-size:.9rem;display:inline-block">💬 WhatsApp</a>
            </div>
          </div>
        </div>
      `
    });
  } catch (err) {
    Logger.log('Admin email error: ' + err.message);
  }
}

// ── CUSTOMER CONFIRMATION EMAIL ────────────────────────────────
function sendCustomerConfirmationEmail(booking) {
  try {
    MailApp.sendEmail({
      to:      booking.email,
      subject: `✅ Booking Confirmed — ${booking.id} | BRG CABS`,
      htmlBody: `
        <div style="font-family:Arial;background:#f5f5f5;padding:20px">
          <div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
            <div style="background:#0A0A0A;padding:32px;text-align:center">
              <h1 style="color:#F5C518;margin:0;font-size:2rem">BRG CABS</h1>
              <p style="color:rgba(255,255,255,.5);margin:4px 0 0">Delhi NCR's Trusted Ride</p>
            </div>
            <div style="padding:28px;text-align:center">
              <div style="width:64px;height:64px;background:#22C55E;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:2rem;margin-bottom:16px">✓</div>
              <h2 style="margin:0 0 8px;color:#0A0A0A">Booking Confirmed!</h2>
              <p style="color:#666;margin:0 0 20px">Hi ${booking.name}, your cab is confirmed.</p>
              <div style="background:#FFF8E1;border:2px dashed #F5C518;border-radius:12px;padding:14px;display:inline-block;margin-bottom:24px">
                <div style="font-size:.75rem;color:#666;text-transform:uppercase;letter-spacing:1px">Booking ID</div>
                <div style="font-size:1.4rem;font-weight:900;letter-spacing:3px;color:#0A0A0A">${booking.id}</div>
              </div>
            </div>
            <div style="padding:0 28px 28px">
              ${infoRow('🚗 Vehicle', booking.vehicleName)}
              ${infoRow('📍 Pickup', booking.pickup)}
              ${infoRow('🏁 Drop', booking.drop)}
              ${infoRow('📅 Date & Time', `${booking.date} at ${booking.time}`)}
              ${infoRow('💰 Estimated Fare', `₹${(booking.totalFare||0).toLocaleString('en-IN')}`)}
              ${infoRow('💳 Advance Paid', booking.paymentId ? `₹${booking.advAmt} ✅` : 'Balance payable to driver')}
            </div>
            <div style="background:#F8F8F8;padding:20px 28px;border-top:1px solid #eee">
              <p style="margin:0 0 12px;font-size:.88rem;color:#444">Need help? Contact us:</p>
              <p style="margin:0;font-size:.9rem"><strong>📞 +91 98114 19926</strong> &nbsp;|&nbsp; <a href="https://wa.me/919811419926">💬 WhatsApp</a></p>
            </div>
            <div style="background:#0A0A0A;padding:16px;text-align:center">
              <p style="color:rgba(255,255,255,.35);margin:0;font-size:.75rem">© 2025 BRG CABS · www.brgcabs.in · B158/159 Sainik Nagar, Uttam Nagar, New Delhi</p>
            </div>
          </div>
        </div>
      `
    });
  } catch (err) {
    Logger.log('Customer email error: ' + err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════
function infoRow(label, value) {
  return `
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:.88rem">
      <span style="color:#666">${label}</span>
      <span style="font-weight:700;color:#0A0A0A;text-align:right;max-width:60%">${value || '—'}</span>
    </div>`;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function logOTPRequest(phone, otp, method, success) {
  Logger.log(`OTP [${method}] → +91${phone} → ${success ? 'SUCCESS' : 'FAILED'}`);
}
