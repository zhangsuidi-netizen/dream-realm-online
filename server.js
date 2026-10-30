'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readDb, writeDb, mutateDb, DB_PATH } = require('./lib/store');
const { makePassword, verifyPassword, newToken, tokenHash, id } = require('./lib/security');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_DAYS = 30;
const DAILY_CHIPS = 50000;
const REFILL_CHIPS = 1000000000; // 1 miliar chip virtual per klaim, gratis dan dapat diulang
const MAX_CHIPS = Number.MAX_SAFE_INTEGER;
const MAX_BET = Number.MAX_SAFE_INTEGER;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STARTING_CHIPS = 100000;
const SYMBOLS = [
  { id: 'crown', weight: 4, pay: { 3: 3, 4: 9, 5: 30 } },
  { id: 'gem', weight: 8, pay: { 3: 2.5, 4: 7, 5: 22 } },
  { id: 'bolt', weight: 10, pay: { 3: 2, 4: 5, 5: 16 } },
  { id: 'orb', weight: 13, pay: { 3: 1.7, 4: 4, 5: 12 } },
  { id: 'clover', weight: 17, pay: { 3: 1.4, 4: 3.2, 5: 9 } },
  { id: 'moon', weight: 21, pay: { 3: 1.2, 4: 2.8, 5: 7 } },
  { id: 'bell', weight: 27, pay: { 3: 1, 4: 2.2, 5: 5 } }
];
const symbolWeights = SYMBOLS.reduce((n, s) => n + s.weight, 0);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.png':'image/png' };
const rateBuckets = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  res.end(body);
}
function publicUser(user) {
  return { id:user.id, username:user.username, role:user.role, chips:user.chips, createdAt:user.createdAt, dailyClaimAt:user.dailyClaimAt || null, refillAt:user.refillAt || null, spins:user.spins || 0, wins:user.wins || 0 };
}
function rateLimit(req, res, bucketName, max, windowMs) {
  const key = `${req.socket.remoteAddress || 'unknown'}:${bucketName}`;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.until) b = { count:0, until:now + windowMs };
  b.count += 1; rateBuckets.set(key, b);
  if (b.count > max) { json(res, 429, { error:'Terlalu banyak percobaan. Coba lagi beberapa saat.' }); return false; }
  return true;
}
async function readBody(req) {
  let raw = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw Object.assign(new Error('Permintaan terlalu besar.'), { status:413 });
    raw += chunk;
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Format JSON tidak valid.'), { status:400 }); }
}
function getToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function auth(req) {
  const token = getToken(req);
  if (!token) return null;
  const hash = tokenHash(token);
  const db = readDb();
  const session = db.sessions.find(s => s.tokenHash === hash && s.expiresAt > Date.now());
  if (!session) return null;
  const user = db.users.find(u => u.id === session.userId);
  return user || null;
}
function requireUser(req, res) {
  const user = auth(req);
  if (!user) { json(res, 401, { error:'Sesi berakhir. Silakan masuk kembali.' }); return null; }
  return user;
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { json(res, 403, { error:'Akses admin diperlukan.' }); return null; }
  return user;
}
function issueSession(userId) {
  const token = newToken();
  mutateDb(db => {
    db.sessions = db.sessions.filter(s => s.expiresAt > Date.now());
    db.sessions.push({ tokenHash:tokenHash(token), userId, expiresAt:Date.now() + SESSION_DAYS*24*60*60*1000 });
  });
  return token;
}
function weightedSymbol() {
  let n = crypto.randomInt(symbolWeights);
  for (const s of SYMBOLS) { n -= s.weight; if (n < 0) return s.id; }
  return 'bell';
}
function evaluateGrid(grid, bet, maxPayout = Number.MAX_SAFE_INTEGER) {
  const wins = [];
  let payout = 0;
  for (let row = 0; row < 3; row++) {
    const first = grid[row][0];
    let count = 1;
    for (let col = 1; col < 5; col++) {
      if (grid[row][col] === first) count++; else break;
    }
    if (count >= 3) {
      const symbol = SYMBOLS.find(s => s.id === first);
      const multiplier = symbol.pay[count] || 0;
      const room = Math.max(0, maxPayout - payout);
      const amount = bet > room / multiplier ? room : Math.floor(bet * multiplier);
      wins.push({ row, symbol:first, count, multiplier, amount });
      payout += amount;
    }
  }
  return { wins, payout };
}
function safeText(v, max=32) { return typeof v === 'string' ? v.trim().slice(0,max) : ''; }

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/health') { readDb(); return json(res, 200, { ok:true, service:'Dream Realm Game Server', time:new Date().toISOString(), database:true }); }

  if (route === 'POST /api/auth/register') {
    if (!rateLimit(req,res,'register',8,60*60*1000)) return;
    const body = await readBody(req); const username = safeText(body.username,20); const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json(res,400,{error:'Username 3–20 karakter, hanya huruf, angka, dan garis bawah.'});
    if (password.length < 8 || password.length > 72) return json(res,400,{error:'Password harus 8–72 karakter.'});
    const db = readDb(); if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return json(res,409,{error:'Username sudah digunakan.'});
    const creds = makePassword(password); const user = { id:id(), username, ...creds, role:'player', chips:STARTING_CHIPS, createdAt:Date.now(), dailyClaimAt:0, refillAt:0, spins:0, wins:0 };
    db.users.push(user); writeDb(db); const token = issueSession(user.id);
    return json(res,201,{token,user:publicUser(user),message:`Akun dibuat. ${STARTING_CHIPS.toLocaleString('id-ID')} chip gratis sudah masuk.`});
  }
  if (route === 'POST /api/auth/login') {
    if (!rateLimit(req,res,'login',20,15*60*1000)) return;
    const body = await readBody(req); const username = safeText(body.username,20); const password = typeof body.password === 'string' ? body.password : '';
    const db = readDb(); const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password,user.salt,user.passwordHash)) return json(res,401,{error:'Username atau password tidak cocok.'});
    const token = issueSession(user.id); return json(res,200,{token,user:publicUser(user),message:'Berhasil masuk.'});
  }
  if (route === 'POST /api/auth/logout') {
    const token = getToken(req); if (token) mutateDb(db => { const h=tokenHash(token); db.sessions=db.sessions.filter(s=>s.tokenHash!==h); });
    return json(res,200,{ok:true});
  }
  if (route === 'GET /api/me') {
    const user=requireUser(req,res); if(!user)return; const db=readDb();
    return json(res,200,{user:publicUser(user),notice:db.meta.notice,free:{dailyReady:Date.now()-(user.dailyClaimAt||0)>=DAILY_COOLDOWN_MS,refillReady:user.chips<MAX_CHIPS,dailyChips:DAILY_CHIPS,refillChips:REFILL_CHIPS,maxChips:MAX_CHIPS}});
  }
  if (route === 'POST /api/chips/daily') {
    const user=requireUser(req,res); if(!user)return;
    const out=mutateDb(db=>{const u=db.users.find(x=>x.id===user.id); const now=Date.now(); if(now-(u.dailyClaimAt||0)<DAILY_COOLDOWN_MS)return {error:'Bonus harian sudah diklaim. Coba lagi besok.',status:409,readyAt:u.dailyClaimAt+DAILY_COOLDOWN_MS}; u.dailyClaimAt=now; u.chips+=DAILY_CHIPS; return {user:publicUser(u),amount:DAILY_CHIPS};});
    if(out.error)return json(res,out.status,{error:out.error,readyAt:out.readyAt}); return json(res,200,{...out,message:'Bonus harian berhasil diklaim.'});
  }
  if (route === 'POST /api/chips/refill') {
    const user=requireUser(req,res); if(!user)return;
    if (!rateLimit(req,res,'refill',30,60*1000)) return;
    const out=mutateDb(db=>{const u=db.users.find(x=>x.id===user.id); const amount=Math.min(REFILL_CHIPS,MAX_CHIPS-u.chips); if(amount<=0)return {error:'Saldo chip sudah mencapai batas aman angka.',status:409}; u.chips+=amount; u.refillAt=Date.now(); return {user:publicUser(u),amount};});
    if(out.error)return json(res,out.status,{error:out.error}); return json(res,200,{...out,message:`${out.amount.toLocaleString('id-ID')} chip virtual gratis berhasil ditambahkan. Kamu bisa isi lagi kapan saja.`});
  }
  if (route === 'GET /api/leaderboard') {
    const db=readDb(); const players=db.users.filter(u=>u.role==='player').sort((a,b)=>(b.wins||0)-(a.wins||0)).slice(0,20).map((u,i)=>({rank:i+1,username:u.username,wins:u.wins||0,spins:u.spins||0}));
    return json(res,200,{players});
  }
  if (route === 'POST /api/game/spin') {
    if (!rateLimit(req,res,'spin',90,60*1000)) return;
    const user=requireUser(req,res); if(!user)return; const body=await readBody(req); const bet=Number(body.bet);
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > MAX_BET) return json(res,400,{error:'Bet harus berupa angka chip positif yang masih aman dihitung.'});
    const out=mutateDb(db=>{const u=db.users.find(x=>x.id===user.id); if(u.chips<bet)return {error:'Chip tidak cukup. Tekan ISI CHIP GRATIS atau gunakan MAX BET.',status:409}; u.chips-=bet; const grid=Array.from({length:3},()=>Array.from({length:5},weightedSymbol)); const result=evaluateGrid(grid,bet,MAX_CHIPS-u.chips); u.chips+=result.payout; u.spins=(u.spins||0)+1; if(result.payout>bet)u.wins=(u.wins||0)+1; const record={id:id(),userId:u.id,username:u.username,bet,payout:result.payout,createdAt:Date.now(),wins:result.wins}; db.history.unshift(record); db.history=db.history.slice(0,500); return {grid,...result,user:publicUser(u),bet};});
    if(out.error)return json(res,out.status,{error:out.error}); return json(res,200,out);
  }
  if (route === 'GET /api/admin/users') {
    const admin=requireAdmin(req,res);if(!admin)return; const db=readDb(); const users=db.users.map(publicUser).sort((a,b)=>b.createdAt-a.createdAt);
    return json(res,200,{users,notice:db.meta.notice});
  }
  if (route === 'POST /api/admin/grant') {
    const admin=requireAdmin(req,res);if(!admin)return; const body=await readBody(req); const username=safeText(body.username,20); const amount=Number(body.amount);
    if(!Number.isSafeInteger(amount)||amount<1||amount>MAX_CHIPS)return json(res,400,{error:'Jumlah chip harus berupa bilangan bulat positif yang aman.'});
    const out=mutateDb(db=>{const u=db.users.find(x=>x.username.toLowerCase()===username.toLowerCase());if(!u)return null;u.chips=Math.min(MAX_CHIPS,u.chips+amount);return publicUser(u);});
    if(!out)return json(res,404,{error:'Pemain tidak ditemukan.'});return json(res,200,{user:out,message:`${amount.toLocaleString('id-ID')} chip diberikan kepada ${out.username}.`});
  }
  if (route === 'POST /api/admin/notice') {
    const admin=requireAdmin(req,res);if(!admin)return;const body=await readBody(req);const notice=safeText(body.notice,180);
    mutateDb(db=>{db.meta.notice=notice;});return json(res,200,{notice,message:'Pengumuman diperbarui.'});
  }
  return json(res,404,{error:'Endpoint tidak ditemukan.'});
}

function serveStatic(req,res,url) {
  let pathname=decodeURIComponent(url.pathname);
  if(pathname==='/'||pathname==='/index.html')pathname='/index.html';
  if(pathname==='/admin')pathname='/admin.html';
  const root=path.join(__dirname,'public'); const file=path.resolve(root,`.${pathname}`);
  if(!file.startsWith(root+path.sep) && file!==path.join(root,'index.html')){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('File tidak ditemukan.');}
    const ext=path.extname(file);res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'});res.end(data);
  });
}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){await api(req,res,url);return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end('Method not allowed');}
    serveStatic(req,res,url);
  }catch(err){console.error(err);if(!res.headersSent)json(res,err.status||500,{error:err.status?err.message:'Terjadi kesalahan server.'});else res.end();}
});
server.listen(PORT,HOST,()=>console.log(`Dream Realm server berjalan di http://${HOST}:${PORT} | DB: ${DB_PATH}`));
