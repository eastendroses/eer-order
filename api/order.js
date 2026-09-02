const crypto = require("crypto");

// Environment variables — set these on Vercel under Settings → Environment Variables.
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_API = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-08-19";

// Unit prices in cents (keep in sync with the order page + pricing.md).
const PRICES = {
  "Candle": 2300,
  "Signature Fragrance Candle": 3200,
  "Diffuser": 1700,
  "Wax Melts": 870,
  "Room Spray": 1200,
  "Tulip Bouquet": 2500
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ success: false, error: "SQUARE_ACCESS_TOKEN not configured" });
  }

  // Accept both legacy single-item format and new multi-item format.
  var body = req.body || {};
  var items = [];
  if (body.items && Array.isArray(body.items) && body.items.length > 0) {
    items = body.items;
  } else if (body.product && body.scent) {
    items = [{ product: body.product, scent: body.scent, qty: body.qty || 1, label: body.label }];
  }

  if (items.length === 0) {
    return res.status(400).json({ success: false, error: "No products provided" });
  }

  // Validate each item and build line items.
  var lineItems = [];
  var noteParts = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var product = item.product;
    var scent = item.scent;
    var qty = parseInt(item.qty, 10) || 1;
    var label = item.label || "";

    if (!product || !scent) {
      return res.status(400).json({ success: false, error: "Missing product or scent in item " + (i + 1) });
    }
    var unitPriceCents = PRICES[product];
    if (!unitPriceCents) {
      return res.status(400).json({ success: false, error: "Unknown product: " + product });
    }
    if (qty < 1) return res.status(400).json({ success: false, error: "Invalid quantity for " + product });

    lineItems.push({
      name: product + " - " + scent,
      quantity: String(qty),
      base_price_money: { amount: unitPriceCents, currency: "USD" }
    });

    var part = product + " - " + scent + " (x" + qty + ")";
    if (label) part += " [Label: " + label + "]";
    noteParts.push(part);
  }

  var ref = "EER-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  var baseUrl = "https://" + (req.headers.host || "");

  try {
    let locationId = SQUARE_LOCATION_ID;
    if (!locationId) {
      const locRes = await fetch(SQUARE_API + "/v2/locations", {
        headers: {
          Authorization: "Bearer " + SQUARE_ACCESS_TOKEN,
          "Square-Version": SQUARE_VERSION
        }
      });
      const locJson = await locRes.json();
      if (locJson && locJson.locations && locJson.locations.length > 0) {
        locationId = locJson.locations[0].id;
      }
    }
    if (!locationId) {
      return res.status(500).json({ success: false, error: "No Square location found" });
    }

    var note = noteParts.join("; ");

    const orderBody = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: locationId,
        reference_id: ref,
        line_items: lineItems,
        taxes: [{
          uid: "state-sales-tax",
          name: "Sales Tax",
          percentage: "8",
          scope: "ORDER"
        }]
      },
      payment_note: note,
      checkout_options: {
        redirect_url: baseUrl + "/?ref=" + ref
      }
    };

    const resp = await fetch(SQUARE_API + "/v2/online-checkout/payment-links", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SQUARE_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION
      },
      body: JSON.stringify(orderBody)
    });

    const json = await resp.json();

    if (!resp.ok || !json.payment_link || !json.payment_link.url) {
      const detail = json.errors && json.errors.length
        ? " [" + json.errors.map(function (e) { return e.code; }).join(", ") + "]"
        : "";
      return res.status(502).json({
        success: false,
        error: "Square could not create a payment link" + detail
      });
    }

    return res.status(200).json({ success: true, url: json.payment_link.url, ref: ref });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.toString() });
  }
};
