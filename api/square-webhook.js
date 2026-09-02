// ============================================================
//  East End Roses — Square webhook receiver
//  ------------------------------------------------------------
//  Square sends a "payment.completed" (or "payment.updated" with
//  status COMPLETED) webhook here after every successfully paid
//  order. This function:
//    1. Verifies the webhook signature (HMAC-SHA256).
//    2. Fetches the payment + order details from Square.
//    3. Writes one row PER LINE ITEM to the Google Sheet via the
//       Apps Script web app (server-side, no CORS): order ref,
//       product, fragrance, qty, total, buyer name + email,
//       status PAID.
//  Nothing is logged unless payment really completed.
//
//  Required env vars on Vercel:
//    SQUARE_ACCESS_TOKEN
//    SQUARE_WEBHOOK_SIGNATURE_KEY  (from the Square subscription)
//    SQUARE_WEBHOOK_URL            (the exact notification URL you
//                                   registered in the Square dashboard,
//                                   e.g. https://xxx.vercel.app/api/square-webhook)
//    GOOGLE_WEB_APP_URL            (Google Apps Script web app URL)
// ============================================================

const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
const NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_URL || "";
const GOOGLE_WEB_APP_URL = process.env.GOOGLE_WEB_APP_URL || "";
const SQUARE_API = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-08-19";

// Square signs the concatenation: notificationUrl + rawBody
function isValidSignature(rawBody, signatureHeader) {
  if (!SIGNATURE_KEY || !NOTIFICATION_URL || !signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", SIGNATURE_KEY)
    .update(NOTIFICATION_URL + rawBody)
    .digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader || "", "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function fetchSquare(path) {
  const resp = await fetch(SQUARE_API + path, {
    headers: {
      Authorization: "Bearer " + SQUARE_ACCESS_TOKEN,
      "Square-Version": SQUARE_VERSION
    }
  });
  return resp.json();
}

// Parse all line items from the order, returning an array.
function getOrderInfos(order) {
  var items = order.line_items || [];
  var results = [];
  for (var i = 0; i < items.length; i++) {
    var li = items[i];
    var name = li.name || "";
    var dash = name.indexOf(" - ");
    var product = dash >= 0 ? name.slice(0, dash) : name;
    var scent = dash >= 0 ? name.slice(dash + 3) : "";
    var qty = parseInt(li.quantity, 10) || 1;
    var unitMoney = li.base_price_money || {};
    var unitCents = unitMoney.amount || 0;
    results.push({ product: product, scent: scent, qty: qty, unitCents: unitCents });
  }
  return results;
}

// Parse labels from payment note. Format per item: "... [Label: text]"
// Returns an array of labels in order, matching the line-items array.
function parseNoteLabels(note) {
  var parts = note.split("; ");
  var labels = [];
  for (var i = 0; i < parts.length; i++) {
    var match = parts[i].match(/\[Label:\s*([^\]]*)\]/);
    labels.push(match ? match[1].trim() : "");
  }
  return labels;
}

module.exports = async (req, res) => {
  // Diagnostic: open this URL in a browser to see version + env status.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      version: "2.2",
      env: {
        hasAccessToken: !!SQUARE_ACCESS_TOKEN,
        hasSignatureKey: !!SIGNATURE_KEY,
        hasNotificationUrl: !!NOTIFICATION_URL,
        hasGoogleWebAppUrl: !!GOOGLE_WEB_APP_URL,
        notificationUrl: NOTIFICATION_URL || "(not set)"
      }
    });
  }

  // Consume the RAW request body (needed for signature verification).
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  const signature = req.headers["x-square-hmacsha256-signature"] || "";

  if (!isValidSignature(rawBody, signature)) {
    return res.status(403).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  if (event.type === "payment.completed") {
    // handled below
  } else if (event.type === "payment.updated") {
    const updatedStatus =
      event.data &&
      event.data.object &&
      event.data.object.payment &&
      event.data.object.payment.status;
    if (updatedStatus !== "COMPLETED") {
      return res.status(200).json({ ok: true, ignored: event.type + "/" + updatedStatus });
    }
  } else {
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  const paymentId =
    event.data &&
    event.data.object &&
    event.data.object.payment &&
    event.data.object.payment.id;

  if (!paymentId) {
    return res.status(422).json({ error: "Missing payment id" });
  }

  try {
    const pay = (await fetchSquare("/v2/payments/" + paymentId)).payment || {};

    var orderItems = [];
    var orderRef = paymentId;
    if (pay.order_id) {
      const order = (await fetchSquare("/v2/orders/" + pay.order_id)).order || {};
      if (order) {
        orderRef = order.reference_id || orderRef;
        orderItems = getOrderInfos(order);
      }
    }

    const email = pay.buyer_email_address || "";

    // Labels travel in the payment note as [Label: text], one per line item.
    const note = pay.note || "";
    var noteLabels = parseNoteLabels(note);

    let customerName = "";
    if (pay.customer_id) {
      try {
        const cust = (await fetchSquare("/v2/customers/" + pay.customer_id)).customer || {};
        customerName = [cust.given_name, cust.family_name].filter(Boolean).join(" ");
      } catch (err) {
        // customer lookup is best-effort
      }
    }

    const totalMoney = pay.total_money || {};
    const totalUsd = ((totalMoney.amount || 0) / 100).toFixed(2);

    // Write one row per line item to the sheet.
    var sheetResults = [];
    if (GOOGLE_WEB_APP_URL) {
      for (var i = 0; i < orderItems.length; i++) {
        var item = orderItems[i];
        var labelText = noteLabels[i] || "";

        var payload = {
          ref: orderRef,
          product: item.product,
          scent: item.scent,
          qty: item.qty,
          price: totalUsd,
          label: labelText,
          name: customerName,
          email: email,
          status: "PAID"
        };

        try {
          const gRes = await fetch(GOOGLE_WEB_APP_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const text = await gRes.text();
          try {
            sheetResults.push(JSON.parse(text));
          } catch (err) {
            sheetResults.push({ written: true, raw: text });
          }
        } catch (err) {
          sheetResults.push({ written: false, error: err.toString() });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      ref: orderRef,
      items: orderItems.length,
      email: email,
      status: "PAID",
      sheet: sheetResults
    });
  } catch (error) {
    return res.status(500).json({ error: error.toString() });
  }
};
