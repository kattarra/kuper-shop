const crypto = require("crypto");

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
function esc(value) {
  return String(value || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function config() {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.PARTNER_TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.PARTNER_TELEGRAM_WEBHOOK_SECRET;
  if (!url || !service || !token || !webhookSecret) throw new Error("Partner bot is not configured");
  return { url:url.replace(/\/$/, ""), service, token, webhookSecret };
}
async function db(cfg, path, options={}) {
  const r = await fetch(cfg.url + path, {
    ...options,
    headers: {
      apikey:cfg.service,
      Authorization:"Bearer " + cfg.service,
      "Content-Type":"application/json",
      ...(options.headers || {})
    }
  });
  const t = await r.text();
  let data;
  try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + JSON.stringify(data));
  return data;
}
async function telegram(cfg, method, payload) {
  const r = await fetch("https://api.telegram.org/bot" + cfg.token + "/" + method, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error("Telegram API error");
  return data.result;
}
async function say(cfg, chatId, text, keyboard=true) {
  const reply_markup = keyboard ? {
    keyboard:[
      [{text:"📊 Статистика"},{text:"🔗 Моя ссылка"}],
      [{text:"💸 Запросить выплату"},{text:"❓ Помощь"}]
    ],
    resize_keyboard:true
  } : undefined;
  return telegram(cfg,"sendMessage",{chat_id:chatId,text,parse_mode:"HTML",...(reply_markup?{reply_markup}:{})});
}
async function getPartnerByTelegram(cfg, telegramId) {
  const rows = await db(cfg,"/rest/v1/partners?select=id,display_name,referral_code,status,telegram_username&telegram_id=eq."+encodeURIComponent(telegramId)+"&limit=1");
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function activate(cfg, token, user) {
  if (!/^[a-f0-9]{48}$/i.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  const rows = await db(cfg,
    "/rest/v1/partners?select=id,display_name,referral_code,status,invite_expires_at&invite_token_hash=eq."+tokenHash+"&status=eq.invited&invite_expires_at=gt."+encodeURIComponent(now),
    {method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({
      telegram_id:user.id,
      telegram_username:user.username || null,
      status:"active",
      invite_token_hash:null,
      invite_expires_at:null,
      activated_at:now,
      updated_at:now
    })}
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function dashboard(cfg, partner) {
  const [commissions, customers, links, payouts] = await Promise.all([
    db(cfg,"/rest/v1/referral_commissions?select=commission_amount,status,subtotal&partner_id=eq."+partner.id),
    db(cfg,"/rest/v1/referral_customers?select=id&partner_id=eq."+partner.id),
    db(cfg,"/rest/v1/referral_order_links?select=order_id&partner_id=eq."+partner.id),
    db(cfg,"/rest/v1/partner_payout_requests?select=amount,status&partner_id=eq."+partner.id)
  ]);
  const sums = {available:0,paid:0,pending:0,reversed:0,revenue:0};
  for (const c of commissions) {
    sums[c.status] = (sums[c.status] || 0) + Number(c.commission_amount || 0);
    sums.revenue += Number(c.subtotal || 0);
  }
  const reserved = payouts.filter(p=>p.status==="requested").reduce((n,p)=>n+Number(p.amount||0),0);
  return {
    customers:customers.length,
    orders:links.length,
    revenue:sums.revenue,
    available:Math.max(0,sums.available-reserved),
    reserved,
    paid:sums.paid,
    pending:sums.pending
  };
}
module.exports = async function handler(req,res) {
  if (req.method !== "POST") return send(res,405,{ok:false});
  let cfg;
  try {
    cfg=config();
    const supplied=String(req.headers["x-telegram-bot-api-secret-token"]||"");
    if (supplied.length !== cfg.webhookSecret.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(cfg.webhookSecret))) {
      return send(res,401,{ok:false});
    }
    const update=req.body||{};
    const message=update.message;
    if (!message || !message.chat || !message.from || typeof message.text!=="string") return send(res,200,{ok:true});
    const chatId=message.chat.id;
    const user=message.from;
    const input=message.text.trim();
    const [command,...args]=input.split(/\s+/);
    const cmd=command.toLowerCase().split("@")[0];

    if (cmd==="/start") {
      const invite=args[0]||"";
      if (invite) {
        const partner=await activate(cfg,invite,user);
        if (partner) {
          await say(cfg,chatId,
            "🎉 <b>Вы подключены к KuperShop Partners!</b>\n\nВаш код: <code>"+esc(partner.referral_code)+"</code>\nТеперь можно делиться своей ссылкой и получать 10% с выполненных заказов ваших клиентов.");
          return send(res,200,{ok:true});
        }
      }
      const existing=await getPartnerByTelegram(cfg,user.id);
      if (existing && existing.status==="active") {
        await say(cfg,chatId,"С возвращением, <b>"+esc(existing.display_name)+"</b>!\n\n"+await partnerSummary(cfg,existing));
      } else if (existing && existing.status==="blocked") {
        await say(cfg,chatId,"Доступ к партнёрской программе заблокирован. Свяжитесь с администратором.");
      } else {
        await say(cfg,chatId,"Добро пожаловать в KuperShop Partners!\nДля подключения нужна персональная ссылка-приглашение от администратора. Если она у вас есть, откройте её ещё раз.");
      }
      return send(res,200,{ok:true});
    }

    const partner=await getPartnerByTelegram(cfg,user.id);
    if (!partner || partner.status!=="active") {
      await say(cfg,chatId,"Ваш Telegram ещё не подключён к активному аккаунту партнёра. Для доступа запросите приглашение у администратора.");
      return send(res,200,{ok:true});
    }

    if (cmd==="/link" || input==="🔗 Моя ссылка") {
      const url="https://kuper-shop.vercel.app/?ref="+encodeURIComponent(partner.referral_code);
      await say(cfg,chatId,"🔗 <b>Ваша реферальная ссылка</b>\n\n<code>"+esc(url)+"</code>\n\nКлиент закрепляется за вами по первому заказу с этим номером телефона.");
    } else if (cmd==="/stats" || input==="📊 Статистика") {
      await say(cfg,chatId,"📊 <b>Ваша статистика</b>\n\n"+await partnerSummary(cfg,partner));
    } else if (cmd==="/payout" || input==="💸 Запросить выплату") {
      const result=await db(cfg,"/rest/v1/rpc/request_partner_payout",{method:"POST",body:JSON.stringify({p_partner_id:partner.id})});
      const payout=Array.isArray(result)?result[0]:result;
      if (!payout || !payout.amount) {
        await say(cfg,chatId,"Сейчас нет доступного баланса для выплаты. Новая заявка не создана.");
      } else {
        await say(cfg,chatId,"✅ Заявка на выплату создана.\nСумма: <b>"+Number(payout.amount).toLocaleString("ru-RU")+" ₽</b>\nАдминистратор обработает её вручную.");
      }
    } else {
      await say(cfg,chatId,"Команды:\n/link — ваша ссылка\n/stats — статистика\n/payout — запросить выплату\n/help — помощь");
    }
    return send(res,200,{ok:true});
  } catch(error) {
    console.error("[Partner bot] webhook error:",error.message);
    if (cfg && req.body && req.body.message && req.body.message.chat) {
      try { await say(cfg,req.body.message.chat.id,"Не удалось выполнить запрос. Попробуйте чуть позже или обратитесь к администратору.",false); } catch {}
    }
    return send(res,200,{ok:true});
  }
};
async function partnerSummary(cfg,partner) {
  const s=await dashboard(cfg,partner);
  return "Клиенты: <b>"+s.customers+"</b>\nЗаказы: <b>"+s.orders+"</b>\nОборот: <b>"+s.revenue.toLocaleString("ru-RU")+" ₽</b>\nДоступно: <b>"+s.available.toLocaleString("ru-RU")+" ₽</b>\nНа рассмотрении: <b>"+s.pending.toLocaleString("ru-RU")+" ₽</b>\nВыплачено: <b>"+s.paid.toLocaleString("ru-RU")+" ₽</b>\nЗарезервировано заявками: <b>"+s.reserved.toLocaleString("ru-RU")+" ₽</b>";
}
