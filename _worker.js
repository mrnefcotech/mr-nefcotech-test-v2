
// MR. NEFCOTECH'S — serveur des comptes
// Cloudflare Pages + D1 (liaison nommée DB)
// Variables Cloudflare : BREVO_KEY, MAIL_FROM

const enc=new TextEncoder(),
b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))),
unb=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));

const ROLES=["client","vendeur","formateur","entreprise"],
DAYS=7,
TERMS="2026-10";

const PAYS=["Cameroun","Gabon","Congo","RD Congo","Tchad","Centrafrique","Guinée équatoriale","Nigeria","Ghana","Bénin","Togo","Sénégal","Côte d'Ivoire","Mali","Burkina Faso","Niger","Guinée","Maroc","Algérie","Tunisie","Afrique du Sud","France","Belgique","Suisse","Allemagne","Italie","Espagne","Royaume-Uni","Canada","États-Unis","Chine","Autre pays"];

const RESERVED=["admin","administrateur","root","support","nefcotech","nefcotechs","moderateur","system","api","null"];

const json=(o,s=200,h={})=>new Response(JSON.stringify({api:true,...o}),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...h}});

async function hash(pw,salt){
const k=await crypto.subtle.importKey("raw",enc.encode(pw),"PBKDF2",false,["deriveBits"]);
return b64(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:100000},k,256));
}

const sha=async t=>b64(await crypto.subtle.digest("SHA-256",enc.encode(t)));

const cookie=(v,age)=>`sid=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

const sid=req=>(req.headers.get("Cookie")||"").match(/(?:^|; )sid=([\w-]+)/)?.[1];

const PUB="id,name,username,email,phone,country,city,role";

const AI_MODELS=["@cf/meta/llama-3.1-8b-instruct-fp8-fast","@cf/meta/llama-3.2-3b-instruct","@cf/meta/llama-3.1-8b-instruct"];
let aiOk=null;

const SYS="Tu es l'assistant IA de MR. NEFCOTECH'S (ETS GROUPE NEFCOTECH'S), une entreprise de services numériques au Cameroun. Réponds en français clair et simple, avec un ton chaleureux, sauf si l'utilisateur écrit dans une autre langue. Tu peux répondre à toutes sortes de questions : business, études, technologie, rédaction, conseils pratiques, culture générale. Sois honnête : si tu n'es pas sûr, dis-le, et n'invente ni faits, ni chiffres, ni liens, ni sources. Pour la santé, le droit et la finance, donne des informations générales et conseille de consulter un professionnel. Refuse poliment tout contenu dangereux, illégal, haineux ou sexuel. Services et prix de départ de MR. NEFCOTECH'S : logos dès 2 500 FCFA ; CV et lettres dès 2 000 FCFA ; configuration WhatsApp Business dès 6 000 FCFA ; montage vidéo dès 3 000 FCFA ; catalogues numériques dès 7 000 FCFA ; gestion des réseaux sociaux dès 20 000 FCFA/mois ; saisie et mise en page dès 1 500 FCFA ; assistants IA dès 7 000 FCFA ; sites web, applications, spots publicitaires et formations sur devis. Pour commander ou demander un devis, invite l'utilisateur à utiliser les boutons WhatsApp du site (+237 678 63 12 31). Tu ne peux pas passer de commande ni effectuer de paiement. Donne des réponses courtes et utiles.";

const mailOn=env=>!!((env.BREVO_KEY&&env.MAIL_FROM)||(env.MAIL_HOOK&&env.MAIL_SECRET));

// ENVOI BREVO AVEC JOURNAUX D'ERREURS
async function sendMail(env,to,subject,text){
try{
if(env.BREVO_KEY&&env.MAIL_FROM){
const r=await fetch("https://api.brevo.com/v3/smtp/email",{
method:"POST",
headers:{
"api-key":env.BREVO_KEY,
"Content-Type":"application/json",
"accept":"application/json"
},
body:JSON.stringify({
sender:{name:"MR. NEFCOTECH'S",email:env.MAIL_FROM},
to:[{email:to}],
subject,
textContent:text
})
});

if(!r.ok){
const detail=await r.text();
console.error("BREVO ERROR:",r.status,detail.slice(0,1000));
return false;
}
return true;
}

if(env.MAIL_HOOK&&env.MAIL_SECRET){
const r=await fetch(env.MAIL_HOOK,{
method:"POST",
headers:{"Content-Type":"text/plain"},
body:JSON.stringify({secret:env.MAIL_SECRET,to,subject,text})
});
if(!r.ok)console.error("MAIL HOOK ERROR:",r.status);
return r.ok;
}
console.error("MAIL ERROR: configuration missing");
}catch(e){
console.error("MAIL ERROR:",String(e));
}
return false;
}

async function sendCode(env,db,uid,email,force,reset){
const old=await db.prepare("SELECT sent FROM email_codes WHERE user_id=?1").bind(uid).first();
if(!force&&old&&Date.now()-old.sent<60000)return true;

const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");

await db.prepare("INSERT OR REPLACE INTO email_codes(user_id,code_hash,expires,tries,sent) VALUES(?1,?2,?3,0,?4)").bind(uid,await sha(code+":"+uid),Date.now()+9e5,Date.now()).run();

return await sendMail(env,email,reset?"MR. NEFCOTECH'S — Code de réinitialisation du mot de passe":"MR. NEFCOTECH'S — Votre code de vérification",reset?"Bonjour,\n\nVotre code pour réinitialiser votre mot de passe est : "+code+"\nIl est valable 15 minutes.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.":"Bonjour,\n\nVotre code de vérification est : "+code+"\nIl est valable 15 minutes.\n\nSi vous n'êtes pas à l'origine de cette inscription, ignorez ce message.");
}

async function checkCode(db,email,code){
const u=await db.prepare("SELECT id FROM users WHERE email=?1").bind(email).first(),
c=u&&await db.prepare("SELECT * FROM email_codes WHERE user_id=?1").bind(u.id).first();

if(!c||c.expires<Date.now())return{err:"Code expiré. Demandez un nouveau code.",s:400};
if(c.tries>=5)return{err:"Trop d'essais. Demandez un nouveau code.",s:429};

if(c.code_hash!==await sha(code+":"+u.id)){
await db.prepare("UPDATE email_codes SET tries=tries+1 WHERE user_id=?1").bind(u.id).run();
return{err:"Code incorrect.",s:400};
}
return{uid:u.id};
}

let migrated=false;

async function migrate(db){
if(migrated)return;
migrated=true;

for(const q of[
"CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,email TEXT NOT NULL UNIQUE,phone TEXT NOT NULL,country TEXT NOT NULL,city TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'client',salt TEXT NOT NULL,hash TEXT NOT NULL,terms_version TEXT NOT NULL,terms_at TEXT NOT NULL,created TEXT NOT NULL)",
"CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS resets(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS throttle(k TEXT PRIMARY KEY,n INTEGER NOT NULL,t INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS unverified(user_id INTEGER PRIMARY KEY,created TEXT NOT NULL)",
"CREATE TABLE IF NOT EXISTS reset_codes(user_id INTEGER PRIMARY KEY,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,tries INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS affiliates(user_id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'pending',commission REAL,created TEXT NOT NULL)",
"CREATE TABLE IF NOT EXISTS referrals(user_id INTEGER PRIMARY KEY,code TEXT NOT NULL)",
"CREATE TABLE IF NOT EXISTS email_codes(user_id INTEGER PRIMARY KEY,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,tries INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS ai_chats(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)",
"CREATE TABLE IF NOT EXISTS ai_msgs(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created TEXT NOT NULL)",
"CREATE INDEX IF NOT EXISTS i_chats ON ai_chats(user_id,updated)",
"CREATE INDEX IF NOT EXISTS i_msgs ON ai_msgs(chat_id,id)"
])try{await db.prepare(q).run()}catch{}
}

async function notify(env,text){
if(!env.CB_PHONE||!env.CB_KEY)return;
try{
await Promise.race([
fetch("https://api.callmebot.com/whatsapp.php?phone="+encodeURIComponent(env.CB_PHONE)+"&text="+encodeURIComponent(text)+"&apikey="+encodeURIComponent(env.CB_KEY)),
new Promise(r=>setTimeout(r,2500))
]);
}catch{}
}

async function sessionUser(req,db){
const t=sid(req);
if(!t)return null;
return await db.prepare("SELECT u.id,u.name,u.username,u.email,u.phone,u.country,u.city,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires>?2").bind(await sha(t),Date.now()).first();
}

async function startSession(db,uid){
const t=crypto.randomUUID()+crypto.randomUUID();
await db.prepare("DELETE FROM sessions WHERE expires<?1").bind(Date.now()).run();
await db.prepare("INSERT INTO sessions VALUES(?1,?2,?3)").bind(await sha(t),uid,Date.now()+DAYS*864e5).run();
return cookie(t,DAYS*86400);
}

async function limited(db,key,max=10,win=9e5){
const now=Date.now(),r=await db.prepare("SELECT n,t FROM throttle WHERE k=?1").bind(key).first();
if(!r||now-r.t>win){
await db.prepare("INSERT OR REPLACE INTO throttle VALUES(?1,1,?2)").bind(key,now).run();
return false;
}
if(r.n>=max)return true;
await db.prepare("UPDATE throttle SET n=n+1 WHERE k=?1").bind(key).run();
return false;
}

function pwErr(p,p2){
if(p.length<10||p.length>100||!/[A-Za-z]/.test(p)||!/\d/.test(p))return"Le mot de passe doit avoir 10 à 100 caractères, avec au moins une lettre et un chiffre.";
if(p!==p2)return"Les deux mots de passe ne correspondent pas.";
}

function validate(b){
const e={},s=k=>String(b[k]??"").trim();
const v={
name:s("name"),
username:s("username").toLowerCase(),
email:s("email").toLowerCase(),
phone:s("phone").replace(/[\s.\-()]/g,""),
country:s("country"),
city:s("city"),
role:s("role")
};
const pw=String(b.password??""),pw2=String(b.password2??"");

if(!/^\p{L}[\p{L}\p{M} '’.-]{1,79}$/u.test(v.name)||!v.name.includes(" "))e.name="Indiquez votre prénom et votre nom (lettres uniquement).";
if(!/^[a-z0-9_]{3,20}$/.test(v.username))e.username="3 à 20 caractères : lettres minuscules, chiffres ou _.";
else if(RESERVED.includes(v.username))e.username="Ce nom d'utilisateur n'est pas disponible.";
if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)||v.email.length>120)e.email="Adresse e-mail invalide. Exemple : nom@exemple.com.";
if(!/^\+[1-9]\d{7,14}$/.test(v.phone))e.phone="Numéro invalide. Format international : +237 6XX XX XX XX.";
else if(v.phone.startsWith("+237")&&!/^\+237[26]\d{8}$/.test(v.phone))e.phone="Numéro camerounais invalide : +237 suivi de 9 chiffres commençant par 6 ou 2.";
if(!PAYS.includes(v.country))e.country="Choisissez votre pays de résidence.";
if(!/^[\p{L}\p{M}][\p{L}\p{M} '’.-]{1,59}$/u.test(v.city))e.city="Indiquez votre ville de résidence.";
if(!ROLES.includes(v.role))e.role="Choisissez un type de compte.";

const pe=pwErr(pw,pw2);
if(pe)e[pe.startsWith("Les deux")?"password2":"password"]=pe;
else if(pw.toLowerCase().includes(v.username)&&v.username.length>=3)e.password="Le mot de passe ne doit pas contenir votre nom d'utilisateur.";
if(b.terms!==true)e.terms="Vous devez accepter les conditions d'utilisation et la politique de confidentialité.";
return{e,v,pw};
}

async function handle(req,env,path){
const db=env.DB;
if(!db)return json({error:"Base de données non liée."},503);

if(path==="health"){
const out={api:true,db:"ok",mail_configure:mailOn(env),ia_configuree:!!env.AI,tables:{}};
for(const t of["users","sessions","resets","throttle","unverified","email_codes","reset_codes","ai_chats","ai_msgs","affiliates","referrals"]){
try{await db.prepare("SELECT 1 FROM "+t+" LIMIT 1").first();out.tables[t]="ok";}
catch{out.tables[t]="MANQUANTE";}
}
try{
const t0=Date.now();
await hash("test",new Uint8Array(16));
out.mot_de_passe="ok ("+(Date.now()-t0)+" ms)";
}catch(e){out.mot_de_passe="ERREUR : "+String(e&&e.message||e).slice(0,120);}
return json(out);
}

await migrate(db);

const url=new URL(req.url),post=req.method==="POST";

if(post){
const o=req.headers.get("Origin");
if(o&&o!==url.origin)return json({error:"Origine refusée."},403);
if(["register","login","reset-request","reset-confirm","verify-email","resend-code"].includes(path)&&await limited(db,path+":"+(req.headers.get("CF-Connecting-IP")||"x")))return json({error:"Trop de tentatives. Réessayez dans 15 minutes."},429);
}

let b={};
if(post){try{b=await req.json();}catch{return json({error:"Requête invalide."},400);}}

if(path==="me")return json({user:await sessionUser(req,db)});

if(path==="check-username"){
const u=(url.searchParams.get("u")||"").toLowerCase();
if(!/^[a-z0-9_]{3,20}$/.test(u)||RESERVED.includes(u))return json({available:false});
return json({available:!(await db.prepare("SELECT 1 FROM users WHERE username=?1").bind(u).first())});
}

if(path==="register"&&post){
const{e,v,pw}=validate(b);

await db.prepare("DELETE FROM users WHERE id IN (SELECT user_id FROM unverified WHERE created<?1)").bind(new Date(Date.now()-864e5).toISOString()).run();
await db.prepare("DELETE FROM unverified WHERE user_id NOT IN (SELECT id FROM users)").run();

if(!e.email)await db.prepare("DELETE FROM users WHERE email=?1 AND id IN (SELECT user_id FROM unverified)").bind(v.email).run();

if(!e.username&&await db.prepare("SELECT 1 FROM users WHERE username=?1").bind(v.username).first())e.username="Ce nom d'utilisateur est déjà utilisé. Choisissez-en un autre.";
if(!e.email&&await db.prepare("SELECT 1 FROM users WHERE email=?1").bind(v.email).first())e.email="Cette adresse e-mail ne peut pas être utilisée pour créer un compte.";

if(Object.keys(e).length)return json({error:"Corrigez les champs signalés.",errors:e},400);
if(!mailOn(env))return json({error:"La vérification par e-mail n'est pas encore activée sur ce site. Contactez-nous sur WhatsApp : +237 678 63 12 31."},503);

const salt=crypto.getRandomValues(new Uint8Array(16)),now=new Date().toISOString();
let id;

try{
const r=await db.prepare("INSERT INTO users(name,username,email,phone,country,city,role,salt,hash,terms_version,terms_at,created) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)").bind(v.name,v.username,v.email,v.phone,v.country,v.city,v.role,b64(salt),await hash(pw,salt),TERMS,now).run();
id=r.meta.last_row_id;
}catch{
return json({error:"Corrigez les champs signalés.",errors:{username:"Ce nom d'utilisateur ou cette adresse e-mail est déjà utilisé."}},409);
}

await db.prepare("INSERT OR REPLACE INTO unverified(user_id,created) VALUES(?1,?2)").bind(id,now).run();

const rc=String(b.ref||"").toUpperCase().replace(/[^A-Z0-9-]/g,"").slice(0,16);
if(rc){
try{
const a=await db.prepare("SELECT code FROM affiliates WHERE code=?1 AND status='approved'").bind(rc).first();
if(a)await db.prepare("INSERT OR REPLACE INTO referrals(user_id,code) VALUES(?1,?2)").bind(id,a.code).run();
}catch{}
}

if(!await sendCode(env,db,id,v.email,true)){
await db.prepare("DELETE FROM users WHERE id=?1").bind(id).run();
return json({error:"Impossible d'envoyer le code. Vérifiez votre adresse e-mail et réessayez."},502);
}

return json({ok:true,needVerify:true,email:v.email});
}

if(path==="verify-email"&&post){
const c=await checkCode(db,String(b.email||"").trim().toLowerCase(),String(b.code||"").trim());
if(c.err)return json({error:c.err},c.s);
await db.prepare("DELETE FROM unverified WHERE user_id=?1").bind(c.uid).run();
await db.prepare("DELETE FROM email_codes WHERE user_id=?1").bind(c.uid).run();
return json({ok:true,user:await db.prepare("SELECT "+PUB+" FROM users WHERE id=?1").bind(c.uid).first()},200,{"Set-Cookie":await startSession(db,c.uid)});
}

if(path==="resend-code"&&post){
const email=String(b.email||"").trim().toLowerCase(),
u=await db.prepare("SELECT id FROM users WHERE email=?1 AND id IN (SELECT user_id FROM unverified)").bind(email).first();

if(u){
const c=await db.prepare("SELECT sent FROM email_codes WHERE user_id=?1").bind(u.id).first();
if(c&&Date.now()-c.sent<60000)return json({error:"Patientez une minute avant de demander un nouveau code."},429);
if(mailOn(env))await sendCode(env,db,u.id,email,true);
}
return json({message:"Si ce compte attend une vérification, un nouveau code vient d'être envoyé."});
}

if(path==="login"&&post){
const id=String(b.identifier||"").trim().toLowerCase().slice(0,120),
pw=String(b.password||"").slice(0,100);
const u=await db.prepare("SELECT * FROM users WHERE email=?1 OR username=?1").bind(id).first();
const h=await hash(pw,u?unb(u.salt):new Uint8Array(16));
if(!u||h!==u.hash)return json({error:"Identifiant ou mot de passe incorrect."},401);

if(await db.prepare("SELECT 1 FROM unverified WHERE user_id=?1").bind(u.id).first()){
if(mailOn(env))await sendCode(env,db,u.id,u.email,false);
return json({error:"Adresse e-mail non vérifiée. Entrez le code envoyé par e-mail.",needVerify:true,email:u.email},403);
}
return json({ok:true},200,{"Set-Cookie":await startSession(db,u.id)});
}

if(path==="logout"&&post){
const t=sid(req);
if(t)await db.prepare("DELETE FROM sessions WHERE token_hash=?1").bind(await sha(t)).run();
return json({ok:true},200,{"Set-Cookie":cookie("",0)});
}

if(path==="reset-request"&&post){
if(!mailOn(env))return json({error:"La récupération par e-mail n'est pas encore activée sur ce site. Contactez-nous sur WhatsApp : +237 678 63 12 31."},501);

const email=String(b.email||"").trim().toLowerCase(),
u=await db.prepare("SELECT id,username FROM users WHERE email=?1").bind(email).first();

if(u){
const old=await db.prepare("SELECT sent FROM reset_codes WHERE user_id=?1").bind(u.id).first();
if(!(old&&Date.now()-old.sent<60000)){
const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
await db.prepare("INSERT OR REPLACE INTO reset_codes(user_id,code_hash,expires,tries,sent) VALUES(?1,?2,?3,0,?4)").bind(u.id,await sha(code+":r:"+u.id),Date.now()+9e5,Date.now()).run();
await sendMail(env,email,"MR. NEFCOTECH'S — Code de réinitialisation du mot de passe","Bonjour,\n\nVotre code pour choisir un nouveau mot de passe est : "+code+"\nIl est valable 15 minutes.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message et ne communiquez ce code à personne.");
await notify(env,"🔔 Demande de réinitialisation du mot de passe : @"+u.username);
}
}
return json({message:"Si cette adresse correspond à un compte, un code vient d'être envoyé par e-mail. Il est valable 15 minutes."});
}

if(path==="reset-confirm"&&post){
const p=String(b.password||""),pe=pwErr(p,String(b.password2||""));
if(pe)return json({error:pe},400);

let uid=null;

if(b.token){
const t=String(b.token);
if(/^[\w-]{20,100}$/.test(t)){
const r=await db.prepare("SELECT user_id FROM resets WHERE token_hash=?1 AND expires>?2").bind(await sha(t),Date.now()).first();
uid=r?.user_id||null;
}
if(!uid)return json({error:"Lien invalide ou expiré. Refaites une demande."},400);
}else{
const email=String(b.email||"").trim().toLowerCase(),
code=String(b.code||"").trim(),
u=await db.prepare("SELECT id FROM users WHERE email=?1").bind(email).first(),
c=u&&await db.prepare("SELECT * FROM reset_codes WHERE user_id=?1").bind(u.id).first();

if(!c||c.expires<Date.now())return json({error:"Code expiré. Demandez un nouveau code."},400);
if(c.tries>=5)return json({error:"Trop d'essais. Demandez un nouveau code."},429);
if(c.code_hash!==await sha(code+":r:"+u.id)){
await db.prepare("UPDATE reset_codes SET tries=tries+1 WHERE user_id=?1").bind(u.id).run();
return json({error:"Code incorrect."},400);
}
uid=u.id;
}

const salt=crypto.getRandomValues(new Uint8Array(16));
await db.prepare("UPDATE users SET salt=?1,hash=?2 WHERE id=?3").bind(b64(salt),await hash(p,salt),uid).run();
await db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(uid).run();
await db.prepare("DELETE FROM resets WHERE user_id=?1").bind(uid).run();
await db.prepare("DELETE FROM reset_codes WHERE user_id=?1").bind(uid).run();
await db.prepare("DELETE FROM unverified WHERE user_id=?1").bind(uid).run();

const nu=await db.prepare("SELECT username FROM users WHERE id=?1").bind(uid).first();
await notify(env,"✅ Mot de passe modifié par @"+(nu?.username||"?"));
return json({message:"Mot de passe modifié. Vous pouvez vous connecter."});
}

if(path==="admin/reset-link"&&post){
const a=await sessionUser(req,db);
if(!a||a.role!=="admin")return json({error:"Accès refusé."},403);

const email=String(b.email||"").trim().toLowerCase(),
u=await db.prepare("SELECT id FROM users WHERE email=?1").bind(email).first();
if(!u)return json({error:"Aucun compte avec cet e-mail."},404);

const t=crypto.randomUUID()+crypto.randomUUID();
await db.prepare("INSERT INTO resets VALUES(?1,?2,?3)").bind(await sha(t),u.id,Date.now()+36e5).run();
return json({link:url.origin+"/#reinitialiser/"+t});
}

if(path==="ai"||path==="ai/chats"||path==="ai/chat"||path==="ai/delete"){
const u=await sessionUser(req,db);
if(!u)return json({error:"Connexion requise pour utiliser l'assistant."},401);

const own=async id=>await db.prepare("SELECT id FROM ai_chats WHERE id=?1 AND user_id=?2").bind(id,u.id).first();

if(path==="ai/chats")return json({chats:(await db.prepare("SELECT id,title,updated FROM ai_chats WHERE user_id=?1 ORDER BY updated DESC LIMIT 50").bind(u.id).all()).results});

if(path==="ai/chat"){
const id=Number(url.searchParams.get("id"));
if(!await own(id))return json({error:"Conversation introuvable."},404);
return json({messages:(await db.prepare("SELECT role,content FROM ai_msgs WHERE chat_id=?1 ORDER BY id").bind(id).all()).results});
}

if(!post)return json({error:"Introuvable."},404);

if(path==="ai/delete"){
const id=Number(b.id);
if(await own(id)){
await db.prepare("DELETE FROM ai_msgs WHERE chat_id=?1").bind(id).run();
await db.prepare("DELETE FROM ai_chats WHERE id=?1").bind(id).run();
}
return json({ok:true});
}

if(!env.AI)return json({error:"L'assistant IA n'est pas encore activé sur ce site."},503);

const q=String(b.message??"").trim().slice(0,1500);
if(!q)return json({error:"Écrivez votre question."},400);

let cid=Number(b.chatId)||null,hist=[];

if(cid){
if(!await own(cid))return json({error:"Conversation introuvable."},404);
if((await db.prepare("SELECT COUNT(*) n FROM ai_msgs WHERE chat_id=?1").bind(cid).first()).n>=100)return json({error:"Cette conversation est trop longue. Commencez une nouvelle conversation."},400);
hist=(await db.prepare("SELECT role,content FROM (SELECT id,role,content FROM ai_msgs WHERE chat_id=?1 ORDER BY id DESC LIMIT 10) ORDER BY id").bind(cid).all()).results;
}

if(await limited(db,"ai:"+u.id,30,864e5))return json({error:"Limite atteinte : 30 questions par jour. Revenez demain."},429);

for(const mo of env.AI_MODEL?[env.AI_MODEL]:(aiOk?[aiOk,...AI_MODELS]:AI_MODELS)){
try{
const r=await env.AI.run(mo,{messages:[{role:"system",content:SYS},...hist,{role:"user",content:q}],max_tokens:700});
const t=String(r?.response??r?.result?.response??"").trim();

if(t){
aiOk=mo;
const now=new Date().toISOString();

if(!cid)cid=(await db.prepare("INSERT INTO ai_chats(user_id,title,created,updated) VALUES(?1,?2,?3,?3)").bind(u.id,q.slice(0,60),now).run()).meta.last_row_id;
else await db.prepare("UPDATE ai_chats SET updated=?1 WHERE id=?2").bind(now,cid).run();

await db.prepare("INSERT INTO ai_msgs(chat_id,role,content,created) VALUES(?1,'user',?2,?3)").bind(cid,q,now).run();
await db.prepare("INSERT INTO ai_msgs(chat_id,role,content,created) VALUES(?1,'assistant',?2,?3)").bind(cid,t,now).run();

return json({reply:t,chatId:cid});
}
}catch{}
}

return json({error:"L'assistant est momentanément indisponible. Réessayez dans quelques minutes."},503);
}

if(path==="affiliate/me"||path==="affiliate/apply"){
const u=await sessionUser(req,db);
if(!u)return json({error:"Connexion requise."},401);

const get=async()=>{
const a=await db.prepare("SELECT code,status,commission FROM affiliates WHERE user_id=?1").bind(u.id).first();
if(!a)return null;
a.referrals=(await db.prepare("SELECT COUNT(*) n FROM referrals WHERE code=?1").bind(a.code).first()).n;
return a;
};

if(path==="affiliate/apply"&&post&&!await get()){
for(let i=0;i<5;i++){
const code="NEF-"+Array.from(crypto.getRandomValues(new Uint8Array(6)),x=>"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x%32]).join("");
try{
await db.prepare("INSERT INTO affiliates(user_id,code,status,created) VALUES(?1,?2,'pending',?3)").bind(u.id,code,new Date().toISOString()).run();
break;
}catch{}
}
}
return json({affiliate:await get()});
}

if(path==="admin/affiliates"||path==="admin/affiliate"){
const a=await sessionUser(req,db);
if(!a||a.role!=="admin")return json({error:"Accès refusé."},403);

if(path==="admin/affiliate"&&post){
const st=["approved","rejected","pending"].includes(b.status)?b.status:null,
com=b.commission===null||b.commission===undefined||b.commission===""?null:Number(b.commission);

if(!st||!/^NEF-[A-Z0-9]{6}$/.test(String(b.code))||(com!==null&&!(com>=0&&com<=100)))return json({error:"Données invalides."},400);
await db.prepare("UPDATE affiliates SET status=?1,commission=?2 WHERE code=?3").bind(st,com,String(b.code)).run();
return json({ok:true});
}

return json({affiliates:(await db.prepare("SELECT a.code,a.status,a.commission,u.name,u.username,u.email,(SELECT COUNT(*) FROM referrals r WHERE r.code=a.code) AS referrals FROM affiliates a JOIN users u ON u.id=a.user_id ORDER BY a.created DESC LIMIT 200").all()).results});
}

if(path==="admin/users"){
const u=await sessionUser(req,db);
if(!u)return json({error:"Connexion requise."},401);
if(u.role!=="admin")return json({error:"Accès refusé."},403);
return json({users:(await db.prepare("SELECT name,username,email,country,role,created FROM users ORDER BY id DESC LIMIT 200").all()).results});
}

return json({error:"Introuvable."},404);
}

export default{
async fetch(req,env){
const u=new URL(req.url);
if(u.pathname.startsWith("/api/")){
try{
return await handle(req,env,u.pathname.slice(5).replace(/\/$/,""));
}catch(e){
console.error("API ERROR:",String(e));
return json({error:"Erreur du serveur : vérifiez que toutes les tables de la base de données sont créées (bloc SQL dans la console D1)."},500);
}
}
return env.ASSETS.fetch(req);
}
};
