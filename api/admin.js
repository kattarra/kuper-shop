function send(res,status,body){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(body));}
function config(){const url=process.env.SUPABASE_URL,service=process.env.SUPABASE_SERVICE_ROLE_KEY,anon=process.env.SUPABASE_ANON_KEY;if(!url||!service||!anon)throw new Error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY");return{url:url.replace(/\/$/, ""),service,anon};}
async function request(url,headers,options={}){const r=await fetch(url,{...options,headers:{...headers,...(options.headers||{})}});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}if(!r.ok){const e=new Error("Supabase request failed ("+r.status+")");e.status=r.status;e.details=d;throw e;}return d;}
function serviceHeaders(service){return{apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json"};}
async function verifyAdmin(req,cfg){
 const auth=String(req.headers.authorization||"");
 const match=auth.match(/^Bearer\s+(.+)$/i);if(!match)throw Object.assign(new Error("Требуется вход в админ-панель"),{status:401});
 const token=match[1];
 const user=await request(cfg.url+"/auth/v1/user",{apikey:cfg.anon,Authorization:"Bearer "+token});
 if(!user||!user.id)throw Object.assign(new Error("Сессия недействительна"),{status:401});
 const rows=await request(cfg.url+"/rest/v1/admin_users?select=user_id,role&user_id=eq."+encodeURIComponent(user.id),serviceHeaders(cfg.service));
 if(!Array.isArray(rows)||!rows.length)throw Object.assign(new Error("У этой учётной записи нет прав администратора"),{status:403});
 return{user,role:rows[0].role,token};
}
module.exports=async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"Method not allowed"});
 try{
  const cfg=config(),body=req.body||{},action=String(body.action||"");
  if(action==="login"){
   const email=String(body.email||"").trim(),password=String(body.password||"");
   if(!email||!password||password.length>1024)return send(res,400,{error:"Введите почту и пароль"});
   let session;
   try{session=await request(cfg.url+"/auth/v1/token?grant_type=password",{apikey:cfg.anon,"Content-Type":"application/json"},{method:"POST",body:JSON.stringify({email,password})});}
   catch(e){return send(res,401,{error:"Неверная почта или пароль"});}
   if(!session.access_token||!session.user||!session.user.id)return send(res,401,{error:"Не удалось создать сессию"});
   const admins=await request(cfg.url+"/rest/v1/admin_users?select=user_id,role&user_id=eq."+encodeURIComponent(session.user.id),serviceHeaders(cfg.service));
   if(!Array.isArray(admins)||!admins.length)return send(res,403,{error:"Эта учётная запись не добавлена в администраторы магазина"});
   return send(res,200,{ok:true,access_token:session.access_token,expires_in:session.expires_in,role:admins[0].role});
  }
  const auth=await verifyAdmin(req,cfg);

  if(action==="products"){
   const products=await request(cfg.url+"/rest/v1/products?select=product_key,category,brand,name,price,stock,is_active,sort_order&order=sort_order.asc",serviceHeaders(cfg.service));
   return send(res,200,{ok:true,products});
  }
  if(action==="update_product"){
   const key=String(body.product_key||""),name=String(body.name||"").trim(),category=String(body.category||"").trim(),brand=String(body.brand||"").trim(),price=Number(body.price),stock=Number(body.stock);
   if(!key||!name||!category||name.length>180||category.length>80||brand.length>80||!Number.isInteger(price)||price<0||!Number.isInteger(stock)||stock< -1)return send(res,400,{error:"Проверьте название, категорию, цену и остаток"});
   const updated=await request(cfg.url+"/rest/v1/products?product_key=eq."+encodeURIComponent(key),{...serviceHeaders(cfg.service),Prefer:"return=representation"},{method:"PATCH",body:JSON.stringify({name,category,brand:brand||null,price,stock,updated_at:new Date().toISOString()})});
   if(!Array.isArray(updated)||!updated.length)return send(res,404,{error:"Товар не найден"});
   return send(res,200,{ok:true,product:updated[0]});
  }
  if(action==="create_product"){
   const name=String(body.name||"").trim(),category=String(body.category||"").trim(),brand=String(body.brand||"").trim(),price=Number(body.price),stock=Number(body.stock);
   if(!name||!category||name.length>180||category.length>80||brand.length>80||!Number.isInteger(price)||price<0||!Number.isInteger(stock)||stock<0)return send(res,400,{error:"Проверьте название, категорию, цену и остаток"});
   const product={product_key:"new-"+require("crypto").randomUUID(),category,brand:brand||null,name,price,stock,is_active:true,sort_order:999999};
   const created=await request(cfg.url+"/rest/v1/products",{...serviceHeaders(cfg.service),Prefer:"return=representation"},{method:"POST",body:JSON.stringify(product)});
   return send(res,201,{ok:true,product:Array.isArray(created)?created[0]:created});
  }
  if(action==="set_product_active"){
   const key=String(body.product_key||"");
   if(!key||typeof body.is_active!=="boolean")return send(res,400,{error:"Некорректный товар"});
   const updated=await request(cfg.url+"/rest/v1/products?product_key=eq."+encodeURIComponent(key),{...serviceHeaders(cfg.service),Prefer:"return=representation"},{method:"PATCH",body:JSON.stringify({is_active:body.is_active,updated_at:new Date().toISOString()})});
   if(!Array.isArray(updated)||!updated.length)return send(res,404,{error:"Товар не найден"});
   return send(res,200,{ok:true,product:updated[0]});
  }

  if(action==="upload_product_image"){
   const key=String(body.product_key||""),mime=String(body.mime_type||""),data=String(body.image_base64||"");
   if(!key||!/^image\/(jpeg|png|webp)$/.test(mime)||!data||data.length>2800000)return send(res,400,{error:"Нужен JPG, PNG или WEBP размером до 2 МБ"});
   const bytes=Buffer.from(data,"base64");
   if(!bytes.length||bytes.length>2*1024*1024)return send(res,400,{error:"Изображение должно быть не больше 2 МБ"});
   const ext=mime==="image/jpeg"?"jpg":mime.split("/")[1],path=encodeURIComponent(key)+"/"+Date.now()+"."+ext;
   const upload=await fetch(cfg.url+"/storage/v1/object/product-images/"+path,{method:"POST",headers:{apikey:cfg.service,Authorization:"Bearer "+cfg.service,"Content-Type":mime,"x-upsert":"true"},body:bytes});
   if(!upload.ok){const detail=await upload.text();console.error("Image upload failed:",upload.status,detail);return send(res,502,{error:"Не удалось загрузить изображение в Storage. Проверьте bucket product-images"});}
   const imagePath=decodeURIComponent(path);
   await request(cfg.url+"/rest/v1/product_images?on_conflict=product_key",{...serviceHeaders(cfg.service),Prefer:"resolution=merge-duplicates,return=minimal"},{method:"POST",body:JSON.stringify({product_key:key,image_path:imagePath,updated_at:new Date().toISOString()})});
   return send(res,200,{ok:true,image_url:cfg.url+"/storage/v1/object/public/product-images/"+imagePath});
  }
  if(action==="orders"){
   const orders=await request(cfg.url+"/rest/v1/orders?select=id,order_number,customer_name,phone,address,comment,subtotal,delivery_fee,total,status,created_at,order_items(id,product_name,quantity,unit_price)&order=created_at.desc&limit=100",serviceHeaders(cfg.service));
   return send(res,200,{ok:true,orders});
  }
  if(action==="update_status"){
   const id=String(body.order_id||""),status=String(body.status||"");
   if(!/^[0-9a-f-]{36}$/i.test(id)||!["new","processing","completed","cancelled"].includes(status))return send(res,400,{error:"Некорректный заказ или статус"});
   const updated=await request(cfg.url+"/rest/v1/orders?id=eq."+encodeURIComponent(id),{...serviceHeaders(cfg.service),Prefer:"return=representation"},{method:"PATCH",body:JSON.stringify({status,updated_at:new Date().toISOString()})});
   if(!Array.isArray(updated)||!updated.length)return send(res,404,{error:"Заказ не найден"});
   return send(res,200,{ok:true,order:updated[0]});
  }
  return send(res,400,{error:"Неизвестное действие"});
 }catch(error){
  console.error("Admin API error:",error.status||500,error.message,error.details||"");
  return send(res,error.status||500,{error:error.status?error.message:"Не удалось выполнить запрос админ-панели"});
 }
};
