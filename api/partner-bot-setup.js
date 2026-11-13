function send(res,status,body){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(body));}
module.exports=async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"Method not allowed"});
 const setupSecret=process.env.PARTNER_BOT_SETUP_SECRET,token=process.env.PARTNER_TELEGRAM_BOT_TOKEN,webhookSecret=process.env.PARTNER_TELEGRAM_WEBHOOK_SECRET;
 if(!setupSecret||!token||!webhookSecret)return send(res,500,{error:"Partner bot setup environment variables are missing"});
 const auth=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 if(auth.length!==setupSecret.length||auth!==setupSecret)return send(res,401,{error:"Unauthorized"});
 const host=process.env.VERCEL_PROJECT_PRODUCTION_URL||"kuper-shop.vercel.app";
 const url="https://"+host+"/api/partner-bot-webhook";
 const r=await fetch("https://api.telegram.org/bot"+token+"/setWebhook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url,secret_token:webhookSecret,allowed_updates:["message"],drop_pending_updates:false})});
 const data=await r.json().catch(()=>({}));
 if(!r.ok||!data.ok)return send(res,502,{error:"Telegram setWebhook failed",description:data.description||"Unknown error"});
 return send(res,200,{ok:true,webhook_url:url,telegram:data.result});
};