function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}
async function supabaseRequest(endpoint, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase environment variables");
  const response = await fetch(url.replace(/\/$/, "") + endpoint, {
    ...options,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error("Supabase request failed (" + response.status + "): " + JSON.stringify(data));
  return data;
}
async function notifyPartners(order, items) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_PARTNER_CHAT_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!token || !chatIds.length) return { configured: false };
  const lines = items.map(x => "• " + escapeHtml(x.product_name) + " × " + x.quantity + " — " + (x.unit_price * x.quantity) + " ₽");
  const message = [
    "<b>Новый заказ KS-" + order.order_number + "</b>",
    "",
    ...lines,
    "",
    "<b>Товары:</b> " + order.subtotal + " ₽",
    "<b>Доставка:</b> " + order.delivery_fee + " ₽",
    "<b>Итого:</b> " + order.total + " ₽",
    "",
    "<b>Клиент:</b> " + escapeHtml(order.customer_name),
    "<b>Телефон:</b> " + escapeHtml(order.phone),
    "<b>Адрес:</b> " + escapeHtml(order.address)
  ].join("\n");
  const results = await Promise.all(chatIds.map(async chat_id => {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text: message, parse_mode: "HTML" })
    });
    return r.ok;
  }));
  return { configured: true, sent: results.filter(Boolean).length, total: results.length };
}

async function attachReferralToOrder(order, phone, referralCode) {
  const secret = process.env.REFERRAL_HASH_SECRET;
  if (!secret) {
    console.warn("[Referral] REFERRAL_HASH_SECRET is not configured; attribution skipped");
    return { linked: false, reason: "not_configured" };
  }
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { linked: false, reason: "invalid_phone" };

  const crypto = require("crypto");
  const phoneHash = crypto.createHmac("sha256", secret).update(digits).digest("hex");
  let partnerId = null;
  const code = String(referralCode || "").trim().toUpperCase();

  if (code && /^[A-Z0-9_-]{3,32}$/.test(code)) {
    const partners = await supabaseRequest(
      "/rest/v1/partners?select=id&referral_code=eq." + encodeURIComponent(code) + "&status=eq.active&limit=1"
    );
    if (Array.isArray(partners) && partners.length) partnerId = partners[0].id;
  }

  const claimed = await supabaseRequest("/rest/v1/rpc/claim_referral_customer", {
    method: "POST",
    body: JSON.stringify({ p_phone_hash: phoneHash, p_partner_id: partnerId })
  });
  const assignedPartnerId = typeof claimed === "string" ? claimed : null;
  if (!assignedPartnerId) return { linked: false, reason: "no_partner" };

  await supabaseRequest("/rest/v1/referral_order_links", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      order_id: order.id,
      partner_id: assignedPartnerId,
      phone_hash: phoneHash
    })
  });
  return { linked: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  let stage = "request_validation";
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim();
    const address = String(body.address || "").trim();
    const comment = String(body.comment || "").trim();
    if (!name || name.length > 120 || !phone || phone.length > 40 || !address || address.length > 500) {
      return send(res, 400, { error: "Проверьте имя, телефон и адрес" });
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
      return send(res, 400, { error: "Корзина пуста или содержит слишком много позиций" });
    }
    stage = "load_catalog";
    const catalogRows = await supabaseRequest("/rest/v1/products?select=product_key,category,brand,name,price,stock,is_active,sort_order&is_active=eq.true&order=sort_order.asc");
    const catalog = new Map(catalogRows.map(product => [String(product.product_key), product]));
    const seen = new Set();
    const items = [];
    for (const item of body.items) {
      const key = String(item.product_key);
      const product = catalog.get(key);
      const quantity = Number(item.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || product.stock < 0 || quantity > product.stock || seen.has(key)) {
        return send(res, 400, { error: "Некорректный товар или количество" });
      }
      seen.add(key);
      items.push({ product_key: key, product_name: product.name, quantity, unit_price: product.price });
    }
    const subtotal = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
    const delivery_fee = body.delivery === false ? 0 : 150;
    const total = subtotal + delivery_fee;
    stage = "insert_order";
    const created = await supabaseRequest("/rest/v1/orders", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        customer_name: name, phone, address, comment,
        subtotal, delivery_fee, total, status: "new"
      }])
    });
    const order = Array.isArray(created) ? created[0] : null;
    if (!order || !order.id) throw new Error("Supabase did not return the created order");
    stage = "insert_order_items";
    const itemRows = items.map(item => ({ ...item, order_id: order.id }));
    await supabaseRequest("/rest/v1/order_items", {
      method: "POST",
      body: JSON.stringify(itemRows)
    });
    stage = "referral_attribution";
    let referral = { linked: false, reason: "not_attempted" };
    try {
      referral = await attachReferralToOrder(order, phone, body.referral_code);
    } catch (e) {
      console.error("[Referral] Attribution failed for order " + order.id + ":", e.message);
      referral = { linked: false, reason: "error" };
    }
    stage = "telegram_notification";
    let telegram = { configured: false };
    try { telegram = await notifyPartners(order, items); } catch (e) { console.error("Telegram notification failed:", e.message); }
    stage = "complete";
    return send(res, 201, {
      ok: true,
      order_number: order.order_number,
      subtotal, delivery_fee, total,
      referral_attributed: referral.linked,
      telegram_notification_configured: telegram.configured,
      telegram_notifications_sent: telegram.sent || 0
    });
  } catch (error) {
    console.error("Order creation failed at stage " + stage + ":", error.message);
    return send(res, 500, { error: "Не удалось сохранить заказ.", stage, diagnostic: String(error.message || "Unknown error").slice(0, 500) });
  }
};
