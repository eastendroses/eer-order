// ============================================================
//  East End Roses — Vercel proxy: create a Square payment link
//  ------------------------------------------------------------
//  Client order page POSTs here (same origin, no CORS issues).
//  This function asks the Square Checkout API for a FRESH
//  payment link for this specific order. Each order gets:
//    - a unique reference (EER-XXXXXX) stored on the Square order
//    - a line item "Product - Fragrance" with quantity + price
//  When the client pays, Square sends a payment.completed webhook
//  to /api/square-webhook, which logs the PAID order to the sheet.
//
//  Required env vars on Vercel:
//    SQUARE_ACCESS_TOKEN   (production access token, "Production"
//                           environment — NOT the sandbox token)
//    SQUARE_LOCATION_ID    (optional override; auto-detected if blank)
// ============================================================

const crypto = require("crypto");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_API = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-08-19";

// Unit prices in cents (keep in sync with the order page + pricing.md).
const PRICES = {
  "Candle": 2300,
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

  const { product, scent, qty, label } = req.body || {};
  if (!product || !scent) {
    return res.status(400).json({ success: false, error: "Missing product or scent" });
  }

  const unitPriceCents = PRICES[product];
  if (!unitPriceCents) {
    return res.status(400).json({ success: false, error: "Unknown product" });
  }

  const quantity = parseInt(qty, 10) || 1;
  if (quantity < 1) return res.status(400).json({ success: false, error: "Invalid quantity" });

  const ref = "EER-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const baseUrl = "https://" + (req.headers.host || "");

  try {
    // Resolve a location (the merchant's default business location).
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

    let note = product + " - " + scent + " (x" + quantity + ")";
    if (label) note += " | Label: " + String(label);

    // Step 1: create the order with 8% sales tax via the Orders API.
    const orderBody = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: locationId,
        reference_id: ref,
        line_items: [{
          name: product + " - " + scent,
          quantity: String(quantity),
          base_price_money: { amount: unitPriceCents, currency: "USD" }
        }],
        taxes: [{
          uid: "state-sales-tax",
          name: "Sales Tax",
          percentage: "8",
          scope: "ORDER"
        }]
      }
    };

    const orderRes = await fetch(SQUARE_API + "/v2/orders", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SQUARE_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION
      },
      body: JSON.stringify(orderBody)
    });

    const orderJson = await orderRes.json();

    if (!orderRes.ok || !orderJson.order || !orderJson.order.id) {
      return res.status(502).json({
        success: false,
        error: "Square could not create the order",
        detail: orderJson.errors || orderJson
      });
    }

    // Step 2: create the payment link for that order.
    const body = {
      idempotency_key: crypto.randomUUID(),
      order: { order_id: orderJson.order.id },
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
      body: JSON.stringify(body)
    });

    const json = await resp.json();

    if (!resp.ok || !json.payment_link || !json.payment_link.url) {
      return res.status(502).json({
        success: false,
        error: "Square could not create a payment link",
        detail: json.errors || json
      });
    }

    return res.status(200).json({ success: true, url: json.payment_link.url, ref: ref });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.toString() });
  }
};