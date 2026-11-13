async function supabaseRequest(endpoint) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase environment variables");
  const response = await fetch(url.replace(/\/$/, "") + endpoint, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error("Supabase request failed (" + response.status + "): " + JSON.stringify(data));
  return data;
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const products = await supabaseRequest("/rest/v1/products?select=product_key,category,brand,name,price,stock,sort_order&is_active=eq.true&order=sort_order.asc");
    return res.status(200).json({ ok: true, products });
  } catch (error) {
    console.error("Products API failed:", error.message);
    return res.status(500).json({ error: "Не удалось загрузить каталог" });
  }
};
