function send(res,status,body){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(body));}
module.exports=async function handler(req,res){
 if(req.method!=="GET")return send(res,405,{error:"Method not allowed"});
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)return send(res,500,{error:"Server is not configured"});
 try{
  const response=await fetch(url.replace(/\/$/,"")+"/rest/v1/shop_promotions?select=id,text,image_url,sort_order&is_active=eq.true&order=sort_order.asc,created_at.asc",{headers:{apikey:key,Authorization:"Bearer "+key}});
  const data=await response.json().catch(()=>[]);
  if(!response.ok)throw new Error("Could not load promotions");
  return send(res,200,{ok:true,promotions:Array.isArray(data)?data:[]});
 }catch(error){console.error("Promotions API:",error.message);return send(res,500,{error:"Не удалось загрузить акции"});}
};
