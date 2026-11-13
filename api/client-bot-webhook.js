function send(res,status,body){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(body));}
function config(){
 const token=process.env.TELEGRAM_BOT_TOKEN;
 const secret=process.env.CLIENT_TELEGRAM_WEBHOOK_SECRET;
 if(!token||!secret)throw new Error("Client Telegram bot is not configured");
 return {token,secret};
}
async function telegram(cfg,method,payload){
 const r=await fetch("https://api.telegram.org/bot"+cfg.token+"/"+method,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok||!data.ok)throw new Error("Telegram API error");
 return data.result;
}
module.exports=async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"Method not allowed"});
 let cfg;
 try{cfg=config();}catch(e){return send(res,500,{error:e.message});}
 if(String(req.headers["x-telegram-bot-api-secret-token"]||"")!==cfg.secret)return send(res,401,{error:"Unauthorized"});
 const update=req.body||{};
 const message=update.message;
 if(!message||!message.chat||message.chat.type!=="private")return send(res,200,{ok:true});
 const chatId=message.chat.id;
 const text=String(message.text||"").trim();
 const keyboard={
  keyboard:[
   [{text:"🛍 Открыть магазин",web_app:{url:"https://kuper-shop.vercel.app/"}}],
   [{text:"🛒 Как оформить заказ?"},{text:"❓ Помощь"}]
  ],
  resize_keyboard:true,
  is_persistent:true
 };
 let reply="";
 if(/^\/start(?:@\w+)?(?:\s|$)/i.test(text)){
  reply="Добро пожаловать в KuperShop! 👋\n\nКаталог и оформление заказа находятся внутри нашего магазина. Нажмите кнопку «🛍 Открыть магазин» ниже — и можно выбирать товары.";
 }else if(/^\/help(?:@\w+)?$/i.test(text)||text==="❓ Помощь"){
  reply="Нужна помощь с заказом? Напишите нам в ответ на это сообщение — мы подскажем.\n\nЧтобы перейти в каталог, нажмите «🛍 Открыть магазин».";
 }else if(text==="🛒 Как оформить заказ?"){
  reply="Откройте магазин кнопкой ниже, добавьте товары в корзину и заполните контактные данные для оформления заказа.";
 }else{
  reply="Я помогу перейти в магазин и разобраться с оформлением заказа. Нажмите «🛍 Открыть магазин» или выберите «❓ Помощь».";
 }
 try{
  await telegram(cfg,"sendMessage",{chat_id:chatId,text:reply,reply_markup:keyboard});
  return send(res,200,{ok:true});
 }catch(error){
  console.error("Client bot webhook error:",error.message);
  return send(res,500,{error:"Telegram message failed"});
 }
};
